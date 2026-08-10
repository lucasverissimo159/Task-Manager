/**
 * Full exponential backoff with proportional jitter.
 *
 * Why jitter matters: if 200 jobs fail at the same instant because a
 * downstream API had a blip, pure exponential backoff retries them all at
 * the *same* future instant too — a self-inflicted thundering herd against
 * a service that's already struggling. Randomizing each delay by up to
 * `jitter` (a fraction, e.g. 0.3 = ±30%) spreads retries out in time.
 *
 * delay(attempt) = min(maxDelayMs, baseDelayMs * factor^(attempt-1)) ± jitter%
 */
export class RetryPolicy {
  constructor({ baseDelayMs = 500, maxDelayMs = 30_000, factor = 2, jitter = 0.3 } = {}) {
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.factor = factor;
    this.jitter = jitter;
  }

  nextDelay(attempt) {
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * this.factor ** (attempt - 1));
    const jitterRange = exponential * this.jitter;
    const offset = (Math.random() * 2 - 1) * jitterRange; // uniform in [-jitterRange, +jitterRange]
    return Math.max(0, Math.round(exponential + offset));
  }
}
