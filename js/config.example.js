/**
 * Copy this file to `config.local.js` and fill in your values.
 * `config.local.js` is gitignored — for this build-step-free static site it is
 * the browser's runtime config (keep the CARTO key in sync with the root .env).
 */
export const config = {
  // CARTO basemap key. Empty = keyless tiles (which CARTO watermarks).
  cartoApiKey: '',

  // Where the frontend reads the scraped IBEW data from.
  pocketbaseUrl: 'http://127.0.0.1:8090',
};
