/**
 * Fast path for a manual correction: apply scripts/overrides.json straight to
 * the committed snapshot (js/data/locals.json) — no scrape, no PocketBase.
 *
 *   node scripts/apply-overrides.mjs             # rewrite the snapshot in place
 *   node scripts/apply-overrides.mjs --dry-run   # just print what would change
 *
 * Use this after editing overrides.json when you want the fix live now; the
 * daily scrape (scripts/export-snapshot.mjs) folds in the same corrections with
 * the identical merge rule, so the two stay consistent.
 *
 * Note: this can only touch locals already in the snapshot. To rescue a local
 * the geocoder missed (by supplying lat/lng in an override), run a full
 * `node scripts/scrape.mjs && node scripts/export-snapshot.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOverrides, resolveOverrides, mergeOverride } from './lib/overrides.mjs';
import { totalPackage } from './lib/derive.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = join(ROOT, 'js', 'data', 'locals.json');

const snapshot = JSON.parse(readFileSync(SNAP, 'utf8'));

// Resolve override keys (bare local numbers or slugs) against the snapshot rows.
// A key that matches nothing here may just be a geo-missed local (not in the
// snapshot) — a full scrape would place it. See the header note.
const { bySlug: overrides, issues } = resolveOverrides(loadOverrides(), snapshot.items);
issues.forEach((m) => console.warn(`  ${m}`));

let applied = 0;
const items = snapshot.items.map((rec) => {
  const override = overrides.get(rec.slug);

  let record = rec;
  if (override) {
    const res = mergeOverride(rec, override);
    record = res.record;
    if (res.applied.length) {
      applied++;
      console.log(`  ${rec.slug}: ${res.applied.map((f) => `${f} → ${record[f]}`).join(', ')}`);
    } else {
      console.warn(`  ${rec.slug}: no effect — safe to remove from overrides.json`);
    }
  }

  // Recompute total_package = sum of components (see lib/derive.mjs), including
  // any override just merged in. Idempotent for rows with no override — so it's
  // fine to run on every one. An explicit total_package override pins it.
  if (!(override && 'total_package' in override)) {
    const tp = totalPackage(record);
    if (tp !== null && tp !== record.total_package) {
      if (record === rec) record = { ...rec };
      record.total_package = tp;
    }
  }
  return record;
}).filter((r) => r.lat && r.lng);

if (DRY_RUN) {
  console.log(`--dry-run — ${applied} override(s) would apply. Snapshot not written.`);
  process.exit(0);
}

writeFileSync(
  SNAP,
  JSON.stringify(
    { ...snapshot, count: items.length, overrides_applied: applied, items },
    null,
    2,
  ) + '\n',
);

console.log(`Applied ${applied} override(s) → ${SNAP}`);
