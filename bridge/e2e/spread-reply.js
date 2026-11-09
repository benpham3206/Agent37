export function spreadSucceeded(reply) {
  const text = String(reply ?? '');
  return text.startsWith('Spread 1 player(s) around') || text.includes('Successfully spread');
}
