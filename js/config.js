/**
 * Committed runtime config for the deployed (static) site.
 *
 * `cartoApiKey` is a *publishable* client key — it ends up in every basemap tile
 * URL the browser requests, so it cannot be secret. Don't hide it; instead
 * restrict it to your site's domain in the CARTO dashboard (allowed origins /
 * referrers) so a copied key is useless elsewhere.
 *
 * `pocketbaseUrl: ''` makes js/dataSource.js read js/data/locals.json (the daily
 * snapshot committed by .github/workflows/scrape.yml). For local development
 * against a live PocketBase, create js/config.local.js (gitignored) from
 * js/config.example.js — it overrides this file.
 */
export const config = {
  cartoApiKey: 'cb1_2z8y_1_5c319f9fd406292b2aa4e1bd',
  pocketbaseUrl: '',
};
