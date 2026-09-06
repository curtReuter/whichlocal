/**
 * Manual data corrections.
 *
 * `scripts/overrides.json` holds hand-entered fixes. Each key identifies a local
 * either by its bare local number ("606") or, when a number is shared by more
 * than one row, by `slug` ("l26-roanoke-va" — the `id` shown in the ranked
 * list). `resolveOverrides` maps numbers to slugs and reports any that are
 * ambiguous or unknown. Use this when a user reports stale or wrong data.
 *
 * Merge rule (see `mergeOverride`):
 *   • Wage / benefit numbers  — your value is kept UNLESS a fresh scrape finds a
 *     strictly higher number, in which case the scrape wins. List a field in
 *     "force" to always keep your value regardless.
 *   • Everything else (city, state, lat, lng, wage_sheet_url, source_updated,
 *     local_no) — your value always wins when present.
 *
 * Both `scripts/export-snapshot.mjs` (daily scrape) and
 * `scripts/apply-overrides.mjs` (fast path) resolve then `mergeOverride`, so the
 * two always agree.
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
 * Read scripts/overrides.json → { [key]: overrideEntry }, where `key` is a bare
 * local number ("606") or a slug ("l26-roanoke-va"). Missing file → {}. Keys
 * starting with "_" (e.g. "__doc__") are documentation and skipped. Throws on
 * malformed JSON so a typo can't silently drop corrections.
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
  for (const [key, entry] of Object.entries(parsed)) {
    if (key.startsWith('_')) continue;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[key] = entry;
  }
  return out;
}

/**
 * Map override keys (bare local numbers or slugs) onto the actual records.
 * @param {Record<string, object>} overrides  from `loadOverrides()`
 * @param {Array<{slug: string, local_no: number}>} records
 * @returns {{ bySlug: Map<string, object>, issues: string[] }}
 *   `bySlug` is ready to apply; `issues` are human-readable problems (an unknown
 *   key, or a local number shared by several rows).
 */
export function resolveOverrides(overrides, records) {
  const slugSet = new Set(records.map((r) => r.slug));
  const slugsByNo = new Map(); // "26" -> ["l26-...-dc", "l26-roanoke-va"]
  for (const r of records) {
    const k = String(r.local_no);
    if (!slugsByNo.has(k)) slugsByNo.set(k, []);
    slugsByNo.get(k).push(r.slug);
  }

  const bySlug = new Map();
  const issues = [];
  const claim = (slug, key) => {
    if (bySlug.has(slug)) {
      issues.push(`override "${key}": ${slug} is already targeted by another entry`);
    } else {
      bySlug.set(slug, overrides[key]);
    }
  };

  for (const key of Object.keys(overrides)) {
    if (/^\d+$/.test(key)) {
      const slugs = slugsByNo.get(String(Number(key))) || [];
      if (slugs.length === 0) {
        issues.push(`override "${key}": no local has number ${key}`);
      } else if (slugs.length > 1) {
        issues.push(
          `override "${key}": local number ${key} is shared by ${slugs.length} rows ` +
          `— use one of these slugs instead: ${slugs.join(', ')}`,
        );
      } else {
        claim(slugs[0], key);
      }
    } else if (!slugSet.has(key)) {
      issues.push(`override "${key}": no local with this slug — check for a typo`);
    } else {
      claim(key, key);
    }
  }
  return { bySlug, issues };
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
