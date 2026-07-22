# DragonslairCMS

A self-contained CMS on Cloudflare Workers: one Worker serves the public site and the
admin, rendering everything at runtime from D1 — publishing is an instant database
flip, no build pipeline. Clone it, point it at your own Cloudflare account, and deploy.

## Stack

| Piece | Choice |
|---|---|
| Compute | Cloudflare Workers, plain JavaScript ES modules, no build step |
| Database | D1 — hand-written SQL, no ORM |
| Media | R2, served by the Worker at `/media/<key>` |
| Email | Cloudflare Workers `send_email` binding (needs Workers Paid + a verified sender) |
| Styling | CSS custom properties generated at runtime (`/theme.css`) from design tokens in D1 |

## Features

- **Pages** — block-based (20+ block types incl. a media gallery), draft → publish
  with frozen snapshots, revision history, per-block surface palettes, live preview.
- **Articles** — WYSIWYG body, blog/news categories, authors/reviewers from the
  People directory, tags, covers, same snapshot/revision model, live preview.
- **Branding** — design tokens (light + dark), surface palette designer, font
  uploads, logo/favicon, navigation/footer editors, global settings. The whole
  site (and the admin wordmark/logo) re-themes from the admin — no code edits.
- **Community** — moderated comments (anonymous or reader accounts) with staff
  replies, corrections on articles *and* pages, blog subscription emails.
- **Readers** — front-end-only role: self-registration (admin-toggleable) with
  email verification + approval, dashboard, subscriptions, notification prefs.
- **Users** — admin / publisher / editor roles, activity log, login rate limiting.

## Requirements

- **Node 20+** (Node 22 recommended — see `.nvmrc`). Wrangler 4 needs Node 20+.
- A **Cloudflare account**. **The Workers Free plan is enough** to run the whole
  CMS (Workers, D1 and R2 are all available on Free). The *only* feature that needs
  the **Workers Paid** plan + a domain is **outgoing email** — and that's optional:
  the CMS runs in "no-email mode" without it (see [Email & no-email mode](#email--no-email-mode)).

## Cloudflare CLI credentials

`wrangler` (installed by `npm install`) needs to authenticate to your Cloudflare
account. Two options:

- **Interactive (simplest):** run `npx wrangler login` — it opens a browser to
  authorise this machine. Nothing to store; good for local use.
- **API token (for `.env`, CI, or non-interactive use):** copy `.env.example` to
  `.env` and fill in two values:

  **`CLOUDFLARE_API_TOKEN`** — create one at **Cloudflare dashboard → My Profile →
  API Tokens → Create Token**. Start from the **“Edit Cloudflare Workers”** template,
  then **add a `D1 → Edit`** permission (the template already covers Workers and R2
  but not D1). Under *Account Resources*, select your account. The token is shown
  **once** — copy it immediately. The permissions this project actually uses:

  | Permission (Account) | Used for |
  |---|---|
  | Workers Scripts · Edit | `wrangler deploy` |
  | D1 · Edit | create the database + apply `schema.sql` |
  | Workers R2 Storage · Edit | create the media bucket |

  (The Workers template + the added D1 permission cover all three.)

  **`CLOUDFLARE_ACCOUNT_ID`** — in the dashboard go to **Workers & Pages** and copy
  **Account ID** from the right-hand sidebar (it's also in the dashboard URL, and
  `npx wrangler whoami` prints it once you're authenticated).

`.env` is gitignored — never commit it.

### Using your own names

The starter uses the name `dragonslaircms` for the **Worker**, the **D1 database**
and the **R2 bucket**. They're independent — rename any or all — but each name must
be identical everywhere it's referenced:

- **Worker name** — sets your `<your-worker>.<account-subdomain>.workers.dev` subdomain. One place:
  `wrangler.jsonc` → top-level `"name"`.
- **D1 database name** — **three** places that must match:
  - `wrangler.jsonc` → `d1_databases[0].database_name`
  - the `db:schema` **and** `db:schema:remote` scripts in `package.json`
    (they call `wrangler d1 execute <name> …`)
  - the `wrangler d1 create <name>` command you run at setup
- **R2 bucket name** — **two** places that must match:
  - `wrangler.jsonc` → `r2_buckets[0].bucket_name`
  - the `wrangler r2 bucket create <name>` command you run at setup

For example, to use `myblog` (database) and `myblog-media` (bucket), your setup
commands become:

```sh
wrangler d1 create myblog                 # paste the printed id into database_id
wrangler r2 bucket create myblog-media
```

…then set `database_name: "myblog"` and `bucket_name: "myblog-media"` in
`wrangler.jsonc`, and change `dragonslaircms` → `myblog` in the two `db:schema*`
scripts in `package.json`.

Leave the **binding** names (`DB`, `MEDIA`, `EMAIL`, `ASSETS`) as they are — the code
refers to those, not the resource names.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars    # fill in two random secrets (openssl rand -hex 32)
cp .env.example .env              # optional: Wrangler CLI credentials
npm run db:schema                 # create the local D1 schema
npm run dev                       # wrangler dev (local)
```

Open the local URL, go to `/admin` → you'll be sent to `/admin/setup` to create the
first admin account (see below), then log in.

- `.dev.vars` (gitignored) holds `ADMIN_SESSION_SECRET` / `READER_SESSION_SECRET`.
- `.env` (gitignored) holds `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` for the CLI.

## Deploy to your own Cloudflare

> Note: If you changed the d1 database name or r2 bucket name in `wrangler.jsonc`, you will need to adjust the commands below to use your set names.

One-time setup on a fresh account:

```sh
# 1. Create the D1 database, then paste the printed id into wrangler.jsonc (database_id).
wrangler d1 create dragonslaircms

# 2. Create the R2 bucket for media.
wrangler r2 bucket create dragonslaircms

# 3. Edit wrangler.jsonc:
#    - database_id  → the id from step 1
#    - vars.SITE_URL         → your deployed origin (workers.dev subdomain or custom domain)
#    - vars.SITE_EMAIL_FROM  → the address you'll verify for email (see Email)
#    - vars.SITE_TITLE       → optional starting site name (also editable in admin later)
#    (Want your own project/database/bucket names instead of "dragonslaircms"?
#     See "Using your own names" below — each name must be kept in sync.)

# 4. Session secrets (32+ random chars each):
wrangler secret put ADMIN_SESSION_SECRET
wrangler secret put READER_SESSION_SECRET

# 5. Apply the schema to the remote database, then deploy.
npm run db:schema:remote
npm run deploy
```

Then open `https://<your-worker>.<account-subdomain>.workers.dev/admin` — with an empty database it
redirects to **`/admin/setup`**, a one-time screen (shown only while there are no
users) where you create the first admin account in the browser. Do this right after
deploying, before sharing the URL.

> **CLI alternative:** you can instead seed the first admin from the terminal:
> ```sh
> node scripts/seed-admin.js <email> "<name>" <password> > /tmp/seed.sql
> wrangler d1 execute dragonslaircms --file=/tmp/seed.sql --remote
> ```

Everything else — site title, tagline, logo/favicon, colours, fonts, navigation,
footer, pages, articles, email copy — is editable in the admin. Updates are applied
with `npm run deploy`; re-run `npm run db:schema:remote` only when `schema.sql` changes.
There is no CI/CD.

## Email & no-email mode

Outgoing email uses the Cloudflare `send_email` binding (`EMAIL` in `wrangler.jsonc`),
which needs the **Workers Paid** plan and a domain set up for **Email Routing**.

**To enable email:**

1. Keep the `send_email` block in `wrangler.jsonc` and set `vars.SITE_EMAIL_FROM`.
2. In the Cloudflare dashboard, add your domain and enable **Email Routing**.
3. Under **Email → Email Routing → Settings → Custom Addresses**, add and verify the
   address used in `SITE_EMAIL_FROM`.
4. Leave **Admin → Settings → “Send outgoing email”** on (the default).

**No-email mode (Workers Free plan / no domain):** delete the `send_email` block from
`wrangler.jsonc` (or turn off “Send outgoing email” in Settings). The CMS detects this
and adapts so nothing is left half-working:

- **Admin notifications** (new comment / correction / registration) → shown in-app via
  the sidebar badges and dashboard instead of emailed.
- **Reader self-registration** → skips the email-verification step; new accounts land
  in the **Admin → Readers** approval queue (or are usable immediately if you've turned
  approval off in Settings).
- **Password resets** → the email-based “Forgot password?” links are hidden. Admins
  reset each other from **Admin → Users**; an admin resets a reader from **Admin →
  Readers → Set password**.
- **Reader convenience emails** (comment-reply / new-article) → simply not sent;
  comment status is still visible on the reader's dashboard.

Either way, nothing crashes if a send fails — email errors are logged and swallowed.
All email copy is editable under **Admin → Email templates**.

## Optional: emoticons

The editor's emoticon picker starts empty. Sample dragon emoticons live in
`assets/emoticons/`; upload your own (or these) via **Admin → Emoticons**. Requires
the R2 bucket.

## Layout

```
schema.sql              D1 schema (apply manually; migrations noted in-file)
src/index.js            Worker entry — public route pipeline + /theme.css
src/routes/admin.js     Admin auth gate, first-run setup, section dispatcher
src/routes/admin-*.js   One module per admin section
src/routes/public-*.js  Public renderers (pages, articles, people)
src/routes/reader.js    Reader account flows (/reader/*)
src/routes/api.js       Form/JSON endpoints (/api/*)
src/tokens.js           Design token defaults + CSS generators
src/templates/          HTML shells and the runtime block renderer
src/email.js            Templated email over the EMAIL binding
scripts/seed-admin.js   CLI first-admin seeder (alternative to /admin/setup)
public/                 Static assets (CSS, editor JS, icons)
```

## License

MIT — see [LICENSE](LICENSE).
