import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenBucket } from '../src/core/RateLimiter.js';

test('allows bursts up to capacity, then blocks', () => {
  const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 1 });
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
});

test('refills continuously over time', async () => {
  const bucket = new TokenBucket({ capacity: 1, refillPerSecond: 20 }); // 1 token per 50ms
  assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(bucket.tryTake(), true);
});
