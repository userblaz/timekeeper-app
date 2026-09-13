# Timekeeper

A web app for tracking mechanical watch accuracy over time — offset readings, drift trends, factory spec comparisons, an experimental mic-based timegrapher, and a power-reserve tracker. Multi-user, built in vanilla HTML/CSS/JS (no build step), backed by Supabase.

Live at [timekeeper.geegee.si](https://timekeeper.geegee.si).

## Features

- **Data** — log offset readings by tapping the reference clock at :00/:15/:30/:45, or enter one manually. Tracks drift trend and overall rate per watch, with reset points for post-service regulation.
- **Timegrapher** (experimental) — mic-based beat rate and beat error estimate. Accuracy is limited on iOS specifically (see Known limitations).
- **Clock** — a synced reference clock (time.io) with an analog face, for setting a watch by hand.
- **Collection** — per-watch details: purchase price/currency, purchase date, condition notes, factory accuracy spec, certifications, and a power-reserve tracker (tap "wind" when fully wound; nothing is inferred automatically). Adding a watch searches a shared reference catalog by brand/model/reference and pre-fills its known specs, with a manual name-only fallback for anything not in the catalog yet. Cards can also be dragged into whatever order you like.
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
  add column if not exists last_wound_at timestamptz,
  add column if not exists sort_order integer;

-- One-time backfill for sort_order (Collection tab drag-to-reorder) — run
-- once after the column is added. Numbers each user's existing watches by
-- their current created_at order, so nothing visibly reshuffles the first
-- time this ships. New watches get their sort_order set directly by the
-- app at insert time, so this backfill never needs to run again.
with ranked as (
  select id, row_number() over (partition by user_id order by created_at asc) as rn
  from watches
  where sort_order is null
)
update watches set sort_order = ranked.rn
from ranked
where watches.id = ranked.id;

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

### Watch reference catalog

Backs the Collection tab's "Add watch" search (`ensureCatalogLoaded`,
`addWatchFromCatalog` in `data.js`) — a shared, read-only table of real
watch specs, separate from `watches` (which stays exactly what one user
personally owns). Grows only through migrations like this one, run
directly in the SQL editor, not through the app itself — keeps quality
consistent rather than user-editable.

```sql
create table if not exists watch_catalog (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  model text not null,
  reference text,
  production_years text,
  case_size_mm numeric,
  case_material text,
  movement text,
  movement_type text,        -- 'automatic' | 'manual' | 'quartz'
  power_reserve_hours integer,
  accuracy_spec text,
  certifications text,       -- comma-separated, same convention as watches.certifications
  water_resistance_m integer,
  crystal text,
  dial_color text,
  notes text,                -- for things like "discontinued 2021" that don't fit a field
  created_at timestamptz default now()
);

alter table watch_catalog enable row level security;

create policy "Anyone signed in can read the catalog"
on watch_catalog for select
to authenticated
using (true);

-- No insert/update/delete policy for regular users — see the note above.

-- Must run after the table above exists (it references watch_catalog.id),
-- so it lives here rather than in the main watches block further up.
alter table watches
  add column if not exists catalog_id uuid references watch_catalog(id) on delete set null;

-- Added after the initial seed below already shipped — installs that ran
-- this migration before dial_color existed need this to pick it up too.
alter table watch_catalog
  add column if not exists dial_color text;

insert into watch_catalog
  (brand, model, reference, production_years, case_size_mm, case_material, movement, movement_type, power_reserve_hours, accuracy_spec, certifications, water_resistance_m, crystal, dial_color, notes)
values
  ('Rolex', 'Submariner (No-Date)', '124060', '2020–present', 41, 'Steel', 'Caliber 3230', 'automatic', 70, '-2/+2 s/day', 'COSC,Rolex Superlative Chronometer', 300, 'Sapphire', 'Black', null),
  ('Rolex', 'GMT-Master II', '126710', '2018–present', 40, 'Steel', 'Caliber 3285', 'automatic', 70, '-2/+2 s/day', 'COSC,Rolex Superlative Chronometer', 100, 'Sapphire', 'Black', 'Family includes Pepsi/Batman/Bruce Wayne bezel colourways'),
  ('Rolex', 'Cosmograph Daytona', '126500LN', '2016–present', 40, 'Steel', 'Caliber 4130', 'automatic', 72, '-2/+2 s/day', 'COSC,Rolex Superlative Chronometer', 100, 'Sapphire', null, 'Some sources report an updated Caliber 4131 from ~2023 — unconfirmed; dial left blank, black and white "Panda" variants both exist under this reference'),
  ('Rolex', 'Day-Date 40', '228238', 'current', 40, 'Yellow Gold', 'Caliber 3255', 'automatic', 70, '-2/+2 s/day', 'COSC,Rolex Superlative Chronometer', 100, 'Sapphire', null, 'Dial left blank — several dial options ship under this reference'),
  ('Rolex', 'Explorer', '124270', '2021–present', 36, 'Steel', 'Caliber 3230', 'automatic', 70, '-2/+2 s/day', 'COSC,Rolex Superlative Chronometer', 100, 'Sapphire', 'Black', null),
  ('Omega', 'Speedmaster Professional Moonwatch', '310.30.42.50.01.001', '2021–present', 42, 'Steel', 'Caliber 3861', 'manual', 50, null, 'METAS Co-Axial Master Chronometer', 50, 'Hesalite', 'Black', null),
  ('Omega', 'Seamaster Diver 300M', '210.30.42.20.01.001', 'current', 42, 'Steel', 'Caliber 8800', 'automatic', 55, null, 'METAS Co-Axial Master Chronometer', 300, 'Sapphire', 'Black', null),
  ('Patek Philippe', 'Nautilus', '5711/1A', 'discontinued 2021', 40, 'Steel', 'Caliber 26-330 S C', 'automatic', 45, null, 'Patek Philippe Seal', 120, 'Sapphire', 'Blue', 'Discontinued — replaced by Ref. 5811/1G; secondhand only'),
  ('Audemars Piguet', 'Royal Oak Selfwinding', '15500ST', '2019–present', 41, 'Steel', 'Caliber 4302', 'automatic', 70, null, null, 50, 'Sapphire', null, 'Dial left blank — blue and black variants both exist under this reference');
```

For an install that already ran the seed insert above (so these 9 rows already exist without a dial), backfill the confident ones by reference:

```sql
update watch_catalog set dial_color = 'Black' where reference = '124060';
update watch_catalog set dial_color = 'Black' where reference = '126710';
update watch_catalog set dial_color = 'Black' where reference = '124270';
update watch_catalog set dial_color = 'Black' where reference = '310.30.42.50.01.001';
update watch_catalog set dial_color = 'Black' where reference = '210.30.42.20.01.001';
update watch_catalog set dial_color = 'Blue' where reference = '5711/1A';
-- Left null on purpose: 126500LN (Daytona), 228238 (Day-Date 40), 15500ST
-- (Royal Oak Selfwinding) — each reference covers multiple dial colors.
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
