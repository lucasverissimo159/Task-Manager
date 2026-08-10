import { JobStatus } from './Job.js';

/**
 * A thin, purpose-built view over jobs that exhausted every retry attempt.
 * Kept as its own small class (rather than a few inline methods on Queue)
 * because "inspect and redrive failures" is a distinct operational concern
 * from "schedule and run jobs" — the kind of seam that's cheap to draw now
 * and annoying to retrofit later.
 */
export class DeadLetterQueue {
  constructor(queue) {
    this.queue = queue;
  }

  list() {
    return [...this.queue.jobs.values()]
      .filter((job) => job.status === JobStatus.DEAD)
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .map((job) => job.toJSON());
  }

  /** Resets a dead job's attempt counter and puts it back in the ready queue. */
  redrive(jobId) {
    const job = this.queue.jobs.get(jobId);
    if (!job || job.status !== JobStatus.DEAD) return false;
    job.attempts = 0;
    job.error = null;
    this.queue._enqueueExisting(job);
    return true;
  }

  redriveAll() {
    return this.list()
      .map((job) => this.redrive(job.id))
      .filter(Boolean).length;
  }
}
