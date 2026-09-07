/**
 * Fold an approved submission issue into an overrides file.
 *
 * Run by .github/workflows/apply-submission.yml when an issue is labelled
 * `approved`. Reads the issue body from the environment, pulls the fenced
 * ```json snippet the Worker (worker/) put there, and merges it into:
 *
 *   label wage-correction  → scripts/overrides.json            (merge fields)
 *   label job-call         → scripts/job-calls.overrides.json  (append calls)
 *   label job-call-removal → nothing (freeform — left for a human)
 *
 * Writes GITHUB_OUTPUT `changed=true|false` and, when false, a `note` the
 * workflow posts back on the issue.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const body = process.env.ISSUE_BODY || '';
const labels = (process.env.ISSUE_LABELS || '').split(',').map((s) => s.trim()).filter(Boolean);
const num = process.env.ISSUE_NUMBER || '?';
const today = new Date().toISOString().slice(0, 10);

const emit = (k, v) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  console.log(`${k}=${v}`);
};
const bail = (note) => { emit('changed', 'false'); emit('note', note); process.exit(0); };

const FILES = {
  'wage-correction': 'scripts/overrides.json',
  'job-call': 'scripts/job-calls.overrides.json',
};

const label = labels.find((l) => FILES[l]);
if (!label) {
  bail('No auto-apply for this submission type — edit the overrides file by hand, then close this issue.');
}

const block = body.match(/```json\s*([\s\S]*?)```/i);
if (!block) bail('No JSON snippet in the issue body — apply this one manually.');

let entry;
try {
  // the snippet is `"key": <value>` — wrap it into an object
  entry = JSON.parse(`{${block[1].trim().replace(/,\s*$/, '')}}`);
} catch (e) {
  bail(`Couldn't parse the snippet (\`${e.message}\`) — apply manually.`);
}

const file = FILES[label];
const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

for (const [key, val] of Object.entries(entry)) {
  if (label === 'wage-correction') {
    data[key] = { ...(data[key] || {}), ...val };
  } else {
    const cur = (data[key] && Array.isArray(data[key].calls)) ? data[key].calls : [];
    const seen = new Set(cur.map((c) => (c.text || '').trim()));
    const add = (Array.isArray(val.calls) ? val.calls : []).filter((c) => !seen.has((c.text || '').trim()));
    data[key] = { ...(data[key] || {}), ...val, calls: [...cur, ...add] };
  }
}

writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
emit('changed', 'true');
emit('file', file);
console.log(`Merged submission #${num} (${label}) into ${file} on ${today}`);
