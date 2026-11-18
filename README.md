# KaptainX Sales HQ

A sales dashboard for your team. It runs entirely on free plans: Supabase for the database and logins, and Vercel or Render for the website.

**Screens:** Dashboard (daily goal, calls, analytics, team, follow-ups, domains) · Leads (drag-and-drop pipeline + list with business, contact, domain, **problem & pitch**, website, lead score and status) · Calling (one lead at a time, showing the problem, a call opener, the best time to call and the lead's local time) · Activity (who changed what) · Account & team.

| Role | Can do |
|---|---|
| **Founder** (Dhruv, Hardik) | Everything, plus add members, reset passwords, change roles, deactivate accounts, delete leads |
| **Caller** (Anjika) | See, add and edit every lead, change status, log calls, import files. Can't delete leads or manage the team |

Everyone can change their own password in **Account → Change password**. If someone forgets theirs, a founder resets it in **Account → Team** and gets a one-time password to share.

---

## Try it locally first (sample data, no setup)

```bash
cd kaptainx-sales-hq/web
python3 -m http.server 8000
```
Open http://localhost:8000. Use **Account → Demo** to view the app as Dhruv, Hardik or Anjika.

---

## Go live (about 25 minutes)

### 1. Create the database
1. Go to **supabase.com**, create a **New project** (Region: Mumbai) and save the database password somewhere safe.
2. Go to **SQL Editor → New query**, paste all of `supabase/schema.sql` and click **Run**. It should say "Success".
3. Go to **Authentication → Sign In / Providers**:
   - Turn **"Allow new users to sign up" OFF**. Accounts are only created by founders.
   - Leave the **Email** provider on (the app uses username + password).
4. Go to **Authentication → Policies / Passwords** (if shown) and set the minimum password length to **10**.

### 2. Deploy the team function (used for adding members and resetting passwords)
In a terminal, inside the `kaptainx-sales-hq` folder:
```bash
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF      # the ref is in your Supabase URL
npx supabase functions deploy team --no-verify-jwt
```
`--no-verify-jwt` is required: Supabase's built-in check doesn't understand the new key format. The function checks the signed-in user itself and only lets active founders through.

### 3. Create the three accounts
1. Copy `private/.env.example` to `private/.env`.
2. Paste your **Project URL** and **secret key** into `private/.env`. Find them in Supabase → **Project Settings → API Keys**; the secret key starts with `sb_secret_`. Older projects can use the legacy `service_role` key instead.
   ⚠️ The secret key is a master key. It only goes in `private/.env`, never in `web/` and never in git.
3. Run:
   ```bash
   node scripts/admin.mjs setup
   ```
   This creates **dhruv**, **hardik** and **anjika** with the passwords in `private/CREDENTIALS.md`. Each person must choose their own password the first time they sign in.

### 4. Connect the website
Edit `web/config.js` and paste the **Project URL** and the **publishable key** (`sb_publishable_…`, or the legacy `anon` key). Never the secret key; the app refuses to start if you paste it by mistake.

### 5. Deploy the website

**Vercel**
1. Put this folder in a **private** GitHub repo. The `.gitignore` already keeps `private/.env` and the passwords file out.
2. In Vercel, click **Add New → Project**, import the repo and choose Framework **Other**. Don't set a build command; `vercel.json` already tells Vercel to serve `web/`.
3. Optional (recommended): add `SUPABASE_URL` and `SUPABASE_ANON_KEY` under **Settings → Environment Variables**. A small daily job (`api/keepalive.js`) then pings the database so the free Supabase project never pauses.

Or deploy straight from your laptop: `npx vercel --prod`

**Render**
- **New → Blueprint** and pick the repo (it reads `render.yaml`), or **New → Static Site** with publish directory `web` and no build command.
- Render has no daily job, so if nobody uses the app for 7 days, open Supabase and click **Restore**. No data is lost.

### 6. Lock the function to your site (optional, recommended)
```bash
npx supabase secrets set ALLOWED_ORIGIN=https://your-site.vercel.app
```

### 7. Sign in
Open your site, sign in with the username and password from `private/CREDENTIALS.md`, then choose a new password. On iPhone, tap **Share → Add to Home Screen** and it opens like an app.

---

## Everyday admin
- **Add someone:** Account → Team → **Add member**. You get a one-time password to send them.
- **Forgot password:** a founder opens Account → Team → their name → **Reset password**.
- **Both founders locked out:** `node scripts/admin.mjs reset dhruv` (uses `private/.env`).
- **Someone leaves:** Account → Team → their name → **Deactivate**. They're signed out right away and their history stays.

## Importing leads
CSV or Excel (.xlsx) files up to 10 MB. Columns are matched automatically and you can change any match before importing. Your website-leads sheet (`Business, Industry, Biggest problem, Call opener, Lead score, Best time to call (IST), Time zone, Owner name…`) imports as-is.

| Field in the app | Header names it recognises |
|---|---|
| Business | Business, Business name, Company, Firm, Clinic |
| Contact name | Owner name, Contact name, Contact person, Name, POC |
| Domain | Industry, Domain, Category, Sector, Niche |
| **Problem** | Biggest problem, Main problem, Problem, Pain point, Issue |
| **Call opener** | Call opener, Opener, Opening line, Talking points, Script |
| What to pitch | What to pitch, Pitch, Product, Offer, Service |
| Lead score | Lead score (0-100), Score |
| Best time to call | Best time to call (IST), Best time, Call time |
| Time zone | Time zone, Timezone (shows the lead's local time on the calling screen) |
| Others | Website, Phone, Business email, City / State, Notes |

How the importer handles your sheet:
- **Leftover columns** (Problems found, Email angle, Better local competitor, Google rating, PageSpeed, Contact form link…) go into the lead's **Notes** when "Keep other columns in notes" is on. That's the default.
- **Missing values:** cells that just say "NOT FOUND" are skipped. If a name looks like "Jane Doe (owner, per homepage)", the name becomes "Jane Doe" and the full text is kept in notes.
- **Phone numbers:** country codes are added automatically. US-style files (ET/CT time zones, "City, ST") get **+1**, others get **+91**. You can change this in the import screen.
- **Whole-file defaults:** if the file has no domain or pitch column, you can type one value for every lead (e.g. pitch "Website rebuild").
- **Duplicates** (same phone or email) are skipped, so re-uploading an updated sheet only adds the new leads.
- **Old `.xls` files** need to be saved as `.xlsx` or CSV first.

## Push to GitHub
The `.gitignore` already keeps these out of git: `private/.env`, `private/initial-users.json`, `private/CREDENTIALS.md` and `_old_ideas_version/`. Create an empty **private** repo on github.com (no README), then, inside this folder:
```bash
git init
git add -A
git status                      # check: no private/.env, CREDENTIALS.md or initial-users.json listed
git commit -m "KaptainX Sales HQ"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/kaptainx-sales-hq.git
git push -u origin main
```
If you have the GitHub CLI, the last three lines can be replaced with: `gh repo create kaptainx-sales-hq --private --source=. --push`

Then in Vercel: **Add New → Project → import that repo → Deploy**. Every later `git push` redeploys automatically.

## Security
- **Database rules:** every table has row-level security. People who aren't on the team, or who have been deactivated, get nothing, even with the public key.
- **Least privilege:** signed-in users can only change their own name, daily goal and password flag. Roles can only be changed through the founder-only `team` function.
- **Audit trail:** "who created / edited / called" is stamped by the database, so it can't be faked from the browser.
- **No outside code:** the site loads no scripts from CDNs. Everything is self-hosted, and the strict security headers in `vercel.json` / `render.yaml` (CSP, HSTS, no framing, nosniff) enforce that.
- **Safe display:** everything typed or imported is escaped before it's shown, websites must be `http(s)` links, and the database also rejects bad links.
- **No public sign-up:** accounts are created only by founders, temporary passwords are random and must be changed at first sign-in, and the site asks search engines not to index it.
