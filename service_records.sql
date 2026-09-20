-- Service / Maintenance: warranty status (flat fields on watches, since
-- it's personal data about one specific watch, never catalog data) plus a
-- proper service history log (its own table, one row per service event —
-- a watch gets serviced repeatedly over its life, and each service has its
-- own date/type/cost/provider/notes/attachments worth keeping, not just
-- the most recent one overwriting the last).

alter table watches
  add column if not exists under_warranty boolean not null default false,
  add column if not exists warranty_expiration date;

create table if not exists service_records (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references watches(id) on delete cascade,
  service_date date not null,
  service_types text,              -- comma-separated, same convention as watches.certifications
  notes text,
  warranty_months numeric,         -- warranty period granted BY this service (not the watch's own warranty)
  covered_by_warranty boolean not null default false,
  cost numeric,
  currency text,
  provider text,                   -- free text: name + contact info together
  attachment_urls text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table service_records enable row level security;

-- Ownership is via watch_id -> watches.user_id (no separate user_id column
-- here), the same indirect-ownership shape readings already uses.
create policy "Users can view their own service records"
on service_records for select
using (watch_id in (select id from watches where user_id = auth.uid()));

create policy "Users can insert their own service records"
on service_records for insert
with check (watch_id in (select id from watches where user_id = auth.uid()));

create policy "Users can update their own service records"
on service_records for update
using (watch_id in (select id from watches where user_id = auth.uid()));

create policy "Users can delete their own service records"
on service_records for delete
using (watch_id in (select id from watches where user_id = auth.uid()));

-- Storage bucket for service-record attachments (receipts, invoices,
-- before/after photos), same idea as the existing watch-photos bucket —
-- one file path per user, scoped by the top-level folder in its path.
insert into storage.buckets (id, name, public)
values ('service-attachments', 'service-attachments', true)
on conflict (id) do nothing;

create policy "Users can upload their own service attachments"
on storage.objects for insert
with check (
  bucket_id = 'service-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can view their own service attachments"
on storage.objects for select
using (
  bucket_id = 'service-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);

create policy "Users can delete their own service attachments"
on storage.objects for delete
using (
  bucket_id = 'service-attachments'
  and (storage.foldername(name))[1] = auth.uid()::text
);
