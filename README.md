# Timekeeper

A web app for tracking mechanical watch accuracy over time — offset readings, drift trends, factory spec comparisons, an experimental mic-based timegrapher, and a power-reserve tracker. Multi-user, built in vanilla HTML/CSS/JS (no build step), backed by Supabase.

Live at [timekeeper.geegee.si](https://timekeeper.geegee.si).

## Features

- **Data** — log offset readings by tapping the reference clock at :00/:15/:30/:45, or enter one manually. Tracks drift trend and overall rate per watch, with reset points for post-service regulation.
- **Timegrapher** (experimental) — mic-based beat rate and beat error estimate. Accuracy is limited on iOS specifically (see Known limitations).
- **Clock** — a synced reference clock (time.io) with an analog face, for setting a watch by hand.
- **Collection** — per-watch details: purchase price/currency, purchase date, condition notes, factory accuracy spec, certifications, and a power-reserve tracker (tap "wind" when fully wound; nothing is inferred automatically).
- **Profile** — account settings (email change with confirmation, password change requiring the current one, optional name/birth date/phone), an FAQ, and a light/dark theme toggle that follows the OS on first visit and otherwise follows the signed-in account across devices.
- Installable as a PWA (standalone, no browser chrome) via "Add to Home Screen."

## Tech stack

- No framework, no build step — plain HTML/CSS/JS, loaded via `<script>` tags in a fixed order (see `index.html`).
- [Supabase](https://supabase.com) for auth (email/password + emailed 6-digit code) and Postgres storage, accessed directly from the client with the anon key + Row Level Security.
- Hosted on cPanel; deployed by uploading files directly (no CI/auto-deploy from this repo).

## File structure

```
timekeeper-app/
├── index.html
├── manifest.json         (PWA manifest — standalone display mode)
├── css/styles.css
├── icons/icon-180.png
└── js/
    ├── utils.js           small shared helpers
    ├── data.js            Supabase CRUD + app state
    ├── charts.js          SVG chart builders
    ├── timegrapher.js     mic-based tick detection
    ├── clock.js           reference clock + scroll-collapse header
    ├── collection.js      Collection tab (specs, power reserve, photos)
    ├── demo.js            adds one demo watch — safe to delete, see its own header comment
    ├── app.js             tab switching, render(), most UI wiring — loaded near the end
    └── auth.js            Supabase client + auth gate — loaded last
    └── profile.js         Profile tab (account settings, FAQ, theme) — loaded very last, self-contained
```

Script load order matters: later files assume earlier ones are already defined (e.g. `auth.js` calls `loadState()` from `data.js`).

## Supabase setup

**Project URL**: `https://sijqzjobdkxfuszgvtts.supabase.co`

### Tables

```sql
-- Base tables (watches, readings) are assumed to already exist with:
--   watches:  id, user_id, name, model, reference, share_stats, created_at
--   readings: id, watch_id, date, offset_seconds, note, is_reset, created_at
-- RLS: users can only read/write their own rows, enforced on both tables.

-- Everything added since:
alter table watches
  add column if not exists purchase_price numeric,
  add column if not exists purchase_currency text default 'EUR',
  add column if not exists purchase_date date,
  add column if not exists photo_url text,
  add column if not exists condition_notes text,
  add column if not exists accuracy_spec text,
  add column if not exists certifications text,
  add column if not exists power_reserve_hours integer,
  add column if not exists last_wound_at timestamptz;

alter table readings
  add column if not exists position text,
  add column if not exists wear_state text,
  add column if not exists time_of_day text;

-- User deletion should cascade to their watches automatically:
alter table watches drop constraint if exists watches_user_id_fkey;
alter table watches add constraint watches_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
```

### Storage (watch photos)

Create a **public** bucket named `watch-photos`, then:

```sql
create policy "Users can upload their own watch photos"
on storage.objects for insert
with check (bucket_id = 'watch-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can update their own watch photos"
on storage.objects for update
using (bucket_id = 'watch-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own watch photos"
on storage.objects for delete
using (bucket_id = 'watch-photos' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Anyone can view watch photos"
on storage.objects for select
using (bucket_id = 'watch-photos');
```

### Auth settings

- Email sign-in, sign-up, and a 6-digit-code sign-in are all supported (see `auth.js`).
- "Secure email change" (Authentication → Emails/Providers) should be **on** — the Profile tab's email-change flow relies on Supabase's own confirmation step.
- Personal info (name, birth date, phone, theme preference) is stored in each user's own `user_metadata` — no separate table needed for it.

## Deployment

No build step — upload the files as-is via cPanel File Manager to the site's document root. Script tags carry a `?v=3` cache-busting query string; bump that version when pushing a change if a stale cache seems to be an issue.

`manifest.json`'s `theme_color`/`background_color` are static and reflect the dark theme — they can't respond to the in-app light/dark toggle, so an installed PWA's splash screen stays dark either way.

## Known limitations

- **Timegrapher on iOS**: Safari applies microphone gain processing that can't be disabled from a web page, which limits detection accuracy specifically on iPhone. Works better on Android and desktop.
- **PWA manifest**: doesn't react to the light/dark theme toggle (see Deployment above).
- Data privacy relies on Supabase RLS — every table and the storage bucket restrict access to each user's own rows/files.
