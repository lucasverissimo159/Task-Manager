import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '..', 'workers', 'workerRunner.js');

/**
 * Owns a fixed-size pool of worker threads and hands jobs to whichever one
 * is idle. Two things make this more than "a for loop that spawns Workers":
 *
 *  1. Crash resilience — if a worker throws an uncaught exception or exits
 *     unexpectedly mid-job, the pool doesn't just lose that capacity. It
 *     reports the job as failed (so the Queue can retry it) *and* spawns a
 *     replacement worker in the same slot, so total concurrency is
 *     self-healing rather than slowly degrading over time.
 *  2. Graceful shutdown — `close()` waits for in-flight jobs to finish (up
 *     to a timeout) before terminating threads, instead of killing workers
 *     mid-task and silently dropping their results.
 */
export class WorkerPool extends EventEmitter {
  constructor({ size = 4 } = {}) {
    super();
    this.size = size;
    this.workers = [];
    for (let i = 0; i < size; i++) this.#spawn(i);
  }

  #spawn(slotIndex) {
    const worker = new Worker(RUNNER_PATH);
    const slot = { worker, busy: false, jobId: null, slotIndex, crashHandled: false };

    worker.on('message', (msg) => this.#handleMessage(slot, msg));
    worker.on('error', (err) => this.#handleCrash(slot, err));
    worker.on('exit', (code) => {
      if (code !== 0 && slot.busy) this.#handleCrash(slot, new Error(`worker exited with code ${code}`));
    });

    this.workers[slotIndex] = slot;
    return slot;
  }

  #handleMessage(slot, msg) {
    if (msg.type !== 'result') return;
    slot.busy = false;
    slot.jobId = null;
    this.emit('jobFinished', msg);
    this.emit('idle');
  }

  #handleCrash(slot, err) {
    // A worker that throws an uncaught exception fires BOTH 'error' and
    // 'exit' for the same crash (confirmed empirically, not assumed) — so
    // without this guard, a single crash would requeue the in-flight job
    // twice and leak an orphaned replacement worker (the second #spawn()
    // call overwrites this.workers[slotIndex] before the first replacement
    // ever does any work). Each slot object is scoped to one worker's
    // lifetime, so this flag naturally resets when #spawn creates the next one.
    if (slot.crashHandled) return;
    slot.crashHandled = true;

    const jobId = slot.jobId;
    slot.worker.terminate().catch(() => {});
    this.#spawn(slot.slotIndex); // maintain pool capacity
    if (jobId) {
      this.emit('jobFinished', {
        type: 'result',
        jobId,
        ok: false,
        error: { message: `worker crashed: ${err.message}` },
        durationMs: 0,
      });
    }
    this.emit('idle');
  }

  get idleSlot() {
    return this.workers.find((s) => !s.busy) ?? null;
  }

  get busyCount() {
    return this.workers.filter((s) => s.busy).length;
  }

  /** Returns false if no worker was idle (caller should keep the job queued). */
  dispatch(job, handlerPath) {
    const slot = this.idleSlot;
    if (!slot) return false;
    slot.busy = true;
    slot.jobId = job.id;
    slot.worker.postMessage({ type: 'run', job: job.toJSON(), handlerPath });
    return true;
  }

  async close({ timeoutMs = 5000 } = {}) {
    const start = Date.now();
    while (this.busyCount > 0 && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await Promise.all(this.workers.map((s) => s.worker.terminate()));
  }
}
