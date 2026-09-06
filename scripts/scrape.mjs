/**
 * Scrape IBEW electrician local-union wage scales from unionpayscales.com,
 * geocode each local's city, and upsert the rows into the PocketBase `locals`
 * collection.
 *
 *   node scripts/scrape.mjs                # fetch live, geocode, write to PB
 *   node scripts/scrape.mjs --offline      # reuse the cached HTML
 *   node scripts/scrape.mjs --dry-run      # parse + geocode, print, no writes
 *   node scripts/scrape.mjs --limit 20     # only the first 20 locals
 *
 * Conduct: one request per run; the HTML is cached to scripts/cache/ so
 * re-runs can use --offline. Nominatim is throttled to 1 req/sec with a cache.
 * You are responsible for complying with unionpayscales.com's Terms of Use.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, pbAuth, pbFetch, ROOT } from './lib/pb.mjs';

const SOURCE_URL = 'https://unionpayscales.com/trades/ibew-electricians/';
const CACHE_DIR = join(ROOT, 'scripts', 'cache');
const HTML_CACHE = join(CACHE_DIR, 'ibew-electricians.html');
const GEOCACHE = join(CACHE_DIR, 'geocache.json');

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const DRY_RUN = args.has('--dry-run');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();

loadEnv();
const CONTACT = process.env.SCRAPER_CONTACT || 'unknown';
const UA = `WhichLocal-scraper/1.0 (+${CONTACT})`;

mkdirSync(CACHE_DIR, { recursive: true });

/* ---------- fetch / cache the page -------------------------------------- */

async function getHtml() {
  if (OFFLINE) {
    if (!existsSync(HTML_CACHE)) throw new Error(`--offline but no cache at ${HTML_CACHE}`);
    console.log(`Using cached HTML (${HTML_CACHE})`);
    return readFileSync(HTML_CACHE, 'utf8');
  }
  console.log(`Fetching ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
  if (!res.ok) throw new Error(`Source fetch failed: ${res.status} ${res.statusText}`);
  const html = await res.text();
  writeFileSync(HTML_CACHE, html);
  console.log(`Cached HTML → ${HTML_CACHE} (${html.length} bytes)`);
  return html;
}

/* ---------- parse the TablePress table -------------------------------------- */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => (name.toLowerCase() in NAMED ? NAMED[name.toLowerCase()] : m));
}
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function parseTable(html) {
  const table = html.match(/<table id="tablepress-20"[\s\S]*?<\/table>/);
  if (!table) throw new Error('table#tablepress-20 not found in HTML');
  const trs = table[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const rows = [];
  for (const tr of trs) {
    if (!/<td/.test(tr)) continue; // skip header
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 17) continue;
    const cells = tds.map(stripTags);
    const wageSheetHref = (tds[16].match(/href="([^"]+)"/) || [])[1] || null;
    rows.push({ cells, wageSheetHref });
  }
  return rows;
}

/* ---------- value normalisers -------------------------------------------- */

const firstNumber = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
};
const money = firstNumber; // "$98,580.00" -> 98580 ; "$9.60 DEDUCT" -> 9.6 ; "-" -> null
const pct = firstNumber; // "83%" -> 83 ; "3.00%" -> 3 ; "" -> null

function slugify(...parts) {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function toRecord({ cells, wageSheetHref }) {
  const [
    localNo, city, state, yearly, hourly, total, col, adjusted,
    defined, contribution, k401, vacation, hw, nebf, dues, updated /* , wageSheet */,
  ] = cells;

  return {
    slug: slugify('l' + localNo, city, state),
    local_no: firstNumber(localNo),
    city,
    state,
    yearly_salary: money(yearly),
    hourly_rate: money(hourly),
    total_package: money(total),
    col_pct: pct(col),
    adjusted_base_wage: money(adjusted),
    defined_pension: money(defined),
    contribution_pension: money(contribution),
    k401: money(k401),
    vacation: money(vacation),
    hw: money(hw),
    nebf_pension: money(nebf),
    dues: pct(dues),
    wage_sheet_url:
      wageSheetHref && /^https?:\/\//.test(wageSheetHref)
        ? wageSheetHref.trim().replace(/ /g, '%20')
        : null,
    source_updated: updated || '',
    raw: { cells },
  };
}

/* ---------- geocoding (Nominatim + cache) -------------------------------- */

const CA_PROV = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);
const normState = (s) => {
  let v = (s || '').trim();
  if (/^ont\.?$/i.test(v)) v = 'ON';
  if (v.includes('/')) v = v.split('/')[0].trim(); // "IA / IL" -> "IA"
  return v;
};

let geocache = {};
if (existsSync(GEOCACHE)) {
  try { geocache = JSON.parse(readFileSync(GEOCACHE, 'utf8')); } catch { geocache = {}; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let geoNetCalls = 0;

// hand fixes for city strings that no amount of cleaning will geocode
const CITY_FIXES = {
  Waukengan: 'Waukegan',
  'San Bernadino Zone A': 'San Bernardino',
  'San Bernadino Zone B': 'San Bernardino',
  'Gary Hammonds': 'Gary',
};

// strip qualifiers that trip up Nominatim: "A / B" -> "A", drop "(...)",
// trailing " Zone"/" Metro"/" Area"/" County", collapse whitespace
function cleanCity(city) {
  if (CITY_FIXES[city]) return CITY_FIXES[city];
  return city
    .split(/[/(]/)[0]
    .replace(/\b(metro zone|metro|zone|area|county group|county|district)\b/gi, '')
    .replace(/\b[a-z]$/i, '') // trailing lone letter, e.g. "... Zone A"
    .replace(/\s+/g, ' ')
    .trim();
}

async function nominatim(q) {
  if (geoNetCalls > 0) await sleep(1100); // Nominatim usage policy: <= 1 req/sec
  geoNetCalls++;
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`,
      { headers: { 'User-Agent': UA } },
    );
    if (!res.ok) return null;
    const arr = await res.json();
    return arr[0] ? { lat: +(+arr[0].lat).toFixed(5), lng: +(+arr[0].lon).toFixed(5) } : null;
  } catch (e) {
    console.warn(`  geocode error for "${q}": ${e.message}`);
    return null;
  }
}

async function geocode(city, rawState) {
  const state = normState(rawState);
  const key = `${city}|${state}`;
  if (key in geocache) return geocache[key];

  const country = CA_PROV.has(state.toUpperCase()) ? 'Canada' : 'USA';
  const cleaned = cleanCity(city);
  const queries = [`${city}, ${state}, ${country}`];
  if (cleaned && cleaned !== city) queries.push(`${cleaned}, ${state}, ${country}`);

  let hit = { lat: null, lng: null };
  for (const q of queries) {
    const r = await nominatim(q);
    if (r) { hit = r; break; }
  }
  geocache[key] = hit;
  writeFileSync(GEOCACHE, JSON.stringify(sortObj(geocache), null, 2) + '\n');
  return hit;
}
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/* ---------- upsert into PocketBase -------------------------------------- */

async function upsert(ctx, rec) {
  const found = await pbFetch(
    ctx,
    `/api/collections/locals/records?perPage=1&skipTotal=1&filter=${encodeURIComponent(`slug='${rec.slug}'`)}`,
  );
  const body = JSON.stringify({ ...rec, scraped_at: new Date().toISOString() });
  if (found.items?.[0]) {
    await pbFetch(ctx, `/api/collections/locals/records/${found.items[0].id}`, { method: 'PATCH', body });
    return 'updated';
  }
  await pbFetch(ctx, '/api/collections/locals/records', { method: 'POST', body });
  return 'created';
}

/* ---------- run --------------------------------------------------------- */

const html = await getHtml();
let rows = parseTable(html).map(toRecord);
const before = rows.length;

// drop the "Average Of All Cities" summary row (local #0, no state)
rows = rows.filter((r) => r.local_no !== 0 && r.state);
if (Number.isFinite(LIMIT)) rows = rows.slice(0, LIMIT);
console.log(`Parsed ${before} rows → ${rows.length} locals to process`);

let geoHit = 0;
let geoMiss = 0;
for (const r of rows) {
  const { lat, lng } = await geocode(r.city, r.state);
  r.lat = lat;
  r.lng = lng;
  if (lat == null) { geoMiss++; console.warn(`  no coords: Local ${r.local_no} — ${r.city}, ${r.state}`); }
  else geoHit++;
}
console.log(`Geocoded: ${geoHit} hit, ${geoMiss} miss (${geoNetCalls} live Nominatim calls)`);

if (DRY_RUN) {
  console.log('--dry-run — not writing to PocketBase. Sample:');
  console.dir(rows.slice(0, 3), { depth: null });
  console.log(`Would upsert ${rows.length} records.`);
  process.exit(0);
}

const ctx = await pbAuth();
const tally = { created: 0, updated: 0, failed: 0 };
for (const r of rows) {
  try {
    tally[await upsert(ctx, r)]++;
  } catch (e) {
    tally.failed++;
    console.error(`  upsert failed for ${r.slug}: ${e.message}`);
  }
}
console.log(
  `Done. created ${tally.created}, updated ${tally.updated}, failed ${tally.failed}, ` +
  `geo-miss ${geoMiss} (stored without coords, hidden from the map).`,
);
