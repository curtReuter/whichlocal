/**
 * Build js/data/locals-roster.json — every active IBEW local union on record
 * with the US DOL's OLMS (Office of Labor-Management Standards) Online Public
 * Disclosure Room. The site shows locals that aren't in the wage data
 * (js/data/locals.json) as small grey dots on the map, so every local can at
 * least be found.
 *
 *   node scripts/scrape-ibew-roster.mjs             # fetch, geocode, write
 *   node scripts/scrape-ibew-roster.mjs --offline   # reuse the cached OLMS pull
 *   node scripts/scrape-ibew-roster.mjs --limit 40  # geocode only the first N new cities
 *
 * OLMS lists every union that files an LM report; we keep affAbbr === 'IBEW',
 * designation "LOCAL UNION", not terminated, newest filing per local. This is a
 * US registry — it has no Canadian locals, so the handful of Canadian locals in
 * the wage data are unaffected.
 *
 * olmsapps.dol.gov serves an incomplete TLS chain that Node's fetch rejects, so
 * the OLMS calls shell out to `curl` (present on every CI runner and macOS).
 * Geocoding reuses scripts/cache/geocache.json and the same 1 req/s Nominatim
 * throttle as scripts/scrape.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, 'scripts', 'cache');
const OLMS_CACHE = join(CACHE_DIR, 'olms-filers.json');
const GEOCACHE = join(CACHE_DIR, 'geocache.json');
const OUT = join(ROOT, 'js', 'data', 'locals-roster.json');
const WAGE = join(ROOT, 'js', 'data', 'locals.json');

const args = new Set(process.argv.slice(2));
const OFFLINE = args.has('--offline');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
})();

const CONTACT = process.env.SCRAPER_CONTACT || 'unknown';
const UA = `WhichLocal-roster/1.0 (+${CONTACT})`;
const RUN_TS = new Date().toISOString();

mkdirSync(CACHE_DIR, { recursive: true });

/* ---------- OLMS Online Public Disclosure Room ------------------------- */

const OLMS_URL = 'https://olmsapps.dol.gov/olpdr/GetFilerListServlet';

// Node's fetch won't verify olmsapps.dol.gov's (incomplete) chain; curl will.
function curlPost(url, fields) {
  const data = fields.flatMap(([k, v]) => ['--data-urlencode', `${k}=${v}`]);
  const out = execFileSync(
    'curl',
    ['-sS', '--fail', '--compressed', '-m', '120', '-A', UA,
      '-X', 'POST', url,
      '-H', 'Content-Type: application/x-www-form-urlencoded;charset=utf-8',
      ...data],
    { maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' },
  );
  return JSON.parse(out);
}

/** Pull the whole filer list (all unions), paging until we have them all. */
function fetchAllFilers() {
  if (OFFLINE) {
    if (!existsSync(OLMS_CACHE)) throw new Error(`--offline but no cache at ${OLMS_CACHE}`);
    return JSON.parse(readFileSync(OLMS_CACHE, 'utf8'));
  }
  let all = [];
  let total = Infinity;
  for (let page = 1; page <= 20 && all.length < total; page += 1) {
    const j = curlPost(OLMS_URL, [['clearCache', 'F'], ['page', String(page)]]);
    total = j.totalRecords ?? all.length;
    const list = j.filerList || [];
    if (!list.length) break;
    all = all.concat(list);
    console.log(`  OLMS page ${page}: +${list.length} (${all.length}/${total})`);
  }
  writeFileSync(OLMS_CACHE, JSON.stringify(all));
  return all;
}

/** IBEW local unions, newest filing per local, still active. */
function ibewLocals(filers) {
  const byFnum = new Map();
  for (const r of filers) {
    if (r.affAbbr !== 'IBEW') continue;
    if (String(r.desigName || '').trim() !== 'LOCAL UNION') continue;
    if (r.terminated === 'T' || r.termDate) continue;
    const no = parseInt(r.desigNum, 10);
    if (!Number.isFinite(no)) continue;
    const prev = byFnum.get(r.fNum);
    if (!prev || (r.yrCovered || 0) > (prev.yrCovered || 0)) byFnum.set(r.fNum, r);
  }
  const seenNo = new Set();
  return [...byFnum.values()]
    .map((r) => ({ local_no: parseInt(r.desigNum, 10), city: titleCase(r.city), state: String(r.state || '').trim().toUpperCase() }))
    .filter((r) => r.state && !seenNo.has(r.local_no) && seenNo.add(r.local_no))
    .sort((a, b) => a.local_no - b.local_no);
}

const titleCase = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/\bMc([a-z])/g, (_, c) => 'Mc' + c.toUpperCase())
    .trim();

/* ---------- geocoding (Nominatim + shared cache) --------------------- */
/* kept in sync with scripts/scrape.mjs */

const CA_PROV = new Set(['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT']);
const CITY_FIXES = {
  Waukengan: 'Waukegan',
  'San Bernadino Zone A': 'San Bernardino',
  'San Bernadino Zone B': 'San Bernardino',
  'Gary Hammonds': 'Gary',
};
function cleanCity(city) {
  if (CITY_FIXES[city]) return CITY_FIXES[city];
  return city
    .split(/[/(]/)[0]
    .replace(/\b(metro zone|metro|zone|area|county group|county|district)\b/gi, '')
    .replace(/\b[a-z]$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

let geocache = {};
if (existsSync(GEOCACHE)) {
  try { geocache = JSON.parse(readFileSync(GEOCACHE, 'utf8')); } catch { geocache = {}; }
}
const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let geoNetCalls = 0;

async function nominatim(q) {
  if (geoNetCalls > 0) await sleep(1100); // <= 1 req/sec
  geoNetCalls += 1;
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

async function geocode(city, state) {
  const key = `${city}|${state}`;
  if (key in geocache) return geocache[key];

  const country = CA_PROV.has(state) ? 'Canada' : 'USA';
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

function slugify(...parts) {
  return parts
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/* ---------- run ------------------------------------------------------- */

const filers = fetchAllFilers();
const roster = ibewLocals(filers);
console.log(`IBEW local unions on the OLMS register: ${roster.length}`);

const wageNos = new Set(
  (JSON.parse(readFileSync(WAGE, 'utf8')).items || []).map((i) => i.local_no),
);
const needGeo = roster.filter((r) => !(`${r.city}|${r.state}` in geocache));
console.log(`${needGeo.length} cities need geocoding (${roster.length - needGeo.length} already cached)`);

let done = 0;
let miss = 0;
for (const r of roster) {
  if (done >= LIMIT && !(`${r.city}|${r.state}` in geocache)) continue;
  const { lat, lng } = await geocode(r.city, r.state);
  r.lat = lat;
  r.lng = lng;
  r.slug = slugify('l' + r.local_no, r.city, r.state);
  if (lat == null) miss += 1;
  done += 1;
}

const placed = roster.filter((r) => r.lat != null);
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generated_at: RUN_TS,
      source: 'US DOL OLMS Online Public Disclosure Room',
      count: placed.length,
      items: placed.map((r) => ({
        local_no: r.local_no,
        city: r.city,
        state: r.state,
        slug: r.slug,
        lat: r.lat,
        lng: r.lng,
      })),
    },
    null,
    2,
  ) + '\n',
);

const newOnMap = placed.filter((r) => !wageNos.has(r.local_no)).length;
console.log(
  `Wrote ${OUT}: ${placed.length} placed (${miss} geo-miss dropped). ` +
  `${newOnMap} of them have no wage data — those become grey dots. ` +
  `${geoNetCalls} live Nominatim calls.`,
);
