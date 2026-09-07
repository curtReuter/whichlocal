# whichlocal-submit — submission worker

A Cloudflare Worker that takes the site's **Edit Data / Add Job Call / Flag
filled** forms, verifies the hCaptcha token, stores any wage-sheet upload in R2,
and opens a **GitHub issue** in this repo. It replaces the Web3Forms → email
path (which stays as the fallback when `js/config.js` has no `submitUrl`).

```
POST /         form → issue    → { "success": true }
GET  /f/<key>  stream a stored wage-sheet upload (issue bodies link here)
```

Issues are labelled `wage-correction` / `job-call` / `job-call-removal` and, for
wage/job-call adds, include a paste-ready snippet for `scripts/overrides.json` or
`scripts/job-calls.overrides.json`.

## One-time setup (~20–30 min)

Everything below is account clicks + copying three strings — no coding.

### 1. hCaptcha (your own site)

The site currently uses Web3Forms' shared hCaptcha key, which only Web3Forms can
verify. For the Worker you need your own pair:

1. [hcaptcha.com](https://www.hcaptcha.com) → sign up → **New site**.
2. Add hostname `curtreuter.github.io` (and `localhost` for testing).
3. Copy the **Sitekey** and the account **Secret key**.
4. Put the sitekey in `js/config.js` → `hcaptchaSitekey`.

### 2. Cloudflare + wrangler

```sh
npm i -g wrangler          # or: npx wrangler ...
cd worker
npm install
wrangler login             # opens the browser
```

### 3. R2 bucket (for wage-sheet uploads)

R2's free tier (10 GB) needs a card on file — add one at
dash.cloudflare.com → R2 if you haven't.

```sh
wrangler r2 bucket create whichlocal-submissions
```

The name must match `bucket_name` in `wrangler.toml`.

### 4. GitHub token

github.com → Settings → Developer settings → **Fine-grained tokens** → Generate:

* Repository access: **only** `whichlocal`
* Permissions → Repository → **Issues: Read and write**
* Expiry: 90 days – 1 year (set a calendar reminder to rotate)

Copy the `github_pat_…` string.

### 5. Secrets + deploy

```sh
wrangler secret put GITHUB_TOKEN       # paste the PAT
wrangler secret put HCAPTCHA_SECRET    # paste the hCaptcha account secret
wrangler deploy
```

`deploy` prints a URL like `https://whichlocal-submit.<you>.workers.dev`.

### 6. Point the site at it

In `js/config.js`:

```js
submitUrl: 'https://whichlocal-submit.<you>.workers.dev/',
hcaptchaSitekey: '<your hCaptcha sitekey>',
```

Commit + push. The forms now open issues instead of emailing. Blank `submitUrl`
again at any time to fall straight back to Web3Forms.

### 7. Labels (optional)

Create `wage-correction`, `job-call`, `job-call-removal` in the repo's Issues →
Labels. If a label doesn't exist the Worker just files the issue without it.

## Local development

```sh
cp .dev.vars.example .dev.vars      # fill in a PAT + the hCaptcha *test* secret
wrangler dev                        # serves on http://localhost:8787
npm test                            # unit tests, no network
```

Point `js/config.local.js` at `http://localhost:8787/` and use the hCaptcha test
sitekey `10000000-ffff-ffff-ffff-000000000001` (its secret
`0x0000000000000000000000000000000000000000` always passes).

## Config reference

| where | name | value |
|---|---|---|
| `wrangler.toml` `[vars]` | `GITHUB_OWNER` | `curtReuter` |
| | `GITHUB_REPO` | `whichlocal` |
| | `ALLOWED_ORIGIN` | `https://curtreuter.github.io` (or `*`) |
| `wrangler secret put` | `GITHUB_TOKEN` | fine-grained PAT, Issues: write |
| | `HCAPTCHA_SECRET` | hCaptcha account secret |
| R2 binding | `UPLOADS` | bucket `whichlocal-submissions` |
