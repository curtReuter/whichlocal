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
 * Manual corrections from scripts/overrides.json are folded in here (see
 * scripts/lib/overrides.mjs), then geo-miss rows are dropped — so the snapshot
 * matches what js/dataSource.js expects.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOverrides, resolveOverrides, mergeOverride } from './lib/overrides.mjs';
import { totalPackage } from './lib/derive.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'js', 'data', 'locals.json');

// Emit fields in a fixed order so the snapshot diff stays minimal regardless of
// how the PocketBase REST API orders record keys. Omitted on purpose: `raw` and
// `collection*` (bookkeeping), and PocketBase's `id` / `scraped_at` — both are
// per-instance/per-run values the frontend never reads (it keys off `slug`), so
// keeping them would churn the file on every scrape even when nothing changed.
const FIELD_ORDER = [
  'slug', 'local_no', 'city', 'state', 'lat', 'lng',
  'yearly_salary', 'hourly_rate', 'total_package', 'col_pct', 'adjusted_base_wage',
  'defined_pension', 'contribution_pension', 'k401', 'vacation', 'hw', 'nebf_pension', 'dues',
  'wage_sheet_url', 'source_updated',
];

const shape = (rec) => {
  const out = {};
  for (const k of FIELD_ORDER) if (k in rec) out[k] = rec[k];
  return out;
};

const base = (process.env.PB_URL || 'http://127.0.0.1:8090').replace(/\/$/, '');
// Fetch every row (no lat/lng filter): an override may supply coordinates for a
// local the geocoder missed. We filter after merging.
const url = `${base}/api/collections/locals/records?perPage=500&skipTotal=1&sort=local_no`;

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

// `shape()` narrows each record to the frontend fields in a fixed order (drops
// `raw` etc.), keeping PocketBase's local_no sort order.
const shaped = items.map(shape);

// Resolve override keys (bare local numbers or slugs) against the real records,
// then fold each correction in.
const { bySlug: overrides, issues } = resolveOverrides(loadOverrides(), shaped);
issues.forEach((m) => console.warn(`  ${m}`));

let overridesApplied = 0;
const merged = shaped.map((rec) => {
  const override = overrides.get(rec.slug);

  let record = rec;
  if (override) {
    const res2 = mergeOverride(rec, override);
    record = res2.record;
    if (res2.applied.length) {
      overridesApplied++;
      console.log(`  override ${rec.slug}: ${res2.applied.join(', ')}`);
    } else {
      console.warn(`  override ${rec.slug}: no effect — the scrape already matches or exceeds it; safe to remove`);
    }
  }

  // Recompute total_package as the sum of its components (see lib/derive.mjs),
  // now including any override just merged in. An override that sets
  // total_package explicitly pins it. `total_package` is already a key on the
  // record, so assign in place to keep the field order stable.
  if (!(override && 'total_package' in override)) {
    const tp = totalPackage(record);
    if (tp !== null) record.total_package = tp;
  }
  return record;
});

const clean = merged.filter((r) => r.lat && r.lng);
const dropped = merged.length - clean.length;

mkdirSync(dirname(OUT), { recursive: true });
// No timestamp field: the file should change only when the data does, so the
// daily workflow's "nothing changed" check is meaningful. Git history is the
// record of when each refresh landed.
writeFileSync(
  OUT,
  JSON.stringify(
    { count: clean.length, overrides_applied: overridesApplied, items: clean },
    null,
    2,
  ) + '\n',
);

console.log(
  `Wrote ${OUT} — ${clean.length} locals` +
  `${overridesApplied ? `, ${overridesApplied} corrected` : ''}` +
  `${dropped ? `, ${dropped} without coords dropped` : ''}.`,
);
