// Simulates sending a welcome email through an SMTP relay: realistic latency,
// occasional transient failure (a real relay times out sometimes).
export default async function sendWelcomeEmail(payload) {
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 200));
  if (Math.random() < 0.08) throw new Error('SMTP relay timed out');
  return { sentTo: `user-${payload.seq}@example.com` };
}
