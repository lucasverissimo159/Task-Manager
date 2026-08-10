import test from 'node:test';
import assert from 'node:assert/strict';
import { PriorityHeap } from '../src/core/PriorityHeap.js';

test('pops items in descending priority order', () => {
  const heap = new PriorityHeap((a, b) => a.priority > b.priority);
  for (const priority of [1, 5, 3, 5, 0]) heap.push({ priority });

  const order = [];
  while (!heap.isEmpty()) order.push(heap.pop().priority);

  assert.deepEqual(order, [5, 5, 3, 1, 0]);
});

test('peek does not remove the item', () => {
  const heap = new PriorityHeap((a, b) => a.priority > b.priority);
  heap.push({ priority: 7 });
  assert.equal(heap.peek().priority, 7);
  assert.equal(heap.size, 1);
});

test('handles an empty heap gracefully', () => {
  const heap = new PriorityHeap((a, b) => a.priority > b.priority);
  assert.equal(heap.pop(), null);
  assert.equal(heap.peek(), null);
  assert.equal(heap.isEmpty(), true);
});

test('maintains heap invariant across interleaved push/pop', () => {
  const heap = new PriorityHeap((a, b) => a.priority > b.priority);
  const values = Array.from({ length: 200 }, () => Math.floor(Math.random() * 1000));
  for (const v of values) heap.push({ priority: v });

  const popped = [];
  while (!heap.isEmpty()) popped.push(heap.pop().priority);

  const expected = [...values].sort((a, b) => b - a);
  assert.deepEqual(popped, expected);
});
