export default async function greet(payload) {
  await new Promise((r) => setTimeout(r, 100));
  if (Math.random() < 0.2) throw new Error('Simulated transient failure');
  return { message: `Hello, ${payload.name}!` };
}
