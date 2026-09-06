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
  if (!override) return rec;

  const { record, applied: changed } = mergeOverride(rec, override);
  if (changed.length) {
    applied++;
    console.log(`  ${rec.slug}: ${changed.map((f) => `${f} → ${record[f]}`).join(', ')}`);
  } else {
    console.warn(`  ${rec.slug}: no effect — safe to remove from overrides.json`);
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
