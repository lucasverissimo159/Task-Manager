/**
 * A minimal binary heap. Ordering is fully delegated to a comparator, so the
 * same implementation backs both "highest priority first" and, if ever
 * needed, "earliest deadline first" — the Queue decides what "first" means.
 *
 * All operations are O(log n) except peek/isEmpty (O(1)), which matters once
 * a queue is holding thousands of pending jobs and ticking every 100ms.
 */
export class PriorityHeap {
  #items = [];
  #before; // #before(a, b) === true  <=>  a must come out of the heap before b

  constructor(beforeFn) {
    this.#before = beforeFn;
  }

  get size() {
    return this.#items.length;
  }

  isEmpty() {
    return this.#items.length === 0;
  }

  peek() {
    return this.#items[0] ?? null;
  }

  push(item) {
    this.#items.push(item);
    this.#bubbleUp(this.#items.length - 1);
  }

  pop() {
    if (this.#items.length === 0) return null;
    const top = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length > 0) {
      this.#items[0] = last;
      this.#bubbleDown(0);
    }
    return top;
  }

  /** Read-only snapshot, mostly useful for tests and debugging. */
  toArray() {
    return [...this.#items];
  }

  #bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#before(this.#items[i], this.#items[parent])) {
        this.#swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  #bubbleDown(i) {
    const n = this.#items.length;
    for (;;) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.#before(this.#items[left], this.#items[smallest])) smallest = left;
      if (right < n && this.#before(this.#items[right], this.#items[smallest])) smallest = right;
      if (smallest === i) break;
      this.#swap(i, smallest);
      i = smallest;
    }
  }

  #swap(i, j) {
    [this.#items[i], this.#items[j]] = [this.#items[j], this.#items[i]];
  }
}
