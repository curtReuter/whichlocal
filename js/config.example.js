/**
 * Optional local overrides. Copy this file to `config.local.js` (gitignored) to
 * point the frontend at a live PocketBase during development. If it's absent,
 * the app falls back to the committed `js/config.js` (snapshot mode).
 */
export const config = {
  // CARTO basemap key. Empty = keyless tiles (which CARTO watermarks).
  cartoApiKey: '',

  // Where the frontend reads the scraped IBEW data from.
  //   'http://127.0.0.1:8090'  → a live PocketBase (local dev)
  //   ''                       → js/data/locals.json, the daily snapshot the
  //                              GitHub Action commits (used on static hosts,
  //                              which is why the deployed site needs no config)
  pocketbaseUrl: 'http://127.0.0.1:8090',

  // Web3Forms access key for the "Edit Data" / "Add Job Call" forms. Empty here
  // hides the buttons in local dev; the deployed key lives in js/config.js.
  web3formsKey: '',
};
