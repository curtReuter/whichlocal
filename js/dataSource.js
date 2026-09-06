/**
 * Loads the IBEW locals and reshapes each record into the
 * `{ id, name, subtitle, lat, lng, values{} }` shape the rest of the app
 * (main.js → cityMap.js) already expects.
 *
 * Two interchangeable sources, chosen by whether a PocketBase URL is configured
 * (js/config.local.js → config.pocketbaseUrl):
 *
 *   • a running PocketBase   — local dev: ./pb/pocketbase serve + node scripts/scrape.mjs
 *   • js/data/locals.json    — the daily snapshot committed by the GitHub Action;
 *                              lets the site deploy to any static host with no backend.
 *
 * `scripts/export-snapshot.mjs` writes the snapshot from the same query used
 * here; the two match, except the snapshot also has any manual corrections from
 * scripts/overrides.json folded in.
 */

const VALUE_FIELDS = [
  'total_package', 'hourly_rate', 'yearly_salary', 'col_pct',
  'defined_pension', 'contribution_pension', 'k401', 'vacation',
  'hw', 'nebf_pension', 'dues',
];

export async function loadLocals(pbUrl = '') {
  const base = String(pbUrl || '').trim().replace(/\/$/, '');
  const items = /^https?:\/\//i.test(base)
    ? await loadFromPocketBase(base)
    : await loadFromSnapshot();

  // PocketBase number fields default to 0 (not null), so geo-miss rows sit at
  // (0, 0) — exclude them here too in case the snapshot wasn't pre-filtered.
  return items
    .filter((r) => r.lat && r.lng)
    .map((r) => {
      // PocketBase returns 0 for unset number fields; treat 0 as "no data" for
      // these wage/benefit metrics (none are legitimately zero).
      const values = {};
      for (const f of VALUE_FIELDS) {
        if (typeof r[f] === 'number' && r[f] !== 0) values[f] = r[f];
      }
      return {
        id: r.slug,
        name: `IBEW Local ${r.local_no}`,
        subtitle: [r.city, r.state].filter(Boolean).join(', '),
        lat: r.lat,
        lng: r.lng,
        values,
        wageSheetUrl: r.wage_sheet_url || null,
        sourceUpdated: r.source_updated || null,
      };
    });
}

async function loadFromPocketBase(base) {
  const url =
    `${base}/api/collections/locals/records` +
    `?perPage=500&skipTotal=1&sort=local_no&filter=${encodeURIComponent('lat != 0 && lng != 0')}`;

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`Can't reach PocketBase at ${base} — is \`./pb/pocketbase serve\` running? (${e.message})`);
  }
  if (!res.ok) {
    throw new Error(`PocketBase returned ${res.status} for the locals collection.`);
  }
  const { items = [] } = await res.json();
  return items;
}

async function loadFromSnapshot() {
  // Resolve relative to this module so it works from any deploy path.
  const url = new URL('data/locals.json', import.meta.url);

  let res;
  try {
    // `no-cache` = always revalidate with the server (conditional request, 304
    // when unchanged) rather than trusting GitHub Pages' 10-minute max-age. Lets
    // a fresh scrape/correction show on a normal reload, not just a hard one.
    res = await fetch(url, { cache: 'no-cache' });
  } catch (e) {
    throw new Error(`Couldn't load the data snapshot at ${url} (${e.message}).`);
  }
  if (!res.ok) {
    throw new Error(
      `Data snapshot returned ${res.status} — the daily scrape may not have run yet.`,
    );
  }
  const { items = [] } = await res.json();
  return items;
}
