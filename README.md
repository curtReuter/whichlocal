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
│   └── js/main.js               wires data + map + UI
├── pb/
│   ├── pocketbase               binary (gitignored — download, see below)
│   └── pb_migrations/           `locals` collection schema (auto-applied on serve)
├── scripts/
│   ├── setup-collection.mjs     recreate the `locals` collection via the API (idempotent)
│   ├── scrape.mjs               scrape → geocode → upsert into PocketBase
│   ├── export-snapshot.mjs      dump the `locals` collection to js/data/locals.json
│   ├── lib/pb.mjs               .env loader + PocketBase auth helpers
│   └── cache/                   cached page HTML + geocache.json
├── .github/workflows/scrape.yml daily scrape → export → commit
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
cp js/config.example.js js/config.local.js      # frontend config (PB url + CARTO key)
#   then edit .env  →  PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD / SCRAPER_CONTACT
```

`.env` (gitignored) holds:

| var | purpose |
|---|---|
| `PB_URL` | PocketBase base URL (default `http://127.0.0.1:8090`) |
| `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD` | superuser used by the scripts |
| `SCRAPER_CONTACT` | email/URL sent as the `User-Agent` contact when scraping |
| `CARTO_API_KEY` | reference copy; the browser reads `js/config.local.js` |

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

Local dev reads the live PocketBase because `js/config.local.js` sets
`pocketbaseUrl`. With no `config.local.js` (the deployed site) or an empty
`pocketbaseUrl`, the frontend loads `js/data/locals.json` instead.

## Deploy

The deployed site is just static files — host `index.html`, `css/`, `js/` on any
static provider (GitHub Pages, Netlify, Vercel, Cloudflare Pages). Do **not**
copy `js/config.local.js` to the host; its absence is what makes the frontend
read the committed `js/data/locals.json` snapshot. (Set the CARTO key for
production via whatever config mechanism you prefer, or leave it empty for
keyless, watermarked tiles.)

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
