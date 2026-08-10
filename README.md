# TaskForge

**A resilient background job queue engine for Node.js — built entirely on the standard library.**

Priority scheduling · exponential backoff with jitter · crash-safe persistence via a write-ahead log · real OS-level parallelism with `worker_threads` · a token-bucket rate limiter · a live dashboard. **Zero runtime dependencies.**

[![CI](https://github.com/<your-username>/taskforge/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-username>/taskforge/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D18.3-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success)

---

## Why this exists

Every backend system eventually needs to run work outside the request/response cycle — send an email, resize an upload, call a flaky third-party API, generate a report. In production this almost always means reaching for a job queue library (Sidekiq, BullMQ, Celery...) and trusting it to handle retries, crashes, and backpressure correctly.

TaskForge is what's underneath that trust. Instead of wrapping one of those libraries, this is a job queue engine built from first principles on nothing but Node's standard library, so every guarantee it makes is one I implemented and can explain:

- *"What happens if the process dies mid-job?"* → it's requeued, because the write-ahead log recorded that it started before it ran.
- *"What stops a CPU-heavy job from freezing everything else?"* → nothing shares a thread with it; each job runs in an isolated `worker_thread`.
- *"What stops 200 failed jobs from retrying at the exact same instant and hammering a struggling API?"* → jittered exponential backoff.
- *"What happens to a job that fails forever?"* → it lands in a dead-letter queue instead of disappearing or retrying infinitely.

## What it does

- **Priority scheduling** — a binary heap orders ready jobs by priority, then by age.
- **Delayed & scheduled jobs** — run a job now, or `delayMs` from now.
- **Automatic retries** — exponential backoff with jitter, configurable per queue.
- **Dead-letter queue** — jobs that exhaust their attempts are quarantined, inspectable, and redrivable — from the CLI or the dashboard.
- **True parallelism** — jobs execute in a pool of `worker_threads`, not just concurrently on one thread. A crashing worker is replaced automatically, exactly once per crash, without losing pool capacity.
- **Crash-safe persistence** — a write-ahead log + snapshot compaction means a `kill -9` mid-run loses nothing (a truncated final log line from a crash mid-write is tolerated, not fatal); restart and the queue picks up where it left off.
- **Rate limiting** — an optional token bucket caps how fast a queue dispatches jobs, for protecting a downstream API with its own limits.
- **Live dashboard** — a dark, dependency-free web UI showing the job pipeline, throughput, p50/p95/p99 latency, a live job manifest, and a dead-letter "scrap bin" with one-click redrive.
- **Deduplication** — an optional `dedupeKey` makes `add()` a no-op if a job with that key was ever seen.
- **Bounded memory** — completed job history older than a configurable retention window is pruned during compaction, so a long-running process doesn't accumulate every job it's ever processed forever.

## Quick start

```bash
git clone <this-repo>
cd taskforge
npm start
```

Open **http://localhost:4000** — the dashboard starts pre-wired with three simulated job types (a welcome email, an image resize, a flaky API call) and a steady trickle of synthetic traffic, so there's something to look at immediately. No `npm install` step: there are no runtime dependencies.

Other things to try:

```bash
npm test                    # 18 tests, node's built-in test runner, no test framework dependency
npm run example:basic       # minimal library usage
npm run example:cpu         # why worker_threads matter: 20 CPU-bound jobs, main thread never blocks
npm run example:retries     # retries + backoff + rate limiting + a dead-letter queue, from the terminal

npm run cli stats           # while the dashboard is running, in another terminal
npm run cli jobs --status dead
npm run cli dlq:redrive <jobId>
```

### See the crash recovery for yourself

This is the best way to see what the write-ahead log is actually for:

```bash
npm start                      # let it run for ~5 seconds so a few jobs complete
# in another terminal:
kill -9 $(lsof -ti:4000)       # simulate a hard crash — no graceful shutdown
npm start                      # restart
```

The restart logs `[wal] restored N job(s) from disk (M log entries replayed)`, and `GET /api/stats` shows the same completed-job count it had before the crash — nothing was lost.

## Architecture

```
┌──────────────┐   add()    ┌─────────────────┐   dispatch()   ┌──────────────┐
│   Your code   │ ─────────▶│      Queue       │ ──────────────▶│  WorkerPool   │
│ (or the demo  │            │  (orchestrator)  │                │ (worker_thr.) │
│  HTTP server) │◀───────────│                  │◀───────────────│               │
└──────────────┘   events   └───────┬──────────┘   jobFinished  └──────┬───────┘
                                     │                                  │
                          ┌──────────┼──────────┐                      │
                          ▼          ▼           ▼                     ▼
                   PriorityHeap  delayed[]  WriteAheadLog      workerRunner.js
                   (ready jobs) (scheduled/  (crash recovery)   dynamically imports
                                 retrying)                      your handler module
                                     │
                                     ▼
                              RetryPolicy (backoff)
                              TokenBucket (rate limit)
                              Metrics (p50/p95/p99, throughput)
```

`Queue#tick()`, on a plain `setInterval`, is the *only* code path that dispatches a job: promote any delayed job whose time has come into the ready heap, then hand ready jobs to idle workers (respecting the rate limiter, if configured). Every other state change — a job completing, failing, retrying, dying — arrives asynchronously as a message from a worker thread and is handled by one function, `#onJobFinished`. Centralizing dispatch and completion each into a single path is what makes the concurrency tractable to reason about, even though jobs genuinely finish out of order, from different OS threads.

### Project structure

```
src/
  core/
    Job.js              job state machine (waiting → active → completed | dead)
    PriorityHeap.js      binary heap backing the ready queue
    RetryPolicy.js        exponential backoff with jitter
    RateLimiter.js         token bucket
    Metrics.js               rolling p50/p95/p99 + throughput
    WriteAheadLog.js          append-only log + snapshot compaction
    DeadLetterQueue.js         inspect/redrive permanently-failed jobs
    WorkerPool.js                self-healing pool of worker_threads
    Queue.js                       ties it all together
  workers/
    workerRunner.js       lives inside each worker thread; imports handlers by path
  dashboard/
    server.js             REST API + static file server (node:http, no framework)
    public/                vanilla HTML/CSS/canvas dashboard, no build step
  cli.js                 REST client for the running server
  index.js               public library entrypoint
examples/                runnable, narrated usage demos
test/                    node:test suite (unit + real end-to-end with real threads)
```

## Design decisions & trade-offs

Documenting these honestly is more useful than pretending the design has no edges:

- **Handlers are files, not functions.** A worker thread can't receive a JS closure from the main thread — only structured-cloneable data crosses that boundary. So `queue.process('name', './handler.js')` takes a *path*, dynamically imported inside the worker. This is exactly the constraint real systems like Sidekiq and Celery live with, and it's what actually buys the isolation: a handler that hangs, leaks, or throws synchronously can only take down its own worker thread.
- **Every WAL append is a synchronous `fs.appendFileSync`, not a buffered stream.** An earlier version used a long-lived `fs.createWriteStream`, which is faster but opened a real hazard: a buffered write still in flight when `compact()` truncates the same file through a separate file descriptor is a genuine race. Synchronous per-line appends make that impossible — at a throughput cost that doesn't matter at this scale. It's still not a full `fsync`-per-write guarantee (the OS may briefly hold a write in its page cache before it reaches physical disk); a system with stronger durability requirements would close that gap with an explicit `fsync`/`fdatasync`. This project's 400-job / 240-compaction-cycle stress test shows zero corruption or loss under the current approach.
- **A worker crash is handled exactly once, even though Node reports it twice.** An uncaught exception inside a worker thread fires *both* `'error'` and `'exit'` on the parent `Worker` object for the same crash (verified directly, not assumed) — without a guard, that double-requeues the in-flight job and leaks an orphaned replacement worker. `WorkerPool` tracks a per-worker `crashHandled` flag so only the first of the two events does anything.
- **The WAL assumes a single writer per queue name.** Two processes cannot safely append to the same queue's log concurrently. That's why the CLI talks to the running server over HTTP instead of opening the WAL files directly.
- **Delayed jobs are a plain array, scanned every tick.** At the volume a project like this actually runs, O(n) per 100ms tick is invisible. A second min-heap keyed by `processAt` would be the fix if that stopped being true.
- **Percentiles are computed by sorting the rolling window on read**, not with a streaming structure like a t-digest. Simple, correct, and fast enough at dashboard-poll rates; a real high-throughput system would reach for a proper histogram.
- **Completed-job retention prunes its own dedupe keys, but only its own.** Pruning a stale completed job also frees its `dedupeKey`, which keeps that specific leak in check — but a `dedupeKey` attached to a job that's still waiting, active, delayed, or dead outlives the job itself with no TTL of its own. Documented, not hidden, under "Known limitations".
- **No distributed mode.** Everything here — the queue, the workers, the WAL — lives in one process. A Redis- or Postgres-backed queue lets multiple machines share one queue; TaskForge deliberately doesn't solve that problem, because solving *this* one (durability, retries, isolation, backpressure, on a single node) is what the project is about.

## Using it as a library

```js
import { Queue } from './src/index.js';

const queue = new Queue('emails', { concurrency: 4 });
queue.process('welcome-email', './handlers/sendWelcomeEmail.js');

queue.on('job:completed', (job) => console.log('done:', job.id));
queue.on('job:retrying', (job) => console.log('retrying:', job.id, 'in', job.nextDelayMs, 'ms'));
queue.on('job:dead', (job) => console.log('gave up:', job.id, job.error));

queue.add('welcome-email', { to: 'ada@example.com' }, {
  priority: 5,       // higher runs first
  delayMs: 0,        // or schedule for later
  maxAttempts: 3,
  dedupeKey: null,   // set to avoid double-enqueuing the same logical job
});
```

A handler module (loaded inside a worker thread) is just:

```js
// handlers/sendWelcomeEmail.js
export default async function sendWelcomeEmail(payload, job) {
  // ... do the work ...
  return { sentTo: payload.to };
}
```

## Known limitations

- Single-process, single-writer-per-queue-name — see trade-offs above.
- The dashboard has no authentication; it's a local development tool, not something to expose publicly as-is.
- `dedupeKey`s for jobs still waiting, active, delayed, or dead are never evicted from memory — only a completed job's key is freed, and only once that job ages past the retention window. A process that runs indefinitely while adding unique dedupe keys for jobs that never complete will still grow that index unboundedly; a full fix would give each key its own TTL independent of job history.

## License

MIT — see [LICENSE](./LICENSE).
