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
 *
 * `web3formsKey` powers the "Edit Data" / "Add Job Call" submission forms — a
 * free Web3Forms access key (web3forms.com), also a publishable client key
 * (restrict it to this site's domain in the Web3Forms dashboard). Every
 * submission is emailed to the address the key is registered to. Empty = the
 * submission buttons are hidden.
 */
export const config = {
  cartoApiKey: 'cb1_2z8y_1_5c319f9fd406292b2aa4e1bd',
  pocketbaseUrl: '',
  web3formsKey: 'f3bd9727-420b-40db-8a32-137c605a964c',
};
