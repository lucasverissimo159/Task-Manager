/**
 * Rolling-window latency and throughput tracking.
 *
 * Percentiles (p50/p95/p99) matter more than an average for job processing:
 * a mean can look fine while 1% of jobs quietly take 10x longer than the
 * rest — exactly the jobs an on-call engineer needs to know about. Keeping
 * only samples from the last `windowMs` keeps the numbers reflecting "now"
 * rather than a stat that never forgets a slow job from an hour ago.
 *
 * The sort-on-read approach is O(n log n) per call, which is deliberately
 * fine here: at dashboard-poll rates (~1/sec) and portfolio-scale job
 * volumes, a proper streaming structure (t-digest, HDR histogram) would be
 * solving a problem this project doesn't have yet.
 */
export class Metrics {
  #samples = []; // { t, ms }[]
  #completedAt = []; // number[]
  #windowMs;

  constructor({ windowMs = 60_000 } = {}) {
    this.#windowMs = windowMs;
  }

  recordDuration(ms) {
    const t = Date.now();
    this.#samples.push({ t, ms });
    this.#completedAt.push(t);
    this.#prune();
  }

  #prune() {
    const cutoff = Date.now() - this.#windowMs;
    while (this.#samples.length && this.#samples[0].t < cutoff) this.#samples.shift();
    while (this.#completedAt.length && this.#completedAt[0] < cutoff) this.#completedAt.shift();
  }

  percentile(p) {
    this.#prune();
    if (this.#samples.length === 0) return 0;
    const sorted = this.#samples.map((s) => s.ms).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[idx]);
  }

  throughputPerSecond() {
    this.#prune();
    return this.#completedAt.length / (this.#windowMs / 1000);
  }

  snapshot() {
    return {
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      throughputPerSecond: Number(this.throughputPerSecond().toFixed(2)),
    };
  }
}
