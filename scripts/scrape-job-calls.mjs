/**
 * Scrape the "job calls" / referral list a few IBEW locals publish on their own
 * websites, and write js/data/job-calls.json. Locals to scrape live in
 * scripts/job-calls.config.json (keyed by slug).
 *
 *   node scripts/scrape-job-calls.mjs                 # fetch every configured local
 *   node scripts/scrape-job-calls.mjs --only l606-orlando-fl
 *   node scripts/scrape-job-calls.mjs --offline       # re-parse the cached HTML
 *
 * Manual calls: scripts/job-calls.overrides.json is merged in on every run — for
 * locals we can't scrape (no `url`) or to add a call a scraped page missed. It's
 * keyed by local number ("915") or slug, each entry an optional `posted` label +
 * a `calls` array (`text` required; `count` / `classification` parsed from the
 * text or defaulted). Manual calls flow through the same new/edited/filled diff,
 * so adding or removing one drives the Discord bot exactly like a scraped change.
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
const OVERRIDES = join(ROOT, 'scripts', 'job-calls.overrides.json');
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

/* ---------- manual overrides ---------------------------------------------- */

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));

// local number → [slug]  (from the registry), to resolve a numeric override key
const slugsByNo = {};
for (const [k, v] of Object.entries(config)) {
  if (!/^l\d/.test(k) || !v || typeof v.local_no !== 'number') continue;
  (slugsByNo[v.local_no] ||= []).push(k);
}

/** Build { slug → { posted, calls[] } } from job-calls.overrides.json. */
function loadManual() {
  if (!existsSync(OVERRIDES)) return {};
  const raw = JSON.parse(readFileSync(OVERRIDES, 'utf8'));
  const bySlug = {};
  for (const [rawKey, entry] of Object.entries(raw)) {
    if (rawKey.startsWith('_') || !entry || typeof entry !== 'object') continue;
    let slug = rawKey;
    if (!/^l\d/.test(rawKey)) {
      const list = slugsByNo[Number(rawKey)] || [];
      if (list.length === 1) [slug] = list;
      else {
        console.warn(list.length
          ? `overrides: local ${rawKey} is ambiguous — use a slug (${list.join(', ')})`
          : `overrides: no local numbered ${rawKey}`);
        continue;
      }
    }
    const calls = (entry.calls || []).map((c) => {
      const text = String(c.text || '').trim();
      if (!text) return null;
      let count = Number.isFinite(c.count) ? c.count : null;
      let classification = c.classification || null;
      if (count == null || !classification) {
        for (const f of FORMATS) {
          const hit = f.match(text);
          if (hit) { count ??= hit.count; classification ||= hit.classification; break; }
        }
      }
      return {
        id: callId(text), key: listingKey(text),
        count: count ?? 1, classification: classification || 'Journeyman Wireman',
        text, source: 'manual',
        ...(c.open_until_filled ? { open_until_filled: true } : {}),
      };
    }).filter(Boolean);
    if (calls.length) bySlug[slug] = { posted: entry.posted || null, calls };
  }
  return bySlug;
}
const manual = loadManual();

/* ---------- diff a local's current calls against the last run ----------- */

const prev = existsSync(OUT)
  ? JSON.parse(readFileSync(OUT, 'utf8')).locals || {}
  : {};

const out = { generated_at: RUN_TS, locals: {} };
const delta = { generated_at: RUN_TS, added: {}, edited: {}, filled: {} };
let ok = 0;
let failed = 0;
let newTotal = 0;
let editedTotal = 0;

/**
 * Stamp first_seen/last_seen on `parsed.calls`, record this local's new/edited/
 * filled calls into `delta`, and write out.locals[slug]. `extra` is merged into
 * the stored record (e.g. { url } or { manual: true }).
 */
function commitLocal(slug, local_no, parsed, extra) {
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
    if (exact) continue;
    if (sameListing) changed.push({ ...c, prev_id: pcId(sameListing), prev_count: sameListing.count });
    else fresh.push(c);
  }

  const curIds = new Set(parsed.calls.map((c) => c.id));
  const curKeys = new Set(parsed.calls.map((c) => c.key));
  const gone = prevCalls
    .filter((pc) => !curIds.has(pcId(pc)) && !curKeys.has(pcKey(pc)))
    .map(pcId);

  out.locals[slug] = { local_no, ...extra, scraped_at: RUN_TS, ...parsed };
  const dbase = { local_no, url: extra.url, ...prettyPlace(slug), posted: parsed.posted };
  if (fresh.length) { newTotal += fresh.length; delta.added[slug] = { ...dbase, calls: fresh }; }
  if (changed.length) { editedTotal += changed.length; delta.edited[slug] = { ...dbase, calls: changed }; }
  if (gone.length) delta.filled[slug] = { local_no, ids: gone };

  console.log(
    `${slug}: ${parsed.total} job calls, ${parsed.calls.length} listings` +
    `${extra.manual ? ' (manual)' : ''}` +
    `${fresh.length ? `, ${fresh.length} NEW` : ''}` +
    `${changed.length ? `, ${changed.length} EDITED` : ''}` +
    `${gone.length ? `, ${gone.length} filled/removed` : ''}`,
  );
}

/** Fold this local's manual calls into a parsed result (scraped listing wins). */
function withManual(slug, parsed) {
  const man = manual[slug];
  if (!man) return parsed;
  delete manual[slug]; // consumed — the rest get their own pass below
  const have = new Set(parsed.calls.map((c) => c.key));
  const add = man.calls.filter((c) => !have.has(c.key));
  return {
    posted: parsed.posted || man.posted,
    calls: [...parsed.calls, ...add],
    count_sum: [...parsed.calls, ...add].reduce((a, c) => a + c.count, 0),
    total: (parsed.total ?? 0) + add.reduce((a, c) => a + c.count, 0),
  };
}

/* ---------- run ------------------------------------------------------- */

// slug keys with a `url` — the registry lists every local, but only those
// pointing at a UnionActive job-calls page get scraped here.
const entries = Object.entries(config).filter(([k, v]) => /^l\d/.test(k) && v && v.url);

for (const [slug, { local_no, url, format }] of entries) {
  if (ONLY && slug !== ONLY) continue;
  try {
    const parsed = withManual(slug, parseJobCalls(await getHtml(slug, url), [].concat(format || [])));
    commitLocal(slug, local_no, parsed, { url });
    ok += 1;
  } catch (e) {
    failed += 1;
    console.error(`${slug}: ${e.message}`);
  }
}

// locals that appear only in the overrides file (no url to scrape)
for (const [slug, man] of Object.entries(manual)) {
  if (ONLY && slug !== ONLY) continue;
  const local_no = config[slug]?.local_no ?? (Number((slug.match(/^l(\d+)/) || [])[1]) || null);
  const count_sum = man.calls.reduce((a, c) => a + c.count, 0);
  commitLocal(slug, local_no, { posted: man.posted, calls: man.calls, count_sum, total: count_sum }, { manual: true });
  ok += 1;
}

// a local that had calls last run but isn't produced this run (its last
// manual-only entry was removed) — report every call gone so Discord cleans up
if (!ONLY) {
  for (const [slug, pl] of Object.entries(prev)) {
    if (out.locals[slug] || !(pl.calls && pl.calls.length)) continue;
    delta.filled[slug] = {
      local_no: pl.local_no ?? null,
      ids: pl.calls.map((pc) => pc.id || callId(pc.text)),
    };
    console.log(`${slug}: dropped — ${pl.calls.length} call(s) removed`);
  }
}

// keep locals not touched this run (e.g. with --only)
if (ONLY) out.locals = { ...prev, ...out.locals };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
writeFileSync(DELTA, JSON.stringify(delta, null, 2) + '\n');
console.log(
  `Wrote ${OUT} (${Object.keys(out.locals).length} local(s), ${ok} ok, ${failed} failed) ` +
  `and ${DELTA} (${newTotal} new, ${editedTotal} edited call(s)).`,
);

if (failed && !ok) process.exit(1);
