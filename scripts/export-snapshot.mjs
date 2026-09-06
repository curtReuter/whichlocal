/**
 * Export the `locals` collection to a static JSON snapshot the frontend can
 * read without a running PocketBase — this is what makes the site deployable to
 * any plain static host (GitHub Pages, Netlify, Vercel, Cloudflare Pages).
 *
 * The daily GitHub Actions workflow (.github/workflows/scrape.yml) runs this
 * right after `scrape.mjs` and commits the result. Run it by hand any time:
 *
 *   node scripts/export-snapshot.mjs            # PB_URL or http://127.0.0.1:8090
 *   PB_URL=http://127.0.0.1:8090 node scripts/export-snapshot.mjs
 *
 * The file mirrors the exact query `js/dataSource.js` uses against PocketBase
 * (all locals, sorted by local_no, geo-miss rows dropped) so the two data
 * paths stay interchangeable.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'js', 'data', 'locals.json');

const base = (process.env.PB_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
const url =
  `${base}/api/collections/locals/records` +
  `?perPage=500&skipTotal=1&sort=local_no` +
  `&filter=${encodeURIComponent('lat != 0 && lng != 0')}`;

let res;
try {
  res = await fetch(url);
} catch (e) {
  throw new Error(`Cannot reach PocketBase at ${base} — is \`pb/pocketbase serve\` running? (${e.message})`);
}
if (!res.ok) {
  throw new Error(`PocketBase returned ${res.status} for the locals collection.`);
}

const { items = [] } = await res.json();

// Keep PocketBase's order (the query already sorts by local_no) so this file
// matches the live API path row-for-row. Drop bookkeeping fields plus `raw`
// (original scraped cell strings — kept in the DB for debugging, never read by
// the frontend, and about half the payload).
const clean = items.map(({ collectionId, collectionName, raw, ...rec }) => rec);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ generated_at: new Date().toISOString(), count: clean.length, items: clean }, null, 2) + '\n',
);

console.log(`Wrote ${OUT} — ${clean.length} locals.`);
