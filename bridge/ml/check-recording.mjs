import fs from 'node:fs';

const v1Keys = ['schema_version', 'session_id', 'encounter_id', 'tick', 'timestamp_ms', 'server_tick', 'source', 'recording_state', 'label', 'observation', 'teacher_action', 'applied_action', 'arbiter'];
const requiredKeys = new Map([
  [1, v1Keys],
  [2, [...v1Keys, 'server_time_ms', 'agent_name', 'controller_id']],
]);
const nullableIdentity = value => value === null || (typeof value === 'string' && value.trim().length > 0);

function validate(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return 'expected a JSON object';
  if (!Object.hasOwn(row, 'schema_version')) return 'missing required key schema_version';
  const keys = requiredKeys.get(row.schema_version);
  if (!keys) return `unsupported schema_version ${JSON.stringify(row.schema_version)}`;
  for (const key of keys) if (!Object.hasOwn(row, key)) return `missing required key ${key}`;
  // V1's absent identity/time fields remain unknown; do not infer them from any other values.
  if (row.schema_version === 2) {
    if (row.server_time_ms !== null && !(Number.isInteger(row.server_time_ms) && row.server_time_ms >= 0)) return 'server_time_ms must be a nonnegative integer or null';
    for (const key of ['agent_name', 'controller_id']) if (!nullableIdentity(row[key])) return `${key} must be a nonempty string or null`;
    if (row.arbiter?.source !== 'teacher' && row.controller_id !== null) return 'controller_id must be null unless arbiter.source is teacher';
  }
  return null;
}

function main(args) {
  if (args.length !== 1) throw new Error('Usage: node bridge/ml/check-recording.mjs <file.jsonl>');
  let text;
  try { text = fs.readFileSync(args[0], 'utf8'); }
  catch (error) { throw new Error(`Cannot read ${args[0]}: ${error.message}`); }
  if (text.length === 0) throw new Error('row 1: empty encounter');
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop(); // A single final newline terminates the last row.
  let version;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fail = message => { throw new Error(`row ${i + 1}: ${message}: ${JSON.stringify(line)}`); };
    if (!line.trim()) fail('blank row');
    let row;
    try { row = JSON.parse(line); }
    catch { fail('malformed JSON'); }
    const error = validate(row);
    if (error) fail(error);
    if (version !== undefined && version !== row.schema_version) fail(`schema_version ${row.schema_version} differs from encounter version ${version}`);
    version = row.schema_version;
  }
  console.log(`OK ${version} ${lines.length}`);
}

try { main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
