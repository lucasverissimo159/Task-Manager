import test from 'node:test';
import assert from 'node:assert/strict';
import { RetryPolicy } from '../src/core/RetryPolicy.js';

test('backoff grows exponentially and respects the cap', () => {
  const policy = new RetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: 0 });
  assert.equal(policy.nextDelay(1), 100);
  assert.equal(policy.nextDelay(2), 200);
  assert.equal(policy.nextDelay(3), 400);
  assert.equal(policy.nextDelay(4), 800);
  assert.equal(policy.nextDelay(10), 1000); // capped
});

test('jitter stays within the configured range and never goes negative', () => {
  const policy = new RetryPolicy({ baseDelayMs: 1000, maxDelayMs: 10_000, factor: 1, jitter: 0.5 });
  for (let i = 0; i < 100; i++) {
    const delay = policy.nextDelay(1);
    assert.ok(delay >= 500 && delay <= 1500, `delay ${delay}ms outside expected ±50% jitter range`);
  }
});
