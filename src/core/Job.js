import { randomUUID } from 'node:crypto';

/**
 * A job's lifecycle is a strict one-way graph:
 *
 *   WAITING ──▶ ACTIVE ──▶ COMPLETED
 *      ▲           │
 *      │           ▼
 *   DELAYED ◀── (retry backoff)
 *      │           │
 *      │           ▼ (attempts exhausted)
 *      └────▶     DEAD
 *
 * DELAYED is reused for both "scheduled to run later" (user-specified delay)
 * and "failed, waiting to retry" (backoff delay) — both are just "not ready
 * yet", which keeps the state machine small instead of multiplying states.
 */
export const JobStatus = Object.freeze({
  WAITING: 'waiting',
  DELAYED: 'delayed',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  DEAD: 'dead',
  CANCELLED: 'cancelled',
});

export class Job {
  constructor({
    id,
    name,
    payload,
    priority = 0,
    delayMs = 0,
    maxAttempts = 3,
    dedupeKey = null,
    createdAt = Date.now(),
  }) {
    this.id = id ?? randomUUID();
    this.name = name;
    this.payload = payload;
    this.priority = priority;
    this.maxAttempts = maxAttempts;
    this.dedupeKey = dedupeKey;
    this.attempts = 0;
    this.createdAt = createdAt;
    this.processAt = createdAt + delayMs;
    this.status = delayMs > 0 ? JobStatus.DELAYED : JobStatus.WAITING;
    this.startedAt = null;
    this.finishedAt = null;
    this.result = null;
    this.error = null;
  }

  /** Moves the job to a new status and merges any extra fields (e.g. result, error). */
  transition(status, extra = {}) {
    this.status = status;
    Object.assign(this, extra);
    return this;
  }

  toJSON() {
    const {
      id, name, payload, priority, maxAttempts, dedupeKey,
      attempts, createdAt, processAt, status, startedAt, finishedAt, result, error,
    } = this;
    return {
      id, name, payload, priority, maxAttempts, dedupeKey,
      attempts, createdAt, processAt, status, startedAt, finishedAt, result, error,
    };
  }

  /** Rehydrates a Job instance from a plain object (WAL replay / snapshot load). */
  static fromJSON(obj) {
    const job = Object.create(Job.prototype);
    return Object.assign(job, obj);
  }
}
