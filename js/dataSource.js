/**
 * Loads the IBEW locals from PocketBase and reshapes each record into the
 * `{ id, name, subtitle, lat, lng, values{} }` shape the rest of the app
 * (main.js → cityMap.js) already expects.
 *
 * PocketBase must be running:  ./pb/pocketbase serve
 * and populated:               node scripts/scrape.mjs
 */

const VALUE_FIELDS = [
  'total_package', 'hourly_rate', 'yearly_salary', 'col_pct',
  'defined_pension', 'contribution_pension', 'k401', 'vacation',
  'hw', 'nebf_pension', 'dues',
];

export async function loadLocals(pbUrl = 'http://127.0.0.1:8090') {
  const base = pbUrl.replace(/\/$/, '');
  // PocketBase number fields default to 0 (not null), so geo-miss rows sit at
  // (0, 0) — exclude them with `lat != 0`.
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

  return items.map((r) => {
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
