// Simulates calling a flaky third-party API — the canonical case for
// retries, backoff, and a dead-letter queue: it fails often enough that a
// naive "just await it" implementation would lose a third of its jobs.
export default async function callFlakyApi(payload) {
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 150));
  if (Math.random() < 0.35) throw new Error('Upstream API returned 503');
  return { status: 200, echoedSeq: payload.seq };
}
