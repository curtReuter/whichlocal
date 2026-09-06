/**
 * Derived fields — computed from the scraped columns rather than taken from the
 * source table directly.
 *
 * `total_package` is recomputed for every local as a plain sum of its parts:
 *
 *   total_package = hourly_rate + defined_pension + contribution_pension
 *                 + k401 + vacation + hw + nebf_pension
 *
 * This runs after manual corrections are merged (scripts/overrides.json), so if
 * an override changes any component the package total moves with it instead of
 * keeping a now-stale scraped figure. An override that sets `total_package`
 * explicitly pins it and skips the recompute.
 *
 * NOTE: mirrored in js/dataSource.js (`totalPackage`) so the PocketBase-backed
 * local dev view matches the committed snapshot. Keep the two in sync.
 */

export const PACKAGE_COMPONENTS = [
  'hourly_rate',
  'defined_pension',
  'contribution_pension',
  'k401',
  'vacation',
  'hw',
  'nebf_pension',
];

/**
 * @param {object} rec  a local record with the scraped numeric fields
 * @returns {number|null} the summed total_package, or null when there is no
 *   hourly_rate to build on (callers keep the scraped value in that case).
 */
export function totalPackage(rec) {
  if (typeof rec.hourly_rate !== 'number' || rec.hourly_rate === 0) return null;

  let sum = 0;
  for (const f of PACKAGE_COMPONENTS) {
    if (typeof rec[f] === 'number') sum += rec[f];
  }
  return Math.round(sum * 100) / 100;
}
