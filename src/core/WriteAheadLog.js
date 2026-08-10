import fs from 'node:fs';
import path from 'node:path';

/**
 * A minimal write-ahead log with snapshot compaction — the same durability
 * pattern behind databases and systems like Kafka or Redis's AOF.
 *
 * Every state-changing event (a job created, or a job transitioning status)
 * is appended to `<name>.wal.jsonl` *before* the in-memory Queue considers
 * the change committed. If the process dies at any point — a crash, `kill
 * -9`, a power cut — restarting replays the log and the in-memory state is
 * reconstructed exactly as it was.
 *
 * Left unchecked, the log would grow forever and startup would get slower
 * with every job the queue has ever processed. `compact()` collapses the
 * current state into `<name>.snapshot.json` and truncates the log, so a
 * restart only ever needs to replay events since the last compaction.
 *
 * Every append is a synchronous `fs.appendFileSync` — a deliberate choice,
 * not an oversight. An earlier version buffered writes through a long-lived
 * `fs.createWriteStream`, which is faster but opened a real hazard: if a
 * buffered write was still in flight when `compact()` truncated the same
 * file through a *different* file descriptor, the stream's internal offset
 * tracking and the truncate could race. Synchronous per-line appends make
 * that impossible — every append fully completes, on disk, before the next
 * line of JS runs — at a throughput cost that doesn't matter at this scale
 * (a portfolio-scale queue is nowhere near the write volume where that
 * would be felt). This still isn't a full `fsync`-per-write guarantee: the
 * OS may hold the write in its own page cache briefly before it hits the
 * physical disk. That last, smaller gap is the trade-off actually being
 * made here, and a system with stronger durability requirements would close
 * it with an explicit `fsync`/`fdatasync` after each append or small batch.
 */
export class WriteAheadLog {
  constructor({ dir, name }) {
    this.dir = dir;
    this.walPath = path.join(dir, `${name}.wal.jsonl`);
    this.snapshotPath = path.join(dir, `${name}.snapshot.json`);
    fs.mkdirSync(dir, { recursive: true });
    this.pendingEvents = 0;
  }

  append(event) {
    fs.appendFileSync(this.walPath, JSON.stringify({ ...event, ts: Date.now() }) + '\n');
    this.pendingEvents++;
  }

  /**
   * Rebuilds state as a Map<jobId, plainJobObject> from the last snapshot
   * plus every WAL entry written since. Returns how many WAL lines were
   * replayed (so callers can prove, and log, that recovery happened) and how
   * many were skipped for being unparseable.
   *
   * A corrupt line is tolerated, not fatal: the realistic way a line goes
   * bad is a hard crash (`kill -9`, power loss) catching the very last
   * `appendFileSync` mid-write, leaving a truncated trailing line. Refusing
   * to start the whole queue over one incomplete line would be worse than
   * the one event it cost — it would turn "crash-safe" into "crash-safe,
   * unless the crash happens at an inconvenient moment," which defeats the
   * point.
   */
  load() {
    const jobs = new Map();

    if (fs.existsSync(this.snapshotPath)) {
      const snap = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
      for (const job of snap.jobs) jobs.set(job.id, job);
    }

    let replayed = 0;
    let skipped = 0;
    if (fs.existsSync(this.walPath)) {
      const raw = fs.readFileSync(this.walPath, 'utf8').trim();
      if (raw) {
        for (const line of raw.split('\n')) {
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            replayed++;
            if (event.type === 'upsert') jobs.set(event.job.id, event.job);
            else if (event.type === 'delete') jobs.delete(event.jobId);
          } catch {
            skipped++;
          }
        }
      }
    }

    return { jobs, replayed, skipped };
  }

  /** Collapses snapshot + WAL into a fresh snapshot, then empties the WAL. */
  compact(jobsMap) {
    const jobs = [...jobsMap.values()];
    fs.writeFileSync(this.snapshotPath, JSON.stringify({ jobs, compactedAt: Date.now() }, null, 2));
    fs.writeFileSync(this.walPath, '');
    this.pendingEvents = 0;
  }

  /**
   * No-op: every append() is already a complete synchronous write, so there
   * is no in-process buffer left to flush. Kept as a method so callers don't
   * need to change (and don't need to know that), and so a future buffered
   * write mode would have somewhere to put a real flush.
   */
  close() {}
}
