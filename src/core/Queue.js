import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Job, JobStatus } from './Job.js';
import { PriorityHeap } from './PriorityHeap.js';
import { WorkerPool } from './WorkerPool.js';
import { RetryPolicy } from './RetryPolicy.js';
import { TokenBucket } from './RateLimiter.js';
import { WriteAheadLog } from './WriteAheadLog.js';
import { Metrics } from './Metrics.js';
import { DeadLetterQueue } from './DeadLetterQueue.js';

/**
 * Ties every piece together: a priority-ordered ready queue, a delayed set
 * (scheduled jobs + retries-pending-backoff), a worker pool for isolated
 * execution, a write-ahead log for crash recovery, and rolling metrics.
 *
 * The only "scheduler" is `#tick()`, called on a plain interval: promote due
 * delayed jobs, then dispatch as many ready jobs as there are idle workers
 * (and rate-limit tokens) for. No other code path dispatches a job — which
 * makes concurrency easy to reason about even though jobs finish
 * asynchronously, out of order, from different threads.
 */
export class Queue extends EventEmitter {
  constructor(
    name,
    {
      concurrency = 4,
      dataDir = path.join(process.cwd(), 'data'),
      retryPolicy = new RetryPolicy(),
      rateLimit = null, // { capacity, refillPerSecond }
      tickIntervalMs = 100,
      compactEvery = 200,
      jobRetentionMs = 60 * 60 * 1000, // how long a completed job's record is kept before compaction prunes it
    } = {},
  ) {
    super();
    this.name = name;
    this.jobs = new Map(); // id -> Job (every job this queue knows about, any status)
    this.handlers = new Map(); // job name -> absolute handler module path

    this.ready = new PriorityHeap((a, b) =>
      a.priority !== b.priority ? a.priority > b.priority : a.processAt < b.processAt,
    );
    this.delayed = []; // scanned each tick; fine at portfolio scale (see README limitations)

    this.pool = new WorkerPool({ size: concurrency });
    this.retryPolicy = retryPolicy;
    this.rateLimiter = rateLimit ? new TokenBucket(rateLimit) : null;
    this.wal = new WriteAheadLog({ dir: dataDir, name });
    this.metrics = new Metrics();
    this.dlq = new DeadLetterQueue(this);

    this._dedupeIndex = new Set();
    this._compactEvery = compactEvery;
    this.jobRetentionMs = jobRetentionMs;

    this.#recover();

    this.pool.on('jobFinished', (msg) => this.#onJobFinished(msg));
    this._timer = setInterval(() => this.#tick(), tickIntervalMs);
    this._timer.unref?.();
  }

  /** Registers the handler module for a job name. Must be called before matching jobs are dispatched. */
  process(jobName, handlerPath) {
    this.handlers.set(jobName, path.resolve(handlerPath));
    return this;
  }

  /**
   * Enqueues a new job.
   * @param {object} [opts.dedupeKey] - if set and a job with the same key was ever added, this call is a no-op.
   */
  add(name, payload, { priority = 0, delayMs = 0, maxAttempts = 3, dedupeKey = null } = {}) {
    if (dedupeKey && this._dedupeIndex.has(dedupeKey)) {
      this.emit('job:deduped', { dedupeKey });
      return null;
    }
    const job = new Job({ name, payload, priority, delayMs, maxAttempts, dedupeKey });
    this.jobs.set(job.id, job);
    if (dedupeKey) this._dedupeIndex.add(dedupeKey);
    this.#persist(job);

    if (job.status === JobStatus.DELAYED) this.delayed.push(job);
    else this.ready.push(job);

    this.emit('job:added', job.toJSON());
    return job.id;
  }

  /** Used by the DLQ to put a previously-dead job back into circulation. */
  _enqueueExisting(job) {
    job.transition(JobStatus.WAITING);
    this.#persist(job);
    this.ready.push(job);
  }

  #tick() {
    const now = Date.now();

    if (this.delayed.length) {
      const stillDelayed = [];
      for (const job of this.delayed) {
        if (job.processAt <= now) {
          job.transition(JobStatus.WAITING);
          this.#persist(job);
          this.ready.push(job);
        } else {
          stillDelayed.push(job);
        }
      }
      this.delayed = stillDelayed;
    }

    while (!this.ready.isEmpty() && this.pool.idleSlot) {
      if (this.rateLimiter && !this.rateLimiter.tryTake(1)) break;

      const job = this.ready.pop();
      const handlerPath = this.handlers.get(job.name);
      if (!handlerPath) {
        job.transition(JobStatus.DEAD, { finishedAt: Date.now(), error: `No handler registered for "${job.name}"` });
        this.#persist(job);
        this.emit('job:dead', job.toJSON());
        continue;
      }

      job.attempts++;
      job.transition(JobStatus.ACTIVE, { startedAt: Date.now() });
      this.#persist(job);

      const dispatched = this.pool.dispatch(job, handlerPath);
      if (!dispatched) {
        // Invariant guard, not a live code path today: `pool.idleSlot` was
        // just checked in the while-condition above, and nothing async runs
        // between that check and this dispatch() call in Node's
        // single-threaded event loop, so `dispatch()` re-finding no idle
        // slot can't currently happen. Kept as a safety net rather than an
        // assumption, in case this method's synchronous chain ever changes.
        job.transition(JobStatus.WAITING, { startedAt: null });
        this.ready.push(job);
        break;
      }
    }
  }

  #onJobFinished({ jobId, ok, result, error, durationMs }) {
    const job = this.jobs.get(jobId);
    if (!job) return; // job was for a queue instance that no longer tracks it (e.g. after a redrive race) — ignore

    this.metrics.recordDuration(durationMs);

    if (ok) {
      job.transition(JobStatus.COMPLETED, { finishedAt: Date.now(), result });
      this.#persist(job);
      this.emit('job:completed', job.toJSON());
      return;
    }

    if (job.attempts < job.maxAttempts) {
      const delay = this.retryPolicy.nextDelay(job.attempts);
      job.transition(JobStatus.DELAYED, {
        processAt: Date.now() + delay,
        error: error?.message ?? String(error),
      });
      this.#persist(job);
      this.delayed.push(job);
      this.emit('job:retrying', { ...job.toJSON(), nextDelayMs: delay });
    } else {
      job.transition(JobStatus.DEAD, {
        finishedAt: Date.now(),
        error: error?.message ?? String(error),
      });
      this.#persist(job);
      this.emit('job:dead', job.toJSON());
    }
  }

  #persist(job) {
    this.wal.append({ type: 'upsert', job: job.toJSON() });
    if (this.wal.pendingEvents >= this._compactEvery) this.#compact();
  }

  #compact() {
    this.#pruneOldCompletedJobs();
    const plain = new Map([...this.jobs].map(([id, job]) => [id, job.toJSON()]));
    this.wal.compact(plain);
  }

  /**
   * Without this, `this.jobs` would grow forever in a long-running process —
   * every job ever completed stays in memory (and in every future snapshot)
   * with nothing to evict it. Only COMPLETED jobs older than
   * `jobRetentionMs` are dropped; DEAD jobs are kept indefinitely since
   * they're exactly the ones an operator still needs to see and possibly
   * redrive. This also incidentally shrinks the dedupe index (see README
   * "Known limitations") for the jobs it prunes, though not for jobs still
   * waiting, active, delayed, or dead — a full fix would need each
   * dedupeKey to carry its own TTL independent of job history.
   */
  #pruneOldCompletedJobs() {
    const cutoff = Date.now() - this.jobRetentionMs;
    for (const [id, job] of this.jobs) {
      if (job.status === JobStatus.COMPLETED && job.finishedAt < cutoff) {
        if (job.dedupeKey) this._dedupeIndex.delete(job.dedupeKey);
        this.jobs.delete(id);
      }
    }
  }

  #recover() {
    const { jobs, replayed, skipped } = this.wal.load();
    for (const raw of jobs.values()) {
      const job = Job.fromJSON(raw);
      this.jobs.set(job.id, job);
      if (job.dedupeKey) this._dedupeIndex.add(job.dedupeKey);

      if (job.status === JobStatus.ACTIVE) {
        // We crashed mid-job and can't know whether it actually finished —
        // treat it as interrupted, not silently lost, and requeue it.
        job.transition(JobStatus.WAITING, { startedAt: null });
        this.ready.push(job);
      } else if (job.status === JobStatus.WAITING) {
        this.ready.push(job);
      } else if (job.status === JobStatus.DELAYED) {
        this.delayed.push(job);
      }
      // COMPLETED and DEAD jobs are restored into `this.jobs` for
      // inspection/history but not re-scheduled.
    }
    if (replayed > 0 || skipped > 0) {
      const jobsRestored = jobs.size;
      // Deferred: this runs inside the constructor, before a caller doing
      // `const q = new Queue(...); q.on('recovered', ...)` has attached its
      // listener. Emitting synchronously here would fire into an empty room.
      queueMicrotask(() => this.emit('recovered', { jobsRestored, walEntriesReplayed: replayed, corruptEntriesSkipped: skipped }));
    }
  }

  /** Live snapshot of queue health — what the dashboard and CLI poll. */
  stats() {
    const counts = { waiting: 0, delayed: 0, active: 0, completed: 0, dead: 0 };
    for (const job of this.jobs.values()) counts[job.status]++;
    return {
      name: this.name,
      counts,
      pending: this.ready.size + this.delayed.length,
      totalJobs: this.jobs.size,
      ...this.metrics.snapshot(),
    };
  }

  listJobs({ status, limit = 50 } = {}) {
    let all = [...this.jobs.values()];
    if (status) all = all.filter((job) => job.status === status);
    return all
      .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
      .slice(0, limit)
      .map((job) => job.toJSON());
  }

  /** Compacts the log, then drains and terminates the worker pool. Always safe to call. */
  async close() {
    clearInterval(this._timer);
    this.#compact();
    await this.wal.close();
    await this.pool.close();
  }
}
