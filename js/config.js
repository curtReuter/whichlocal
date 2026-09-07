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
 * Submission forms ("Edit Data" / "Add Job Call" / "Flag filled"), in order of
 * preference — the buttons show when either is set:
 *   `submitUrl`        the Cloudflare Worker in worker/ (opens a GitHub issue,
 *                      stores wage-sheet uploads in R2). Set this and leave
 *                      web3formsKey as-is; the Worker path wins.
 *   `web3formsKey`     fallback: a publishable Web3Forms access key
 *                      (web3forms.com) — submissions are emailed to the address
 *                      it's registered to.
 * `hcaptchaSitekey`    only needed with the Worker: your own hCaptcha site key
 *                      (its secret lives in the Worker). Empty = the shared
 *                      Web3Forms key, which only Web3Forms can verify.
 */
export const config = {
  cartoApiKey: 'cb1_2z8y_1_5c319f9fd406292b2aa4e1bd',
  pocketbaseUrl: '',
  submitUrl: 'https://whichlocal-submit.curtreuter.workers.dev/',
  web3formsKey: 'f3bd9727-420b-40db-8a32-137c605a964c',
  hcaptchaSitekey: '447000ca-7eb0-4f5e-8ed2-a294175ccb7a',
};
