# Which Local

An interactive map + ranked list of **IBEW electrician local unions** in the US
and Canada. Each local is a hotspot sized and coloured by a chosen pay/benefit
metric. Wage data is scraped from
[unionpayscales.com](https://unionpayscales.com/trades/ibew-electricians/) into a
local [PocketBase](https://pocketbase.io) database. The frontend is a
build-step-free static site (Leaflet + vanilla ES modules) that reads either a
live PocketBase (local dev) or a committed `js/data/locals.json` snapshot — so
the deployed site is pure static files with **no backend to run**. A daily
GitHub Action re-scrapes and commits a fresh snapshot; see [Deploy](#deploy).

```
whichlocal/
├── index.html, css/, js/        static frontend (served by any static server)
│   ├── js/cityMap.js            reusable Leaflet hotspot-map module
│   ├── js/metrics.js            metric labels / units / formatters
│   ├── js/dataSource.js         reads `locals` from PocketBase, or js/data/locals.json
│   ├── js/data/locals.json      daily scrape snapshot (committed; what the deploy serves)
│   ├── js/data/job-calls.json   per-local job-call lists (committed; see Job calls)
│   ├── js/config.js             committed runtime config (publishable CARTO key, snapshot mode)
│   ├── js/config.local.js       optional gitignored dev overrides (live PocketBase URL)
│   └── js/main.js               wires data + map + UI
├── pb/
│   ├── pocketbase               binary (gitignored — download, see below)
│   └── pb_migrations/           `locals` collection schema (auto-applied on serve)
├── scripts/
│   ├── setup-collection.mjs     recreate the `locals` collection via the API (idempotent)
│   ├── scrape.mjs               scrape → geocode → upsert into PocketBase
│   ├── export-snapshot.mjs      dump `locals` (+ overrides) to js/data/locals.json
│   ├── apply-overrides.mjs      fast path: apply overrides.json straight to the snapshot
│   ├── overrides.json           hand-entered data corrections (see Manual corrections)
│   ├── scrape-job-calls.mjs     scrape locals' own job-call pages → js/data/job-calls.json
│   ├── job-calls.config.json    which locals' sites to scrape for job calls
│   ├── notify-discord.mjs       per-local forum threads: comp card + new job calls
│   ├── discord-threads.json     slug → { thread, comp } message ids (committed by job-calls.yml)
│   ├── lib/pb.mjs               .env loader + PocketBase auth helpers
│   ├── lib/overrides.mjs        override loader + merge rule (shared)
│   └── cache/                   cached page HTML + geocache.json
├── .github/workflows/
│   ├── scrape.yml               daily scrape → export → commit
│   ├── apply-overrides.yml      on overrides.json push → re-export → commit
│   └── job-calls.yml            every 2h: scrape job calls → notify Discord → commit
└── .env                         local secrets (gitignored)
```

## Setup

Requires **Node 20+**. PocketBase is downloaded once as a single binary.

```sh
# 1. PocketBase binary (macOS arm64 shown — see pocketbase.io/docs for others)
mkdir -p pb && cd pb
curl -sL -o pb.zip https://github.com/pocketbase/pocketbase/releases/download/v0.40.3/pocketbase_0.40.3_darwin_arm64.zip
unzip -o pb.zip && rm pb.zip && chmod +x pocketbase && cd ..

# 2. Superuser + .env
pb/pocketbase superuser create admin@whichlocal.local "<a-strong-password>"
cp js/config.example.js js/config.local.js      # dev override: point the frontend at your live PocketBase
#   then edit .env  →  PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD / SCRAPER_CONTACT
```

`js/config.local.js` is optional — without it the frontend uses the committed
`js/config.js` (snapshot mode). Set `pocketbaseUrl: 'http://127.0.0.1:8090'` in
`config.local.js` to develop against a live PocketBase instead.

`.env` (gitignored) holds:

| var | purpose |
|---|---|
| `PB_URL` | PocketBase base URL (default `http://127.0.0.1:8090`) |
| `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD` | superuser used by the scripts |
| `SCRAPER_CONTACT` | email/URL sent as the `User-Agent` contact when scraping |
| `CARTO_API_KEY` | reference copy; the browser reads it from `js/config.js` |

## Run

```sh
# terminal 1 — database
pb/pocketbase serve                 # admin UI at http://127.0.0.1:8090/_/
#   the `locals` collection is created automatically from
#   pb/pb_migrations/ on first serve. If you ever need to recreate it:
#   node scripts/setup-collection.mjs   (idempotent)

# whenever you want fresh data
node scripts/scrape.mjs             # fetch live, geocode, upsert (~5-6 min first run)
node scripts/scrape.mjs --offline   # re-parse the cached HTML instead of refetching
node scripts/scrape.mjs --dry-run   # parse + geocode only, no DB writes
node scripts/scrape.mjs --limit 20  # first 20 locals only
node scripts/export-snapshot.mjs    # refresh js/data/locals.json from the DB

# terminal 2 — frontend
python3 -m http.server 8777         # open http://localhost:8777
```

If `js/config.local.js` exists it wins; otherwise the frontend reads the
committed `js/config.js`, whose empty `pocketbaseUrl` selects
`js/data/locals.json`.

## Deploy

The deployed site is just static files — host `index.html`, `css/`, `js/` on any
static provider (GitHub Pages, Netlify, Vercel, Cloudflare Pages). No build step
and nothing to configure on the host: `js/config.js` is committed with the
publishable CARTO key and snapshot mode, and `js/config.local.js` (dev-only) is
gitignored so it never ships.

The CARTO basemap key is a *client* key — it appears in every tile URL the
browser requests and cannot be hidden. Restrict it to your site's domain in the
[CARTO dashboard](https://carto.com/) (allowed origins / referrers) instead; an
empty key just falls back to keyless, watermarked tiles.

### Moving to a custom domain

Say the site moves from `curtreuter.github.io/whichlocal/` to `whichlocal.org`.
Most of the stack doesn't care about the domain; a few allow-lists and one
committed URL do. Add the new host **alongside** the old one everywhere that
takes a list, flip the switch, then remove the old host once it's confirmed.

**Nothing to change:** the submission Worker URL (`*.workers.dev`) and
`js/config.js` → `submitUrl`; the GitHub token, R2 bucket, and secrets; the
scrape workflows, PocketBase, and all data files.

| # | Where | What to do |
|---|---|---|
| 1 | **DNS + GitHub Pages** | Add the domain in the repo's **Settings → Pages** (writes a `CNAME` file), and point the domain's DNS at GitHub Pages ([docs](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site)). If you host elsewhere (Netlify/Vercel/Cloudflare Pages), use that host's custom-domain flow instead. |
| 2 | [**CARTO dashboard**](https://carto.com/) | Add the new domain to the basemap key's allowed origins / referrers (else the map falls back to watermarked tiles). |
| 3 | **hCaptcha dashboard** | Add the new hostname to the site's allowed hostnames (else the submission captcha stops verifying). |
| 4 | `worker/wrangler.toml` → `ALLOWED_ORIGIN` | Set to `https://whichlocal.org`, then `cd worker && npx wrangler deploy`. Or set it to `"*"` once and never touch this again — a valid, hostname-bound hCaptcha token is still required, so it isn't actually open. |
| 5 | [**Web3Forms dashboard**](https://web3forms.com) | Only if you still use the email fallback (`web3formsKey`): add the new domain to the access key's allowed domains. |
| 6 | `scripts/job-calls.config.json` → `site_url` | Change to `https://whichlocal.org/`. This is the "view on the map" link in every Discord message (`scripts/notify-discord.mjs`). Commit it. |
| 7 | Docs / comments | Cosmetic find-and-replace of `curtreuter.github.io/whichlocal` in this README, `worker/README.md`, and the fallback default in `scripts/notify-discord.mjs`. |

Optional: give the Worker a matching custom route (e.g. `submit.whichlocal.org`)
in the Cloudflare dashboard and update `submitUrl` — the `workers.dev` URL keeps
working either way, so this is purely cosmetic.

### Automatic daily refresh

`.github/workflows/scrape.yml` runs every day (~08:27 UTC, plus a manual
**Run workflow** button under the repo's Actions tab). Each run downloads
PocketBase, applies `pb/pb_migrations/`, runs `scripts/scrape.mjs` then
`scripts/export-snapshot.mjs`, and commits `js/data/locals.json` (and any new
geocache entries) back to the branch. Your static host redeploys on that commit,
so the live site stays current with zero servers to operate.

Set three repository secrets (**Settings → Secrets and variables → Actions**):

| secret | value |
|---|---|
| `PB_ADMIN_EMAIL` | any email — the ephemeral CI PocketBase superuser |
| `PB_ADMIN_PASSWORD` | any strong password (CI creates this superuser fresh each run) |
| `SCRAPER_CONTACT` | your email or a URL, sent as the scraper's `User-Agent` contact |

The CI PocketBase is thrown away after each run — the snapshot commit is the only
output — so those admin credentials are just for that run and need not match any
real deployment. GitHub's scheduler is best-effort; runs can lag or, rarely, be
skipped. Adjust the `cron:` line to change the time.

## Manual corrections

When someone reports that a local's numbers are stale or wrong, fix it in
**`scripts/overrides.json`** — a map of `key → { field: value }`. The **key is
the local number** (`"606"`). A handful of numbers cover more than one row (e.g.
Local 26 is both Washington DC and Roanoke); for those, `apply-overrides` /
`export-snapshot` print the choices and you switch that one entry to a slug — the
`id` in the ranked list, `l<local#>-<city>-<state>`, e.g. `l26-roanoke-va`.

```json
{
  "606": {
    "hourly_rate": 32.64,
    "note": "Orlando (Local 606) — member report 2026-09-10"
  },
  "l26-roanoke-va": {
    "wage_sheet_url": "https://…/local-26-roanoke-wage-sheet.pdf"
  }
}
```

Merge rule when the scrape runs:

| field kind | behaviour |
|---|---|
| wage / benefit numbers (`hourly_rate`, `total_package`, `yearly_salary`, `col_pct`, `defined_pension`, `contribution_pension`, `k401`, `vacation`, `hw`, `nebf_pension`, `adjusted_base_wage`, `dues`) | your value is kept **unless the scrape finds a strictly higher number**, which then wins |
| any of those, listed in `"force": [...]` | your value is always kept |
| everything else (`city`, `state`, `lat`, `lng`, `wage_sheet_url`, `source_updated`, `local_no`) | your value always wins |

`note` / `source` / `reported` / `date` keys are ignored (use them for
provenance). Keys starting with `_` (like `__doc__`) are ignored too.

**Getting a fix live:**

- Commit and push `scripts/overrides.json`. `.github/workflows/apply-overrides.yml`
  folds it into `js/data/locals.json` and commits — live in about a minute, no
  scrape needed.
- The daily scrape applies the same corrections every run, so they persist.
- Preview locally without touching PocketBase:
  `node scripts/apply-overrides.mjs --dry-run` (drop the flag to rewrite the
  snapshot).

The fast path only edits locals already on the map. To rescue a local the
geocoder missed — by putting `lat`/`lng` in its override — run a full
`node scripts/scrape.mjs && node scripts/export-snapshot.mjs` (or the daily
workflow).

Both steps warn when an override changed nothing (the scrape has caught up —
delete that entry), when a number/slug matches no local (typo), or when a bare
number is ambiguous (switch it to a slug).

Users can send corrections by opening an issue or a pull request against
`scripts/overrides.json`, or through the in-app forms below.

## Visitor submissions

The green detail panel has buttons (shown only when a submission target is set):

* **Edit Data** (wage view) — the metric grid as editable number fields,
  pre-filled with the current figures, plus a wage-sheet file picker (PDF/image,
  ≤ 9 MB) and a notes box. Sends a diff (`old → new` per changed field) plus the
  attachment.
* **Add Job Call** (wage or jobs view) — a textarea to paste a posting verbatim,
  plus an optional source link.
* **Flag filled** (jobs view, when the local has calls) — a checklist of the
  local's current job calls; ticked ones are sent as "please remove".

Each form is `multipart/form-data` with a hidden honeypot and an **hCaptcha**
checkbox (`index.html` loads `js.hcaptcha.com/1/api.js?render=explicit`, `js/main.js`
renders a widget per form). Two possible targets, set in `js/config.js`:

* **`submitUrl`** — the Cloudflare Worker in [`worker/`](worker/) (**preferred**).
  It verifies the hCaptcha token, stores the upload in R2, and opens a labelled
  **GitHub issue** with a paste-ready `overrides.json` / `job-calls.overrides.json`
  snippet. Also set `hcaptchaSitekey` to your own hCaptcha key (its secret lives
  in the Worker). See `worker/README.md` for the ~20-min setup.
* **`web3formsKey`** — fallback: a publishable [Web3Forms](https://web3forms.com)
  key; submissions are emailed to the address it's registered to, and Web3Forms
  verifies the hCaptcha with its shared sitekey (`50b2fe65-…`).

Neither set → the buttons don't render. Blanking `submitUrl` falls straight back
to Web3Forms.

### Approving a submission (Worker path)

Add the label **`approved`** to a submission issue and
`.github/workflows/apply-submission.yml` folds its JSON snippet into the right
file and opens a PR:

* `wage-correction` → merges the fields into `scripts/overrides.json`
* `job-call` → appends the call(s) to `scripts/job-calls.overrides.json`
  (skipping any whose text is already there)
* `job-call-removal` → no auto-apply; the bot comments to say do it by hand

Review the PR diff and merge — that triggers `apply-overrides.yml` /
`apply-job-calls.yml`, which take it live (and, for calls, drive Discord). Only
people with repo write access can add labels, so a visitor can't approve their
own submission. Re-labelling updates the existing `submission/<n>` PR.

Two one-time repo settings: create the `approved` label, and switch on
**Settings → Actions → General → Allow GitHub Actions to create and approve pull
requests** (otherwise the PR step can't run).

Without the label, act on a submission by hand-editing `scripts/overrides.json`
or `scripts/job-calls.overrides.json` — the issue body has the snippet to paste.

## The scraper

`scripts/scrape.mjs` pulls the single TablePress table from the source page,
normalises the money/percent strings, geocodes each local's *City, State* via
OpenStreetMap **Nominatim** (throttled to 1 request/second, results cached to
`scripts/cache/geocache.json`), and upserts one row per local into the `locals`
collection keyed by a `slug` (`l<local#>-<city>-<state>` — local numbers are not
unique). Locals whose city can't be geocoded are stored without coordinates and
hidden from the map.

**Conduct.** The scraper makes one request per run and caches the HTML so
`--offline` re-runs never touch the site; it identifies itself with a descriptive
`User-Agent` including `SCRAPER_CONTACT`. `unionpayscales.com/robots.txt` allows
general crawling (`User-agent: * → Allow: /`) while blocking AI-company crawlers;
you are responsible for complying with the site's Terms of Use, and the app
credits the source in its footer.

## Full local roster

`scripts/scrape-ibew-roster.mjs` builds `js/data/locals-roster.json` — every
active IBEW local union on the **US DOL OLMS** (Office of Labor-Management
Standards) Online Public Disclosure Room register (`affAbbr = IBEW`, designation
*LOCAL UNION*, not terminated), geocoded through the same shared
`scripts/cache/geocache.json`. `js/main.js` adds any roster local that isn't in
the wage data as a **`dataless`** local: a small grey dot on the map with a
"no wage data yet" panel, not ranked in the list. The `.github/workflows/roster.yml`
workflow refreshes it monthly.

OLMS serves an incomplete TLS chain that Node's `fetch` rejects, so the roster
scraper shells out to `curl` for those calls. OLMS is a US registry — it has no
Canadian locals, so the handful of Canadian locals in the wage data are
unaffected (they keep their wage figures and normal colouring).

## Job calls

Some locals publish a live "job calls" / referral list on their own site.
`scripts/scrape-job-calls.mjs` scrapes those into **`js/data/job-calls.json`**
(keyed by slug). `.github/workflows/job-calls.yml` runs it **every 2 hours**,
posts a Discord message for any call that's new since the previous run, and
commits the file (the site picks it up on its next deploy).

Each call carries a stable `id` (hash of its text) plus `first_seen` /
`last_seen`; those timestamps are read from the committed file and carried
forward, so a persisting call keeps its original `first_seen` and only genuinely
new calls trigger a notification. The per-run "what's new" list is written to
`scripts/cache/job-calls-delta.json` (gitignored) for the notifier.

```sh
node scripts/scrape-job-calls.mjs                    # every configured local
node scripts/scrape-job-calls.mjs --only l606-orlando-fl
node scripts/scrape-job-calls.mjs --offline          # re-parse cached HTML
node scripts/notify-discord.mjs --dry-run            # preview the Discord posts
```

**Adding a local:** append to `scripts/job-calls.config.json`:

```json
"l124-kansas-city-mo": {
  "local_no": 124,
  "url": "https://www.ibew124.org/…/Job20Calls"
}
```

then `node scripts/scrape-job-calls.mjs --only <slug>` and check the output.
IBEW sites run UnionActive. Each `<p>` on the page is matched against an ordered
list of paragraph parsers — the `FORMATS` array in `scripts/scrape-job-calls.mjs`
— and the first match wins. The two shapes seen so far, one `<p>` per call:

* **`prose`** (Local 606) — `"10 Journeyman Wireman calls for Contractor …"`,
  with a `"There are N job calls:"` header.
* **`dash-code`** (Local 756) — `"5 - JW Contractor, Working at …  $40.30"`, and
  **no header** — the total is the sum of the leading counts.

When a local publishes calls in a shape neither recognises, add another entry to
`FORMATS` (a `{ name, match(text) }` object); nothing else changes. If a new
parser would misfire on a local you already scrape, pin that local to the parsers
it needs with a `"format"` key in its config entry (a name or array of names) —
otherwise every parser is tried.

Same conduct as the main scraper — one request per local per run, HTML cached,
descriptive `User-Agent`.

**Manual job calls (`scripts/job-calls.overrides.json`).** For a local with no
scrapeable page, or to add a call a page missed, put it here — same idea as
`scripts/overrides.json` for wages. Key by **local number** (`"915"`) or slug
(`"l26-roanoke-va"` when the number is ambiguous); each entry has an optional
`posted` label and a `calls` array, each call needing `text` (paste the posting
verbatim) plus optional `count` / `classification` (parsed from the text
otherwise):

```json
{
  "915": {
    "posted": "week of Sep 8",
    "calls": [
      { "text": "2 Journeyman Wireman calls for ABC Electric, 5x8s, $34.10/hr." }
    ]
  }
}
```

`scrape-job-calls.mjs` merges these every run: a manual-only local becomes a
`{ manual: true, … }` record in `job-calls.json`; a manual call on a scraped
local is appended (a scraped listing with the same text wins). Manual calls run
through the same new/edited/filled diff, so **adding an entry posts it to
Discord, editing a count edits that message, and deleting the entry deletes the
message** — same as a scraped change. Pushing the file triggers
`.github/workflows/apply-job-calls.yml` for a ~1-minute turnaround; otherwise the
2-hourly `job-calls.yml` picks it up.

In the app a local with job calls gets an **"N job calls"** button in its list
row and the count in its map tooltip; the button opens the calls list in the
green panel, with a link back to the compensation view. First load defaults to
the **Open job calls** metric, which filters the map + list to locals that
publish a list.

### Discord notifications

`scripts/notify-discord.mjs` keeps a **forum thread per local**: the thread's
opening post is a live **compensation card** (rebuilt from `js/data/locals.json`
every run — total package, hourly, pensions, COL, dues, wage-sheet link), and
new job calls are posted below it. When a call drops off the local's list, the
message posted for it is deleted (the call id → message id map lives in
`scripts/discord-threads.json`). Layout: one forum channel per state. Outbound
only — no gateway, no slash commands — so it runs as a one-shot step in
`job-calls.yml`.

**Setup (once):**

1. **Bot token** → repo secret `DISCORD_BOT_TOKEN` (Developer Portal → your app →
   Bot → Reset Token). This is the only secret.
2. **Invite the bot** (OAuth2 → URL Generator → scope `bot`) with: *View
   Channels, Send Messages, Send Messages in Threads, Create Public Threads,
   Manage Messages, Embed Links, Read Message History*.
3. Create a **Forum channel per state** you cover (e.g. `job-calls-florida`),
   right-click → **Copy Channel ID**, and add it to
   `scripts/job-calls.config.json`:

   ```json
   "discord": {
     "forums": { "FL": "111111111111111111" },
     "default_channel_id": ""
   }
   ```

Channel ids aren't secret. A local whose state has no forum falls back to
`default_channel_id`; if that's blank too it's skipped with a warning, so you can
roll out state by state. Without `DISCORD_BOT_TOKEN` the step is a no-op.

The bot creates each configured local's thread (`IBEW Local 606 — Orlando`) with
the comp card as the starter message, and records `{ thread, comp }` in
`scripts/discord-threads.json` (committed by the workflow) — `comp` is the
message it edits each run. Delete a row to force a recreate; a deleted thread is
recreated automatically. If a thread's starter isn't the bot's (e.g. one you
made by hand), it posts and pins a comp message instead.

The comp card is re-synced on **every** data change, not just the 2-hourly
job-calls run: `scrape.yml` and `apply-overrides.yml` each run
`notify-discord.mjs --comp-only` after they rewrite `js/data/locals.json`, which
edits the starter message on any thread that already exists (no thread creation,
no job-call posts).

**Test it:** Actions → *Job calls + Discord* → **Run workflow** with **"Post
EVERY current job call"** ticked — posts every call on the board once
(`notify-discord.mjs --all`). Normal runs only post calls new since the previous
scrape.

Your Discord app: **application ID `1533086814875947068`**, public key
`3b50e1a1b14f35e21a49879dacab70840b047dc3b820976155b1e621c3073e5e` — not used by
the notifier (they're for a future *interactions* endpoint, which needs a hosted
HTTPS handler to verify requests with the public key).

## Data

Collection `locals` — public read, superuser-only writes. Numeric fields
(nullable): `yearly_salary`, `hourly_rate`, `total_package`, `col_pct`
(cost of living as % of national avg), `adjusted_base_wage`, `defined_pension`,
`contribution_pension`, `k401`, `vacation`, `hw`, `nebf_pension`, `dues`.
Plus `slug`, `local_no`, `city`, `state`, `lat`, `lng`, `wage_sheet_url`,
`source_updated`, `raw` (original cell strings), `scraped_at`.

`js/data/locals.json` is the same records as `{ generated_at, count, items[] }`,
minus `raw` and geo-miss rows — `scripts/export-snapshot.mjs` mirrors the exact
query `js/dataSource.js` runs against PocketBase, so the two data paths return
identical results.

`js/data/locals-roster.json` — `{ generated_at, source, count, items[] }`, each
item `{ local_no, city, state, slug, lat, lng }` — is the full IBEW local roster
from OLMS (see **Full local roster** above). It's independent of PocketBase; the
frontend loads it alongside `locals.json` and shows the locals it adds as grey
dots.
