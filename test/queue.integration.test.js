import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from '../src/core/Queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-queue-'));

test('processes a job end-to-end through a real worker thread', async () => {
  const queue = new Queue('integration-echo', { concurrency: 1, dataDir: tmpDataDir() });
  try {
    queue.process('echo', path.join(__dirname, 'fixtures', 'echoHandler.js'));

    const completed = new Promise((resolve) => queue.once('job:completed', resolve));
    queue.add('echo', { value: 42 });
    const job = await completed;

    assert.equal(job.status, 'completed');
    assert.deepEqual(job.result, { value: 42 });
  } finally {
    await queue.close();
  }
});

test('retries a failing job with backoff, then dead-letters it after max attempts', async () => {
  const queue = new Queue('integration-fail', { concurrency: 1, dataDir: tmpDataDir() });
  try {
    queue.process('always-fail', path.join(__dirname, 'fixtures', 'alwaysFailHandler.js'));

    const retryEvents = [];
    queue.on('job:retrying', (j) => retryEvents.push(j));

    const dead = new Promise((resolve) => queue.once('job:dead', resolve));
    queue.add('always-fail', {}, { maxAttempts: 3 });
    const job = await dead;

    assert.equal(job.status, 'dead');
    assert.equal(job.attempts, 3);
    assert.equal(retryEvents.length, 2); // fails on attempt 1 and 2, dies on attempt 3
  } finally {
    await queue.close();
  }
});

test('respects priority: higher-priority jobs run first when workers are scarce', async () => {
  const queue = new Queue('integration-priority', { concurrency: 1, dataDir: tmpDataDir() });
  try {
    queue.process('echo', path.join(__dirname, 'fixtures', 'echoHandler.js'));

    const completionOrder = [];

    // With a single worker, jobs queue up behind the first dispatch; priority
    // decides the order among everything still waiting. Lower priority
    // finishes last, so the expected completion order is high -> medium -> low.
    const allDone = new Promise((resolve) => {
      queue.on('job:completed', (j) => {
        completionOrder.push(j.payload.label);
        if (completionOrder.length === 3) resolve();
      });
    });

    queue.add('echo', { label: 'low' }, { priority: 0 });
    queue.add('echo', { label: 'high' }, { priority: 10 });
    queue.add('echo', { label: 'medium' }, { priority: 5 });

    await allDone;
    assert.deepEqual(completionOrder, ['high', 'medium', 'low']);
  } finally {
    await queue.close();
  }
});

test('redriving a dead-lettered job returns it to circulation', async () => {
  const queue = new Queue('integration-redrive', { concurrency: 1, dataDir: tmpDataDir() });
  try {
    queue.process('always-fail', path.join(__dirname, 'fixtures', 'alwaysFailHandler.js'));
    queue.process('echo', path.join(__dirname, 'fixtures', 'echoHandler.js'));

    const dead = new Promise((resolve) => queue.once('job:dead', resolve));
    const jobId = queue.add('always-fail', {}, { maxAttempts: 1 });
    await dead;

    assert.equal(queue.dlq.list().length, 1);
    const redriven = queue.dlq.redrive(jobId);
    assert.equal(redriven, true);
    assert.equal(queue.jobs.get(jobId).status, 'waiting');
    assert.equal(queue.dlq.list().length, 0);
  } finally {
    await queue.close();
  }
});

test('a genuinely crashed worker thread is reported exactly once, and the pool self-heals', async () => {
  // Regression test: a worker that throws an uncaught exception fires BOTH
  // 'error' and 'exit' for the same crash (verified empirically against
  // Node's worker_threads). Without a guard, WorkerPool used to react to
  // both, double-requeuing the in-flight job and leaking an orphaned
  // replacement worker.
  const queue = new Queue('integration-crash', { concurrency: 2, dataDir: tmpDataDir() });
  try {
    queue.process('crash', path.join(__dirname, 'fixtures', 'crashHandler.js'));
    queue.process('echo', path.join(__dirname, 'fixtures', 'echoHandler.js'));

    const deadEvents = [];
    queue.on('job:dead', (j) => deadEvents.push(j));
    queue.add('crash', {}, { maxAttempts: 1 }); // one crash -> straight to the DLQ

    await new Promise((resolve) => setTimeout(resolve, 400)); // let the crash propagate
    assert.equal(deadEvents.length, 1, 'the crash must be reported exactly once, not twice');

    // The pool must have healed: a fresh job dispatched afterwards still completes normally.
    const completed = new Promise((resolve) => queue.once('job:completed', resolve));
    queue.add('echo', { value: 'still alive' });
    const job = await completed;
    assert.deepEqual(job.result, { value: 'still alive' });
  } finally {
    await queue.close();
  }
});

test('a waiting job can be cancelled before dispatch without losing the queue shape', async () => {
  const queue = new Queue('integration-cancel', { concurrency: 1, dataDir: tmpDataDir() });
  try {
    queue.process('echo', path.join(__dirname, 'fixtures', 'echoHandler.js'));

    const jobId = queue.add('echo', { value: 'cancel-me' });
    assert.equal(queue.cancel(jobId), true);
    assert.equal(queue.jobs.get(jobId).status, 'cancelled');
    assert.equal(queue.listJobs({ status: 'cancelled' }).length, 1);
  } finally {
    await queue.close();
  }
});

test('compaction prunes completed jobs past retention, but keeps recent and dead ones', async () => {
  const queue = new Queue('integration-retention', {
    concurrency: 1,
    dataDir: tmpDataDir(),
    jobRetentionMs: 60_000, // generous window — the old job below is placed well outside it
  });
  try {
    queue.process('echo', path.join(__dirname, 'fixtures', 'echoHandler.js'));
    queue.process('always-fail', path.join(__dirname, 'fixtures', 'alwaysFailHandler.js'));

    const oldCompleted = new Promise((resolve) => queue.once('job:completed', resolve));
    const oldJobId = queue.add('echo', { tag: 'old' });
    await oldCompleted;
    // Backdate it past the retention window, as if it finished an hour ago.
    queue.jobs.get(oldJobId).finishedAt = Date.now() - 10 * 60_000;

    const recentCompleted = new Promise((resolve) => queue.once('job:completed', resolve));
    const recentJobId = queue.add('echo', { tag: 'recent' });
    await recentCompleted;

    const dead = new Promise((resolve) => queue.once('job:dead', resolve));
    const deadJobId = queue.add('always-fail', {}, { maxAttempts: 1 });
    await dead;

    await queue.close(); // close() always compacts

    assert.equal(queue.jobs.has(oldJobId), false, 'a stale completed job should be pruned');
    assert.equal(queue.jobs.has(recentJobId), true, 'a recent completed job should be kept');
    assert.equal(queue.jobs.has(deadJobId), true, 'dead-lettered jobs are kept regardless of age');
  } finally {
    // already closed above
  }
});
