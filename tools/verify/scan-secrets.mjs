import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function scanText(filename, text) {
  if (filename.endsWith('.example') || text.includes('\0')) return [];
  const findings = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const types = new Set();
    for (const match of line.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g)) {
      // The unspecified address is a conventional configuration placeholder.
      if (match[0] !== '0.0.0.0' && match[0].split('.').every(part => Number(part) <= 255)) types.add('IPv4 address');
    }
    for (const match of line.matchAll(/\bpassword\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|\$\{[^}\r\n]+\}|[^\s#;,)}]+)/gi)) {
      const value = match[1].replace(/^["']|["']$/g, '');
      // Reading a value from the environment is not a hardcoded password.
      if (/^(?:process\.)?env\.[A-Z_][A-Z_0-9]*$/.test(value)) continue;
      if (value && !/^(?:<[^>]+>|\$\{[^}]+\}|\$[\w]+|YOUR_[\w]+|CHANGEME|REPLACE_ME|example|placeholder|x{3,})$/i.test(value)) types.add('password assignment');
    }
    if (/https?:\/\/(?:[\w-]+\.)*(?:ngrok\.(?:io|app|dev)|ngrok-free\.(?:app|dev)|trycloudflare\.com|loca\.lt|localtunnel\.me|serveo\.net|localhost\.run|pinggy\.(?:link|io))\b/i.test(line)) types.add('tunnel URL');
    for (const type of types) findings.push({ filename, line: index + 1, type });
  }
  return findings;
}

export function scanRepository(directory = root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: directory }).toString('utf8').split('\0').filter(Boolean);
  return files.flatMap(filename => scanText(filename, readFileSync(path.join(directory, filename), 'utf8')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const findings = scanRepository();
    for (const finding of findings) console.error(`${finding.filename}:${finding.line}: ${finding.type} (value redacted)`);
    if (findings.length) {
      console.error(`Secrets scan FAIL: ${findings.length} finding(s).`);
      process.exitCode = 1;
    } else console.log('Secrets scan PASS: no prohibited content in tracked files.');
  } catch (error) {
    console.error(`Secrets scan could not complete (${error.code ?? 'read/git error'}).`);
    process.exitCode = 1;
  }
}
