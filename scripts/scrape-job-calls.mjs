/**
 * Scrape the "job calls" / referral list a few IBEW locals publish on their own
 * websites, and write js/data/job-calls.json. Locals to scrape live in
 * scripts/job-calls.config.json (keyed by slug).
 *
 *   node scripts/scrape-job-calls.mjs                 # fetch every configured local
 *   node scripts/scrape-job-calls.mjs --only l606-orlando-fl
 *   node scripts/scrape-job-calls.mjs --offline       # re-parse the cached HTML
 *
 * State: each call gets a stable `id` (hash of its exact text), a `key` (hash of
 * the text with the leading count stripped — the listing identity, unchanged by
 * "10 → 9"), plus `first_seen` / `last_seen`. The previous js/data/job-calls.json
 * is read and those timestamps carried forward. scripts/cache/job-calls-delta.json
 * records this run's `added` (new listings), `edited` (same `key`, wording/count
 * changed — carries `prev_id` / `prev_count`) and `filled` (gone) for
 * scripts/notify-discord.mjs.
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
const sha16 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// `id` identifies the exact wording of a call — it changes on any edit.
const callId = (t) => sha16(normKey(t));
// `key` identifies the *listing* regardless of how many are left on it: drop the
// leading count ("10 Journeyman…" / "5 - JW…") so "10 → 9" is seen as the same
// listing edited, not one call filled and a different one opened.
const listingKey = (t) => sha16(normKey(t).replace(/^\d+\s*(?:[-–—]\s*)?/, ''));

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
 * Paragraph shapes we know how to read, tried in order against each <p> on a
 * "Job Calls" page. A matcher gets the paragraph's plain text and returns
 * { count, classification } for a call, or null to pass. Every configured local
 * is run through all of these unless its job-calls.config.json entry names a
 * `format` (string or array) to restrict it.
 *
 * To support a local that publishes calls in a new shape, add an entry here —
 * nothing else needs to change.
 */
const FORMATS = [
  {
    // "10 Journeyman Wireman calls for Maddox Electric …"  (e.g. Local 606)
    name: 'prose',
    match(t) {
      const m = t.match(/^(\d+)\s+([A-Za-z][A-Za-z ]*?)\s+calls?\s+for\b/i);
      return m ? { count: parseInt(m[1], 10), classification: m[2].trim() } : null;
    },
  },
  {
    // "5 - JW Cache Valley Electric, Working at …  $40.30"  (e.g. Local 756)
    name: 'dash-code',
    match(t) {
      const m = t.match(/^(\d+)\s*[-–—]\s*([A-Za-z]{2,4}(?:\/[A-Za-z]{2,4})?)\b/);
      if (!m) return null;
      return {
        count: parseInt(m[1], 10),
        classification: CLASSES[m[2].toUpperCase()] || m[2].toUpperCase(),
      };
    },
  },
];

/**
 * Pull the job-call blocks out of a UnionActive "Job Calls" page. One <p> per
 * call; each is matched against FORMATS (optionally narrowed by `formatNames`).
 * A "There are N job calls:" header sets the total when present, otherwise it is
 * the sum of the leading counts.
 */
function parseJobCalls(html, formatNames) {
  const active = formatNames && formatNames.length
    ? FORMATS.filter((f) => formatNames.includes(f.name))
    : FORMATS;
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
    for (const f of active) {
      const hit = f.match(t);
      if (hit) {
        calls.push({
          id: callId(t), key: listingKey(t),
          count: hit.count, classification: hit.classification, text: t,
        });
        break;
      }
    }
  }

  const countSum = calls.reduce((a, c) => a + c.count, 0);
  return { posted, total: headerTotal ?? countSum, count_sum: countSum, calls };
}

/* ---------- run ------------------------------------------------------- */

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
// slug keys with a `url` — the registry lists every local, but only those
// pointing at a UnionActive job-calls page get scraped here.
const entries = Object.entries(config).filter(([k, v]) => /^l\d/.test(k) && v && v.url);

const prev = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8')).locals || {}
  : {};

const out = { generated_at: RUN_TS, locals: {} };
const delta = { generated_at: RUN_TS, added: {}, edited: {}, filled: {} };
let ok = 0;
let failed = 0;
let newTotal = 0;
let editedTotal = 0;

for (const [slug, { local_no, url, format }] of entries) {
  if (ONLY && slug !== ONLY) continue;
  try {
    const parsed = parseJobCalls(await getHtml(slug, url), [].concat(format || []));

    // index the previous run's calls two ways: `byId` = exact wording, `byKey` =
    // the listing regardless of how many are left on it (older files may predate
    // either field, so fall back to hashing the stored text).
    const prevCalls = (prev[slug] && prev[slug].calls) || [];
    const seenOf = (pc) => pc.first_seen || prev[slug].scraped_at || RUN_TS;
    const pcId = (pc) => pc.id || callId(pc.text);
    const pcKey = (pc) => pc.key || listingKey(pc.text);
    const byId = new Map(prevCalls.map((pc) => [pcId(pc), pc]));
    const byKey = new Map(prevCalls.map((pc) => [pcKey(pc), pc]));

    const fresh = [];
    const changed = [];
    for (const c of parsed.calls) {
      const exact = byId.get(c.id);
      const sameListing = exact || byKey.get(c.key);
      c.first_seen = sameListing ? seenOf(sameListing) : RUN_TS;
      c.last_seen = RUN_TS;
      if (exact) continue;                         // unchanged
      if (sameListing) {                           // same listing, wording/count edited
        changed.push({ ...c, prev_id: pcId(sameListing), prev_count: sameListing.count });
      } else {
        fresh.push(c);                             // a listing we've not seen before
      }
    }

    // a previous call is "gone" only when neither its exact id nor its listing
    // key turns up this run — an edited listing is a change, not a removal
    const curIds = new Set(parsed.calls.map((c) => c.id));
    const curKeys = new Set(parsed.calls.map((c) => c.key));
    const gone = prevCalls
      .filter((pc) => !curIds.has(pcId(pc)) && !curKeys.has(pcKey(pc)))
      .map(pcId);

    out.locals[slug] = { local_no, url, scraped_at: RUN_TS, ...parsed };
    if (fresh.length) {
      newTotal += fresh.length;
      delta.added[slug] = { local_no, url, ...prettyPlace(slug), posted: parsed.posted, calls: fresh };
    }
    if (changed.length) {
      editedTotal += changed.length;
      delta.edited[slug] = { local_no, url, ...prettyPlace(slug), posted: parsed.posted, calls: changed };
    }
    if (gone.length) delta.filled[slug] = { local_no, ids: gone };

    ok++;
    console.log(
      `${slug}: ${parsed.total} job calls, ${parsed.calls.length} listings` +
      `${fresh.length ? `, ${fresh.length} NEW` : ''}` +
      `${changed.length ? `, ${changed.length} EDITED` : ''}` +
      `${gone.length ? `, ${gone.length} filled/removed` : ''}`,
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
  `and ${DELTA} (${newTotal} new, ${editedTotal} edited call(s)).`,
);

if (failed && !ok) process.exit(1);
