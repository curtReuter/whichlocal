/**
 * Scrape the "job calls" / referral list a few IBEW locals publish on their own
 * websites, and write js/data/job-calls.json. Locals to scrape live in
 * scripts/job-calls.config.json (keyed by slug).
 *
 *   node scripts/scrape-job-calls.mjs                 # fetch every configured local
 *   node scripts/scrape-job-calls.mjs --only l606-orlando-fl
 *   node scripts/scrape-job-calls.mjs --offline       # re-parse the cached HTML
 *
 * State: each call gets a stable `id` (hash of its text) plus `first_seen` /
 * `last_seen`. The previous js/data/job-calls.json is read and those timestamps
 * are carried forward, so a call that persists across runs keeps its original
 * `first_seen`. Calls that are new this run are also written to
 * scripts/cache/job-calls-delta.json for scripts/notify-discord.mjs.
 *
 * Conduct: one request per local per run; the HTML is cached to scripts/cache/
 * so `--offline` re-runs never touch the sites. Identifies itself with a
 * descriptive User-Agent including SCRAPER_CONTACT.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadEnv } from './lib/pb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'scripts', 'cache');
const CONFIG = join(ROOT, 'scripts', 'job-calls.config.json');
const OUT = join(ROOT, 'js', 'data', 'job-calls.json');
const DELTA = join(CACHE_DIR, 'job-calls-delta.json');

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

loadEnv();
const CONTACT = process.env.SCRAPER_CONTACT || 'unknown';
const UA = `WhichLocal-jobcalls/1.0 (+${CONTACT})`;
const RUN_TS = new Date().toISOString();

mkdirSync(CACHE_DIR, { recursive: true });

/* ---------- fetch / cache ------------------------------------------------ */

async function getHtml(slug, url) {
  const cache = join(CACHE_DIR, `job-calls-${slug}.html`);
  if (OFFLINE) {
    if (!existsSync(cache)) throw new Error(`--offline but no cache at ${cache}`);
    return readFileSync(cache, 'utf8');
  }
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  const html = await res.text();
  writeFileSync(cache, html);
  return html;
}

/* ---------- parse ------------------------------------------------------- */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  ndash: '–', mdash: '—', '#39': "'",
};
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) =>
      (name.toLowerCase() in NAMED ? NAMED[name.toLowerCase()] : m));
}
const plain = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// Normalised key for identity — tolerant of whitespace and curly-quote churn.
const normKey = (t) =>
  t.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ').trim();
const callId = (t) => createHash('sha1').update(normKey(t)).digest('hex').slice(0, 16);

const prettyPlace = (slug) => {
  const parts = slug.replace(/^l\d+-/, '').split('-');
  const state = (parts.pop() || '').toUpperCase();
  const city = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { city, state };
};

const CLASSES = {
  JW: 'Journeyman Wireman', JIW: 'Journeyman Inside Wireman',
  CW: 'Construction Wireman', CE: 'Construction Electrician',
  JWT: 'Journeyman Wireman Technician',
};

/**
 * Pull the job-call blocks out of a UnionActive "Job Calls" page. Two layouts
 * are handled, one <p> per call in both:
 *   A (e.g. Local 606) — "10 Journeyman Wireman calls for Contractor …",
 *      with a "There are N job calls:" header.
 *   B (e.g. Local 756) — "5 - JW Contractor, Working at …  $40.30", sometimes
 *      followed by a lone "OPEN UNTIL FILLED" paragraph, and no header (the
 *      total is the sum of the leading counts).
 */
function parseJobCalls(html) {
  // widest content region across the UnionActive page templates
  let start = -1;
  for (const a of [/class=["']pageheader["']/i, /id=["']pagecontent["']/i, /id=["']maincolumnspot["']/i]) {
    const i = html.search(a);
    if (i >= 0 && (start < 0 || i < start)) start = i;
  }
  let region = start >= 0 ? html.slice(start) : html;
  const cut = region.search(
    /last call was taken by|NEW CALLS DISPATCHED|OPEN CALLS DISPATCHED|All Calls for the|Page Last Updated/i,
  );
  if (cut > -1) region = region.slice(0, cut);

  const flat = plain(region);
  const head = flat.match(/There (?:are|is)\s+(\d+|no|one)\s+job calls?/i);
  const headerTotal = head
    ? (/\d/.test(head[1]) ? parseInt(head[1], 10) : head[1].toLowerCase() === 'no' ? 0 : 1)
    : null;
  const posted =
    (flat.match(/\b([A-Z][a-z]+ \d{1,2},? \d{4})\b/) || [])[1] ||
    // "…the following calls: Tuesday, September 8th" — stop at the first call marker
    (flat.match(/following calls:\s*(.{3,50}?)(?=\s*\d+\s*[-–—]\s*[A-Za-z]{2})/i) || [])[1]?.trim() ||
    null;

  const calls = [];
  for (const block of region.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []) {
    const t = plain(block);
    if (!t) continue;

    if (/^open until filled\b/i.test(t)) {
      if (calls.length) calls[calls.length - 1].open_until_filled = true;
      continue;
    }

    // A: "10 Journeyman Wireman calls for …"
    let m = t.match(/^(\d+)\s+([A-Za-z][A-Za-z ]*?)\s+calls?\s+for\b/i);
    if (m) {
      calls.push({ id: callId(t), count: parseInt(m[1], 10), classification: m[2].trim(), text: t });
      continue;
    }
    // B: "5 - JW Contractor …"  (dash then a short classification token)
    m = t.match(/^(\d+)\s*[-–—]\s*([A-Za-z]{2,4}(?:\/[A-Za-z]{2,4})?)\b/);
    if (m) {
      const cls = CLASSES[m[2].toUpperCase()] || m[2].toUpperCase();
      calls.push({ id: callId(t), count: parseInt(m[1], 10), classification: cls, text: t });
    }
  }

  const countSum = calls.reduce((a, c) => a + c.count, 0);
  return { posted, total: headerTotal ?? countSum, count_sum: countSum, calls };
}

/* ---------- run ------------------------------------------------------- */

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const entries = Object.entries(config).filter(([k]) => /^l\d/.test(k)); // slug keys only

const prev = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8')).locals || {}
  : {};

const out = { generated_at: RUN_TS, locals: {} };
const delta = { generated_at: RUN_TS, added: {}, filled: {} };
let ok = 0;
let failed = 0;
let newTotal = 0;

for (const [slug, { local_no, url }] of entries) {
  if (ONLY && slug !== ONLY) continue;
  try {
    const parsed = parseJobCalls(await getHtml(slug, url));

    // index the previous run's calls by id and by normalised text (older files
    // may predate `id`, so match on text too)
    const prevCalls = (prev[slug] && prev[slug].calls) || [];
    const byId = new Map();
    const byText = new Map();
    for (const pc of prevCalls) {
      const id = pc.id || callId(pc.text);
      const seen = pc.first_seen || prev[slug].scraped_at || RUN_TS;
      byId.set(id, seen);
      byText.set(normKey(pc.text), seen);
    }

    const fresh = [];
    for (const c of parsed.calls) {
      const priorSeen = byId.get(c.id) ?? byText.get(normKey(c.text));
      c.first_seen = priorSeen ?? RUN_TS;
      c.last_seen = RUN_TS;
      if (priorSeen == null) fresh.push(c);
    }

    const gone = prevCalls
      .map((pc) => pc.id || callId(pc.text))
      .filter((id) => !parsed.calls.some((c) => c.id === id));

    out.locals[slug] = { local_no, url, scraped_at: RUN_TS, ...parsed };
    if (fresh.length) {
      newTotal += fresh.length;
      delta.added[slug] = { local_no, url, ...prettyPlace(slug), posted: parsed.posted, calls: fresh };
    }
    if (gone.length) delta.filled[slug] = { local_no, ids: gone };

    ok++;
    console.log(
      `${slug}: ${parsed.total} job calls, ${parsed.calls.length} listings` +
      `${fresh.length ? `, ${fresh.length} NEW` : ''}${gone.length ? `, ${gone.length} filled/removed` : ''}`,
    );
  } catch (e) {
    failed++;
    console.error(`${slug}: ${e.message}`);
  }
}

// keep locals not scraped this run (e.g. with --only)
if (ONLY) out.locals = { ...prev, ...out.locals };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
writeFileSync(DELTA, JSON.stringify(delta, null, 2) + '\n');
console.log(
  `Wrote ${OUT} (${Object.keys(out.locals).length} local(s), ${ok} ok, ${failed} failed) ` +
  `and ${DELTA} (${newTotal} new call(s)).`,
);

if (failed && !ok) process.exit(1);
