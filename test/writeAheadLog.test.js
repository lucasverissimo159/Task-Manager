import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WriteAheadLog } from '../src/core/WriteAheadLog.js';

test('replays appended events after a simulated crash and restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-wal-'));

  let wal = new WriteAheadLog({ dir, name: 'crashtest' });
  wal.append({ type: 'upsert', job: { id: 'a', status: 'waiting' } });
  wal.append({ type: 'upsert', job: { id: 'b', status: 'waiting' } });
  wal.append({ type: 'upsert', job: { id: 'a', status: 'completed' } }); // update to an existing id
  await wal.close(); // waits for the buffered writes to actually hit disk

  // A fresh instance over the same directory simulates the process restarting.
  wal = new WriteAheadLog({ dir, name: 'crashtest' });
  const { jobs, replayed } = wal.load();

  assert.equal(replayed, 3);
  assert.equal(jobs.get('a').status, 'completed');
  assert.equal(jobs.get('b').status, 'waiting');
  await wal.close();
});

test('compaction collapses the log into a snapshot and empties the WAL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-wal-'));
  const wal = new WriteAheadLog({ dir, name: 'compacttest' });

  wal.append({ type: 'upsert', job: { id: 'x', status: 'completed' } });
  wal.compact(new Map([['x', { id: 'x', status: 'completed' }]])); // synchronous (writeFileSync)

  const { jobs, replayed } = wal.load();
  assert.equal(replayed, 0); // the WAL is empty now; state lives in the snapshot
  assert.equal(jobs.get('x').status, 'completed');
  await wal.close();
});

test('delete events remove a job from the reconstructed state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-wal-'));
  const wal = new WriteAheadLog({ dir, name: 'deletetest' });

  wal.append({ type: 'upsert', job: { id: 'y', status: 'waiting' } });
  wal.append({ type: 'delete', jobId: 'y' });
  await wal.close();

  const { jobs } = wal.load();
  assert.equal(jobs.has('y'), false);
});

test('tolerates a truncated trailing line instead of refusing to start', async () => {
  // The realistic shape of WAL corruption from a hard crash: `kill -9`
  // catches an appendFileSync mid-write, leaving a partial last line. A
  // truly crash-safe log recovers everything *before* that point rather
  // than throwing and taking the whole queue down with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskforge-wal-'));
  const wal = new WriteAheadLog({ dir, name: 'corrupttest' });

  wal.append({ type: 'upsert', job: { id: 'a', status: 'waiting' } });
  wal.append({ type: 'upsert', job: { id: 'b', status: 'waiting' } });
  await wal.close();

  // Simulate a write cut off partway through, by hand-appending a truncated,
  // invalid JSON fragment as the new last line.
  fs.appendFileSync(wal.walPath, '{"type":"upsert","job":{"id":"c","stat');

  const fresh = new WriteAheadLog({ dir, name: 'corrupttest' });
  const { jobs, replayed, skipped } = fresh.load();

  assert.equal(replayed, 2);
  assert.equal(skipped, 1);
  assert.equal(jobs.get('a').status, 'waiting');
  assert.equal(jobs.get('b').status, 'waiting');
  assert.equal(jobs.has('c'), false);
  await fresh.close();
});
