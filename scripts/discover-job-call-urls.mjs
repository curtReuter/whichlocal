/**
 * Triage which of the locals in scripts/job-calls.config.json actually have a
 * *public* job-calls/dispatch/referral page worth building a scraper for, so
 * the scraper's coverage can grow past 606/756 without guessing. Doesn't parse
 * job calls itself — it sorts every local into:
 *
 *   public      — found a job-calls-ish page and it looks like real, readable
 *                 listings (or a "no calls right now" message) — a good
 *                 candidate for a new FORMATS matcher or an LLM extractor.
 *   gated       — found the page, but it's a member login wall (a <input
 *                 type=password>). Not scrapable without impersonating a
 *                 member — treat as permanently out of reach, not a TODO.
 *   unclear     — found *something* linked from the homepage nav, but the
 *                 page's content didn't confidently match "listings" or
 *                 "login wall" — usually a JS-rendered app embed. Needs a
 *                 human look before deciding.
 *   none        — no job-calls/dispatch/referral-ish link found in the
 *                 homepage's own HTML. Could be genuinely absent, or a link
 *                 that only exists inside JS-rendered nav (a false negative
 *                 this script can't rule out without a real browser).
 *   no-website  — no website on record for this local at all.
 *   unreachable — had a URL but the fetch itself failed (DNS/TLS/HTTP error).
 *
 * Website discovery: scripts/job-calls.config.json only carries a `url` for
 * the ~2 locals someone has already wired up. For everyone else this script
 * looks the local up by number on sparkshift.app's public local-union
 * directory (an independent, non-IBEW third-party site — used here only to
 * find *which domain* a local's own site lives at, never as a source of job-
 * call data itself). Its per-state pages
 * (sparkshift.app/directory/union/locations/<state-name>) embed a plain JSON
 * array in a Next.js data chunk; state-name slugs are borrowed from
 * discord-threads.json's forum registry so there's one state-name list in the
 * repo, not two. About half of locals have no site on record there either —
 * that's real, not a bug in this script.
 *
 *   node scripts/discover-job-call-urls.mjs                  # resolve up to the default budget
 *   node scripts/discover-job-call-urls.mjs --limit 40        # only touch 40 new locals this run
 *   node scripts/discover-job-call-urls.mjs --state FL         # just Florida's locals
 *   node scripts/discover-job-call-urls.mjs --only l20-dallas-tx
 *   node scripts/discover-job-call-urls.mjs --refresh          # re-check locals already resolved
 *   node scripts/discover-job-call-urls.mjs --offline           # reuse cached HTML only, no network
 *
 * Writes scripts/job-call-discovery.json (one entry per local) — a report to
 * read, not something notify-discord.mjs or scrape-job-calls.mjs consumes.
 * Turning a "public" hit into an actual scrape target is still a human
 * decision: add its url (and, if it doesn't match an existing FORMATS entry,
 * a new one) to scripts/job-calls.config.json yourself.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './lib/pb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'scripts', 'cache', 'discover');
const CONFIG = join(ROOT, 'scripts', 'job-calls.config.json');
const THREADS = join(ROOT, 'scripts', 'discord-threads.json');
const OUT = join(ROOT, 'scripts', 'job-call-discovery.json');

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const REFRESH = args.has('--refresh');           // re-check locals already resolved
const REFRESH_DIR = args.has('--refresh-directory'); // re-pull sparkshift's state pages
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > -1 ? process.argv[i + 1] : null; })();
const STATE = (() => { const i = process.argv.indexOf('--state'); return i > -1 ? process.argv[i + 1].toUpperCase() : null; })();
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : 60; })();

loadEnv();
const CONTACT = process.env.SCRAPER_CONTACT || 'unknown';
const UA = `WhichLocal-discover/1.0 (+${CONTACT})`;
const RUN_TS = new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(CACHE_DIR, { recursive: true });

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };

/* ---------- fetch with a timeout + on-disk cache ------------------------ */

async function fetchText(url, cacheFile) {
  if (OFFLINE) {
    if (!existsSync(cacheFile)) throw new Error('--offline but nothing cached');
    return readFileSync(cacheFile, 'utf8');
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: ac.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const html = await res.text();
    writeFileSync(cacheFile, html);
    return html;
  } finally {
    clearTimeout(t);
  }
}

/* ---------- sparkshift.app: local number -> candidate website ----------- */

// Balanced-bracket slice of `s` starting right after a `"key":` position.
function sliceBalancedArray(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth += 1;
    else if (c === ']') { depth -= 1; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

// Next.js streams page data as `self.__next_f.push([1,"<json-escaped text>"])`
// chunks; one of them (for a /directory/union/locations/<state> page) embeds
// `"unions":[ {...}, ... ]` — the same array the page itself renders from.
function extractUnions(html) {
  const out = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html))) {
    let s;
    try { s = JSON.parse(`"${m[1]}"`); } catch { continue; }
    const i = s.indexOf('"unions":[');
    if (i < 0) continue;
    const arr = sliceBalancedArray(s, i + '"unions":'.length);
    if (!arr) continue;
    try { out.push(...JSON.parse(arr)); } catch { /* one malformed chunk isn't fatal */ }
  }
  return out;
}

/** slug (state code) -> full state name, e.g. "NC" -> "north-carolina". Reuse
 * the one state-name list already in the repo instead of keeping a second. */
function stateSlugMap() {
  const forums = readJson(THREADS, {}).forums || {};
  const map = {};
  for (const [code, fe] of Object.entries(forums)) {
    if (fe?.name) map[code] = fe.name.replace(/-job-calls$/, '');
  }
  return map;
}

async function sparkshiftLocalsForState(stateSlug) {
  const cacheFile = join(CACHE_DIR, `sparkshift-${stateSlug}.html`);
  if (!REFRESH_DIR && existsSync(cacheFile)) {
    return extractUnions(readFileSync(cacheFile, 'utf8'));
  }
  if (OFFLINE) {
    if (!existsSync(cacheFile)) return [];
    return extractUnions(readFileSync(cacheFile, 'utf8'));
  }
  try {
    const html = await fetchText(`https://sparkshift.app/directory/union/locations/${stateSlug}`, cacheFile);
    return extractUnions(html);
  } catch (e) {
    console.warn(`  sparkshift ${stateSlug}: ${e.message}`);
    return [];
  }
}

/* ---------- homepage -> candidate job-calls link ------------------------- */

const CANDIDATE_RE =
  /job[\s-]?board|job[\s-]?calls?|out[\s-]?of[\s-]?work|dispatch|referral|available[\s-]?jobs?|sign[\s-]?(?:the\s*)?book|line\s*calls?/i;

function findCandidateLinks(html, baseUrl) {
  const found = [];
  const re = /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const text = plain(m[2]);
    const hay = `${m[1]} ${text}`;
    if (!CANDIDATE_RE.test(hay)) continue;
    try { found.push(new URL(m[1], baseUrl).toString()); } catch { /* bad href, skip */ }
  }
  return [...new Set(found)];
}

/* ---------- classify a fetched page: public / gated / unclear ----------- */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—' };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (mm, name) => (name.toLowerCase() in NAMED ? NAMED[name.toLowerCase()] : mm));
}
const plain = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const HAS_PASSWORD_FIELD = /<input\b[^>]*type=["']password["']/i;
// An explicit "you're not logged in" message. This is the most reliable
// signal a system is gated — more reliable than a bare password field, since
// a genuinely public page can still have an unrelated login widget bolted on
// the side (e.g. "log in to bid" next to publicly-viewable listings).
const GATE_MESSAGE_RE =
  /you do not appear to be (?:listed|registered)|members? cannot view|you (?:are not|aren'?t|must be) (?:currently )?(?:logged|signed) in|please (?:log|sign) ?in to (?:view|continue)|login required/i;
// A count sitting right next to a classification code — the strongest signal
// a page is showing real listings, not just talking about dispatch in general.
const CALL_PATTERN = /\b\d{1,3}\s*[-–—]?\s*(?:x\s*)?(?:jw|cw|ce|jwt|jry\s*wrmn|journeyman|foreman|technician|wireman|lineman)\b/i;
const EMPTY_BUT_WORKING = /\bno\s+(?:open\s+)?(?:job\s*)?calls?\b|\bno\s+(?:open\s+)?jobs?\s+(?:at this time|posted|available)\b|\bnothing\s+(?:posted|available)\b/i;
// Weaker, individually-common words — a real dispatch table racks up several
// of these even when no single count-plus-classification pattern matches
// (e.g. a table with separate "Employer" / "Start Date" / "Positions" columns).
// A high bar, because a gated system's bid-submission FORM carries the same
// field-label vocabulary ("Employer", "Start Date", "Positions Requested")
// even with zero real listings behind it.
const HINT_RE = /\b(?:journeyman|foreman|technician|wireman|lineman|apprentice|jry\s*wrmn|dispatch|employer|contractor|book\s*1|positions?\s*(?:requested|filled)|start\s*date|request\s*date|call\s*type)\b/gi;
const HINT_THRESHOLD = 8;

function classify(html) {
  const text = plain(html);
  // Checked first and unconditionally: a system that tells you outright
  // you're logged out is gated no matter how form-label-shaped its stub page is.
  if (GATE_MESSAGE_RE.test(text)) return 'gated';
  const hintCount = (text.match(HINT_RE) || []).length;
  if (CALL_PATTERN.test(text) || EMPTY_BUT_WORKING.test(text) || hintCount >= HINT_THRESHOLD) return 'public';
  // A bare login form with nothing else on the page (no rejection message,
  // no table, no hint vocabulary) — e.g. a portal whose whole site IS the
  // login screen (ibew117.workingsystems.com).
  if (HAS_PASSWORD_FIELD.test(html)) return 'gated';
  return 'unclear';
}

function detectPlatform(html) {
  // Site-authoring CMS signals first — structural, near-zero false-positive
  // rate. workingsystems.com is checked last: it's often just a linked-to
  // member portal mentioned on an otherwise-ordinary WordPress/etc. site, so
  // treating it as top priority mislabels the site that's hosting the link.
  if (/unionactive/i.test(html)) return 'UnionActive';
  if (/website-files\.com/i.test(html)) return 'Webflow';
  if (/wp-content/i.test(html)) return 'WordPress';
  if (/Drupal\.settings|\/sites\/default\/files/i.test(html)) return 'Drupal';
  if (/cdn\.shopify/i.test(html)) return 'Shopify';
  if (/static1\.squarespace\.com/i.test(html)) return 'Squarespace';
  if (/wixstatic\.com/i.test(html)) return 'Wix';
  if (/workingsystems\.com/i.test(html)) return 'workingsystems.com (3rd-party dispatch SaaS)';
  return null;
}

/* ---------- run ----------------------------------------------------------- */

const config = readJson(CONFIG, {});
const stateSlugs = stateSlugMap();
const prevOut = readJson(OUT, { items: {} });
const items = { ...prevOut.items };

let entries = Object.entries(config).filter(([k, v]) => /^l\d/.test(k) && v && typeof v.local_no === 'number');
if (ONLY) entries = entries.filter(([slug]) => slug === ONLY);
if (STATE) entries = entries.filter(([slug]) => (slug.match(/-([a-z]{2})$/i) || [])[1]?.toUpperCase() === STATE);

// Group by state so each state's sparkshift page is fetched once, up front.
const byState = new Map();
for (const [slug, v] of entries) {
  const st = (slug.match(/-([a-z]{2})$/i) || [])[1]?.toUpperCase();
  if (!byState.has(st)) byState.set(st, []);
  byState.get(st).push([slug, v]);
}

let processed = 0;
let sparkshiftHits = 0;
const tally = {};

for (const [st, locals] of byState) {
  const stateSlug = stateSlugs[st];
  const directory = stateSlug ? await sparkshiftLocalsForState(stateSlug) : [];
  // The same local can appear more than once across a state page's data (a
  // fuller "verified" record plus a bare stub elsewhere) — keep whichever
  // copy actually has a website rather than letting the last one win blind.
  const byNo = new Map();
  for (const u of directory) {
    const no = parseInt(u.localNumber, 10);
    if (!Number.isFinite(no)) continue;
    const prev = byNo.get(no);
    if (!prev || (!prev.website && u.website)) byNo.set(no, u);
  }
  if (!OFFLINE && !existsSync(join(CACHE_DIR, `sparkshift-${stateSlug}.html`))) await sleep(400);

  for (const [slug, v] of locals) {
    if (processed >= LIMIT && !ONLY) { console.log(`Budget reached (${LIMIT}) — more next run.`); break; }
    const existing = items[slug];
    if (v.url) continue;                          // already a working scrape target — leave it alone
    if (existing && !REFRESH && existing.status !== 'unreachable') continue;

    const dirHit = byNo.get(v.local_no);
    let website = dirHit?.website || existing?.website || null;
    if (website) website = website.replace(/^http:/, 'https:').replace(/\/$/, '');
    if (dirHit) sparkshiftHits += 1;

    const entry = {
      local_no: v.local_no,
      city: dirHit?.city || null,
      state: st,
      website,
      job_calls_url: null,
      status: website ? 'unreachable' : 'no-website',
      platform: null,
      checked_at: RUN_TS,
      note: null,
    };

    if (website) {
      try {
        const home = await fetchText(website, join(CACHE_DIR, `home-${slug}.html`));
        entry.platform = detectPlatform(home);
        const candidates = findCandidateLinks(home, website);
        if (!candidates.length) {
          entry.status = 'none';
          entry.note = 'no job-calls-ish link in the homepage HTML (could be JS-rendered nav)';
        } else {
          entry.job_calls_url = candidates[0];
          if (candidates.length > 1) entry.note = `${candidates.length} candidate links found, checked the first`;
          const page = candidates[0] === website ? home : await fetchText(candidates[0], join(CACHE_DIR, `page-${slug}.html`));
          entry.status = classify(page);
          if (!entry.platform) entry.platform = detectPlatform(page);
        }
        await sleep(500);
      } catch (e) {
        entry.status = 'unreachable';
        entry.note = e.message;
      }
      processed += 1;
    }

    items[slug] = entry;
    tally[entry.status] = (tally[entry.status] || 0) + 1;
    writeFileSync(OUT, JSON.stringify({ generated_at: RUN_TS, source_note: 'website URLs looked up on sparkshift.app; not an IBEW-affiliated source', items }, null, 2) + '\n');
  }
  if (processed >= LIMIT && !ONLY) break;
}

const all = Object.values(items);
const finalTally = {};
for (const it of all) finalTally[it.status] = (finalTally[it.status] || 0) + 1;

console.log(`\nChecked ${processed} local(s) this run (${sparkshiftHits} had a sparkshift.app hit).`);
console.log(`Totals across ${all.length} resolved local(s):`);
for (const [status, n] of Object.entries(finalTally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${status.padEnd(12)} ${n}`);
}
console.log(`\nWrote ${OUT}.`);
