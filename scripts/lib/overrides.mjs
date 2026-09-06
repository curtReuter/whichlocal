/**
 * Manual data corrections.
 *
 * `scripts/overrides.json` holds hand-entered fixes keyed by local `slug`
 * (e.g. "l1-st-louis-mo" — the `id` shown in the ranked list). Use it when a
 * user reports that the scraped data is stale or wrong.
 *
 * Merge rule (see `mergeOverride`):
 *   • Wage / benefit numbers  — your value is kept UNLESS a fresh scrape finds a
 *     strictly higher number, in which case the scrape wins. List a field in
 *     "force" to always keep your value regardless.
 *   • Everything else (city, state, lat, lng, wage_sheet_url, source_updated,
 *     local_no) — your value always wins when present.
 *
 * Both `scripts/export-snapshot.mjs` (daily scrape) and
 * `scripts/apply-overrides.mjs` (fast path) call `mergeOverride`, so the two
 * always agree.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const OVERRIDES_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'overrides.json',
);

// Numeric metrics a re-scrape may legitimately revise upward.
export const HIGHER_WINS_FIELDS = new Set([
  'yearly_salary', 'hourly_rate', 'total_package', 'col_pct', 'adjusted_base_wage',
  'defined_pension', 'contribution_pension', 'k401', 'vacation', 'hw',
  'nebf_pension', 'dues',
]);

// Keys inside an override entry that are notes, not data.
const META_KEYS = new Set(['force', 'note', 'source', 'reported', 'date']);

/**
 * Read scripts/overrides.json → { [slug]: overrideEntry }. Missing file → {}.
 * Keys starting with "_" (e.g. "__doc__") are treated as documentation and
 * skipped. Throws on malformed JSON so a typo can't silently drop corrections.
 */
export function loadOverrides() {
  let text;
  try {
    text = readFileSync(OVERRIDES_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`scripts/overrides.json is not valid JSON: ${e.message}`);
  }
  const out = {};
  for (const [slug, entry] of Object.entries(parsed)) {
    if (slug.startsWith('_')) continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[slug] = entry;
  }
  return out;
}

/**
 * Apply one override entry to one record.
 * @returns {{ record: object, applied: string[] }} — `applied` lists the fields
 *   that actually changed (empty means the override had no effect and can be
 *   removed from overrides.json).
 */
export function mergeOverride(record, override) {
  if (!override) return { record, applied: [] };

  const force = new Set(Array.isArray(override.force) ? override.force : []);
  const out = { ...record };
  const applied = [];

  for (const [field, manualVal] of Object.entries(override)) {
    if (META_KEYS.has(field)) continue;
    if (manualVal === null || manualVal === undefined) continue;

    const higherWins =
      typeof manualVal === 'number' &&
      HIGHER_WINS_FIELDS.has(field) &&
      !force.has(field);

    let next = manualVal;
    if (higherWins) {
      const current = record[field];
      if (typeof current === 'number' && current > manualVal) next = current;
    }

    if (next !== record[field]) applied.push(field);
    out[field] = next;
  }

  return { record: out, applied };
}
