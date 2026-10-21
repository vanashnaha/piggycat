# Piggycat — Production Edition 🐷🐱

One Piggycat. One person. For life.

Piggycat is a digital lifetime companion — part Tamagotchi (needs that decay
in real time, care actions, bond levels, life stages), part Creatures 2 Norn
(she *learns*: a Talk system that remembers your name, favourites and facts,
with a personality that grows from how you treat her). She is modelled on a
real plush: chonky off-white body, pig snout with a pink nose, cat whiskers,
mismatched grey/mustard ears, and pink paw pads.

Every user houses **exactly one** Piggycat, bonded to them permanently. Her
identity, genome, memories and bond **never** transfer. Only her *coat* can
change — and only Super Rare coats can trade between users.

This repository is the production version of the original single-file static
app: same look, same layout, same game — plus real accounts and a real
backend.

## Architecture

```
 Browser (index.html — the original app, unchanged look & game logic)
 ├── config.js          public Supabase URL + anon key (placeholders = offline mode)
 ├── localStorage       cache + offline fallback (the original save system)
 └── supabase-js (CDN)  Auth + pets row load/save, protected by RLS
        │
        ├── Supabase Auth            email/password + magic link sign-in
        ├── Supabase Postgres        profiles / pets / coats / trades (+ RLS)
        │
        └── Netlify Functions        privileged, server-authoritative actions
              ├── roll-coat.js       verifies JWT, enforces the 7-day cooldown
              │                      server-side, rolls the tier server-side,
              │                      writes the coat to `coats`
              └── trade-coat.js      verifies JWT, creates/redeems PC-TRADE
                                     codes, transfers Super Rare COATS only
                                     (a Piggycat/pet row never moves)

 Hosted on: Netlify (static frontend + serverless functions, netlify.toml)
```

**Pragmatic split, on purpose:** the pet's whole game state (including chat
and memories) is mirrored into `pets.state` as jsonb — that keeps the
original game's save/load code almost untouched. The two things that must
not be cheatable — the weekly coat roll and coat trading — are *fully*
server-authoritative in the Netlify Functions, using the Supabase service
role key. If Supabase isn't configured yet (placeholder values in
`config.js`), the app simply runs in its original local/offline mode and
says so. It never hard-breaks.

## Files

| File | What it is |
|---|---|
| `index.html` | The app. Original Piggycat + a same-style Account card and an isolated cloud-sync module at the end of the file. |
| `config.js` | `window.PIGGYCAT_CONFIG` — public Supabase URL + anon key go here. |
| `netlify.toml` | Publish `.`, functions dir, security headers/CSP. No build command. |
| `netlify/functions/roll-coat.js` | Weekly coat roll, server-side. |
| `netlify/functions/trade-coat.js` | Super Rare coat trading (`create` / `redeem`). |
| `supabase/schema.sql` | All tables, indexes, RLS policies, signup trigger. Run once. |
| `.env.example` | Names of the two server-only environment variables. |

---

## Deployment — exact steps

### a) Supabase (accounts + database)

1. Go to [supabase.com](https://supabase.com) → **New project**. Pick a name
   (e.g. `piggycat`), a database password (save it in a password manager),
   and a region close to your users. Wait for it to provision.
2. In the project: **SQL Editor → New query** → paste the entire contents
   of `supabase/schema.sql` → **Run**. You should see success with no
   errors. This creates `profiles`, `pets`, `coats`, `trades`, all RLS
   policies, and the trigger that creates a profile on signup.
3. **Project Settings → API**: copy the **Project URL** and the
   **anon / public key**. Paste both into `config.js`
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). Also copy the
   **service_role key** — you'll need it in step (c). Keep it secret.
4. **Authentication → Providers → Email**: make sure Email is enabled
   (it is by default). Optionally enable **Google** on the same page if
   you want Google sign-in later (the app ships with email/password +
   magic link).
5. **Authentication → URL Configuration**: set **Site URL** to your
   Netlify site URL once you have it in step (c) (e.g.
   `https://your-site.netlify.app`), and add it under **Redirect URLs**
   too — magic links and email confirmations send users back there.
   (For local testing, also add `http://localhost:8888`.)

### b) GitHub (code hosting)

1. Create a new repository on GitHub (e.g. `piggycat`), **without**
   adding a README (this project already has one).
2. From this folder:
   ```bash
   git init
   git add .
   git commit -m "Piggycat production edition"
   git branch -M main
   git remote add origin https://github.com/<your-username>/piggycat.git
   git push -u origin main
   ```
   `.gitignore` already excludes `.env`, `.netlify/` and `node_modules/`.

### c) Netlify (hosting + functions)

1. Go to [netlify.com](https://netlify.com) → **Add new site → Import an
   existing project** → connect GitHub → pick the `piggycat` repo.
2. Build settings: **build command — leave empty**, **publish
   directory: `.`** (both already described in `netlify.toml`, so
   Netlify usually picks them up automatically). Deploy.
3. **Site settings → Environment variables** — add exactly these two:
   - `SUPABASE_URL` = your Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = the Supabase **service_role** key

   > ⚠️ **The service role key is a master key.** It goes ONLY in
   > Netlify environment variables, where just the serverless functions
   > can read it. **NEVER put it in `config.js`, `index.html`, or any
   > file that reaches a browser.** The frontend uses the anon key;
   > RLS is what keeps every user's Piggycat private.
4. Trigger a redeploy after setting the env vars
   (**Deploys → Trigger deploy → Deploy site**) so the functions pick
   them up.
5. Go back to Supabase and set the **Site URL** (step a.5) to your real
   Netlify URL.

### d) Test checklist

- [ ] Open the Netlify URL. The Account card says accounts are on (not
      "local/offline mode"). Sign up with **Account #1**, name your
      Piggycat, feed/play/talk — teach her your name
      ("My name is …"). Refresh: she's still there, saved to the account.
- [ ] In Supabase **Table Editor → pets**: exactly **one** row exists,
      owned by Account #1, with her state in `state`.
- [ ] Sign up with a **second account** (different email, or a private
      window). Confirm Account #2 gets **its own, different Piggycat**
      (different ID), and cannot see Account #1's pet or memories.
- [ ] **Weekly roll lockout:** click **🎲 Randomize Coat** while signed
      in. A coat lands in the wardrobe. Click again — the roll is
      refused. Confirm in `pets` that `last_roll_at` is set (the lock
      is enforced by the server function, not just the button: calling
      `/.netlify/functions/roll-coat` again returns `429` with a
      `next_roll_at`).
- [ ] **Super Rare trade between the two accounts:** Account #1 needs a
      Super Rare coat (keep rolling weekly, or for testing insert one
      into `coats` via the Table Editor with `tier = 'Super Rare'`,
      `is_super_rare = true`, a unique `serial`, and the matching coat
      JSON in their wardrobe). In **Coats & Genetics → Online trading**,
      Account #1 lists it and gets a `PC-TRADE-…` code. Account #2
      redeems the code: the coat appears in Account #2's wardrobe,
      `coats.owner_id` now points to Account #2, the `trades` row is
      `redeemed` — and both Piggycats themselves (IDs, names, memories,
      bonds) are completely unchanged and unmoved.
- [ ] Log out: the app still works locally. Clear site data, log back
      in: your Piggycat is restored from your account.

## Local development

```bash
npm install -g netlify-cli   # once
cp .env.example .env         # fill in your Supabase values
netlify dev                  # serves the site + functions locally
```

With placeholder values in `config.js` and no `.env`, the site also
works as a plain static page — that's the original offline edition.

## The rules Piggycat lives by

- One Piggycat per user — enforced by you, by the UI, and by
  `pets.user_id UNIQUE` in the database.
- Identity, genome, memories and bond never trade, never transfer.
- Coats change; Standard coats are customisable, higher tiers come
  from the weekly roll (once per 7 days, server-enforced).
- Super Rare coats (~2% of rolls) are totally random, uniquely
  serialled, and the only things that can trade between users.
