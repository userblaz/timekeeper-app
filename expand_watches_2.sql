-- Mirrors watch_catalog's newest columns (crown type, tachymeter, bezel
-- type, service interval — added after the original 68-boolean expansion,
-- see expand_watches.sql) onto the personal watches table, same reasoning
-- as that migration: a manually-added watch should be able to carry the
-- same data a catalog-sourced one has on its linked watch_catalog row.
-- One boolean per crown/bezel option, matching watch_catalog's own
-- columns exactly (not a single crown_type/bezel_type enum) — a watch can
-- be both screw_down_crown and crown_guards, or both bezel_unidirectional
-- and bezel_gmt (a GMT-Master II), at once.
-- if not exists on every column makes this safe to re-run.

alter table watches
  add column if not exists screw_down_crown boolean not null default false,
  add column if not exists push_pull_crown boolean not null default false,
  add column if not exists twin_lock_crown boolean not null default false,
  add column if not exists oversized_crown boolean not null default false,
  add column if not exists recessed_crown boolean not null default false,
  add column if not exists crown_guards boolean not null default false,
  add column if not exists has_tachymeter boolean not null default false,
  add column if not exists bezel_fixed boolean not null default false,
  add column if not exists bezel_unidirectional boolean not null default false,
  add column if not exists bezel_bidirectional boolean not null default false,
  add column if not exists bezel_gmt boolean not null default false,
  add column if not exists bezel_countdown boolean not null default false,
  add column if not exists bezel_tachymeter boolean not null default false,
  add column if not exists bezel_pulsometer boolean not null default false,
  add column if not exists bezel_telemeter boolean not null default false,
  add column if not exists bezel_slide_rule boolean not null default false,
  add column if not exists bezel_compass boolean not null default false,
  add column if not exists service_interval_years numeric;
