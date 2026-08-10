/**
 * Classic token bucket. Used to cap how fast the queue dispatches jobs of a
 * kind that calls something with its own limits (a third-party API, an SMTP
 * relay, a database). Tokens refill continuously (not in discrete ticks),
 * which allows short bursts up to `capacity` while enforcing a hard average
 * rate of `refillPerSecond` over time.
 */
export class TokenBucket {
  constructor({ capacity, refillPerSecond }) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.lastRefill = performance.now();
  }

  #refill() {
    const now = performance.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSecond);
    this.lastRefill = now;
  }

  /** Attempts to spend `n` tokens. Returns false (and spends nothing) if not enough are available. */
  tryTake(n = 1) {
    this.#refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until at least one token will be available. Useful for scheduling a retry-tick. */
  msUntilNextToken() {
    this.#refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
  }
}
