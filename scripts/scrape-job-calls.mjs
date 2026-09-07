/**
 * Scrape the "job calls" / referral list a few IBEW locals publish on their own
 * websites, and write js/data/job-calls.json. Locals to scrape live in
 * scripts/job-calls.config.json (keyed by slug).
 *
 *   node scripts/scrape-job-calls.mjs                 # fetch every configured local
 *   node scripts/scrape-job-calls.mjs --only l606-orlando-fl
 *   node scripts/scrape-job-calls.mjs --offline       # re-parse the cached HTML
 *
 * Conduct: one request per local per run; the HTML is cached to scripts/cache/
 * so `--offline` re-runs never touch the sites. Identifies itself with a
 * descriptive User-Agent including SCRAPER_CONTACT.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './lib/pb.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'scripts', 'cache');
const CONFIG = join(ROOT, 'scripts', 'job-calls.config.json');
const OUT = join(ROOT, 'js', 'data', 'job-calls.json');

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

loadEnv();
const CONTACT = process.env.SCRAPER_CONTACT || 'unknown';
const UA = `WhichLocal-jobcalls/1.0 (+${CONTACT})`;

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

/**
 * Pull the job-call blocks out of a UnionActive "Job Calls" page. Each call is
 * its own <p> starting with a count, e.g. "10 Journeyman Wireman calls for …".
 */
function parseJobCalls(html) {
  // Narrow to the page-content region, ending before the standing referral policy.
  const start = html.search(/class=["']pageheader["']/i);
  const body = start >= 0 ? html.slice(start) : html;
  const cut = body.search(/last call was taken by/i);
  const region = cut > -1 ? body.slice(0, cut) : body;

  const flat = plain(region);
  const head = flat.match(/There (?:are|is)\s+(\d+|no|one)\s+job calls?/i);
  const total = head
    ? (/\d/.test(head[1]) ? parseInt(head[1], 10) : head[1].toLowerCase() === 'no' ? 0 : 1)
    : null;
  const posted = (flat.match(/\b([A-Z][a-z]+ \d{1,2},? \d{4})\b/) || [])[1] || null;

  const calls = [];
  for (const block of region.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []) {
    const t = plain(block);
    const m = t.match(/^(\d+)\s+(.+?)\s+calls?\s+for\b/i);
    if (!m) continue;
    calls.push({ count: parseInt(m[1], 10), classification: m[2].trim(), text: t });
  }

  return {
    posted,
    total: total ?? calls.reduce((a, c) => a + c.count, 0),
    count_sum: calls.reduce((a, c) => a + c.count, 0),
    calls,
  };
}

/* ---------- run ------------------------------------------------------- */

const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const entries = Object.entries(config).filter(([k]) => !k.startsWith('_'));

const out = { generated_at: new Date().toISOString(), locals: {} };
let ok = 0;
let failed = 0;

for (const [slug, { local_no, url }] of entries) {
  if (ONLY && slug !== ONLY) continue;
  try {
    const parsed = parseJobCalls(await getHtml(slug, url));
    out.locals[slug] = {
      local_no,
      url,
      scraped_at: new Date().toISOString(),
      ...parsed,
    };
    ok++;
    console.log(
      `${slug}: ${parsed.total} job calls (${parsed.calls.length} listings)` +
      `${parsed.total !== parsed.count_sum ? ` — header ${parsed.total} vs listed ${parsed.count_sum}` : ''}`,
    );
  } catch (e) {
    failed++;
    console.error(`${slug}: ${e.message}`);
  }
}

// Preserve locals not scraped this run (e.g. when using --only).
if (ONLY && existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    out.locals = { ...prev.locals, ...out.locals };
  } catch { /* rewrite from scratch */ }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${OUT} — ${Object.keys(out.locals).length} local(s), ${ok} ok, ${failed} failed.`);

if (failed && !ok) process.exit(1);
