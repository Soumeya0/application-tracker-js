# Application Tracker (JavaScript / Netlify edition)

A JavaScript rebuild of the Flask Application Tracker that runs entirely on Netlify's free tier:

| Python version (Railway) | This version (Netlify) |
|---|---|
| Flask + Jinja templates | Static HTML/CSS/JS frontend (no framework, no build step) |
| Gunicorn server | Netlify Function (`netlify/functions/api.mjs`) |
| SQLite on a volume | Netlify Blobs (built-in key-value storage) |
| Standalone scheduler + Gmail SMTP | Scheduled Netlify Function (`digest.mjs`) + Gmail via Nodemailer |
| pytest | `node:test` (22 tests, no extra dependencies) |

The Python project stays as it is. This is a second implementation of the same idea.

## What it does

- Sortable, searchable, filterable table of applications.
- Automatic urgency highlighting: **Overdue** and **Due soon** (within 3 days), shown with text as well as color.
- Stats: total, response rate, average days to first response, status breakdown.
- Daily email digest of what needs attention.
- **Two modes on the login screen**
  - **Try the demo**: sample data stored only in the visitor's browser. This is what recruiters should click.
  - **Sign in**: your real data, saved in Netlify Blobs behind a password only you know.

Urgency rules (so nothing nags you for no reason):
- A follow-up date counts for every application that is still open.
- A deadline counts only for **Wishlist** (you haven't applied yet) and **Offer** (you must answer) items.
- **Rejected** and **Withdrawn** never alert.

## Deploy to Netlify

1. Create a new GitHub repository and push this folder to it (`.env` and `node_modules` are already git-ignored).
2. On Netlify: **Add new site -> Import an existing project**, choose the repo.
   Netlify reads `netlify.toml`, so leave the build command empty (publish directory `public`, functions `netlify/functions`).
3. In **Site configuration -> Environment variables**, add:

   | Variable | Required | Purpose |
   |---|---|---|
   | `APP_PASSWORD` | yes | Your owner password. Make it long. Without it, sign-in is disabled (the demo still works). |
   | `GMAIL_USER` | for email | Gmail address that sends the digest |
   | `GMAIL_APP_PASSWORD` | for email | A Gmail **App Password** (needs 2-Step Verification on; create it at myaccount.google.com/apppasswords). Never your normal password. |
   | `DIGEST_TO` | no | Where to send it (defaults to `GMAIL_USER`) |
   | `DIGEST_TZ` | no | Default `America/Toronto` |
   | `DIGEST_ALWAYS` | no | `true` to email even on days when nothing is due |

4. Deploy (or **Deploys -> Trigger deploy** after adding the variables).

Notes:
- The digest is a scheduled function, so it only runs on the **published production deploy**, not on deploy previews. The cron is in UTC (`0 12 * * *`): 8:00 AM Toronto in summer, 7:00 AM in winter. Edit it at the bottom of `netlify/functions/digest.mjs`.
- By default the digest skips days when nothing is due, so you only get email that matters.

## Run it locally

```bash
npm install
npm test                      # 22 tests
cp .env.example .env          # then fill in APP_PASSWORD
npx netlify dev               # http://localhost:8888 with functions + Blobs
```

Only the demo mode works if you just open `public/index.html` from disk. Browsers block ES modules on `file://`, so use `netlify dev` or any static server.

## How it's organized

```
public/                  static site (this is what Netlify serves)
  index.html, css/styles.css
  js/core.js             pure logic: validation, urgency, stats, sort/filter, digest text
                         (the same file runs in the browser, the functions and the tests)
  js/storage.js          two interchangeable data sources: cloud API and browser demo
  js/app.js              UI (DOM APIs only, no innerHTML, so user text can't inject HTML)
server/
  handler.js             the API as (Request) -> Response, easy to test
  auth.js                password -> signed expiring token (HMAC-SHA256, constant-time compares)
  blobStore.js           Netlify Blobs adapter
  digest.js              finds what's due and sends the email
netlify/functions/       thin wrappers: api.mjs (/api/*) and digest.mjs (scheduled)
tests/                   core.test.js, api.test.js
```

## Design decisions worth mentioning in an interview

- **Why a rewrite instead of a port?** Netlify has no always-on server or persistent disk, so Flask + SQLite + a standalone scheduler can't run there. Serverless functions, a managed key-value store and a scheduled function map onto the same three jobs.
- **Shared pure logic.** Business rules live in one dependency-free module, so the browser, the server and the tests can't disagree.
- **Dependency injection for testing.** The API handler takes its store, password and clock as arguments, so tests run it with an in-memory store and a fake clock. No mocking libraries.
- **Security basics:** constant-time password comparison, signed tokens that expire after 7 days and are invalidated by changing the password, a short delay after wrong passwords, request size limits, server-side validation of every write, strict Content-Security-Policy, and no `innerHTML` anywhere.
- **Known limits (honest list):** single user, no password-reset flow, no per-IP rate limiting (only the delay), and the Blobs list endpoint reads every record, which is fine for hundreds of applications but not for thousands.

## Suggested wording for the portfolio card

> **Application Tracker (JavaScript edition)**: Rebuilt my Flask tracker as a serverless app on Netlify: vanilla JS frontend, Netlify Functions API with token auth, Netlify Blobs storage, and a scheduled daily email digest. 22 automated tests. Try the demo without signing in.

On the project page, add a **Live Demo (Netlify)** button next to the existing Code link, and keep the Python repo as "Code (Python / Flask)".
# application-tracker-js
