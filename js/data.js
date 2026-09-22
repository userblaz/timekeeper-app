// Data layer: app state, Supabase persistence, watch/reading CRUD, stats.
// This is the file js/auth.js swapped from localStorage to Supabase — every
// other file still just calls these functions without knowing where the
// data actually lives.
//
// currentUser and the `sb` Supabase client are defined in js/auth.js
// (loaded after this file), but these functions are only ever called once
// a user is signed in, so currentUser is always set by call time.

let state = { watches: [], activeId: null };
let loaded = false;
let saveStatus = '';

// Every assignment to state.activeId used to just set the in-memory value
// — loadState() then always re-derived it fresh as state.watches[0] on
// every reload, rather than remembering which watch had actually been
// selected. That looked fine as long as the watches query came back in the
// same order every time, but its own ORDER BY (sort_order, then
// created_at) has no tiebreaker for watches that share both — duplicates
// added in quick succession while testing, for instance — and ties have no
// guaranteed order across separate query executions. Which watch ends up
// first, and so which one loadState() picked as "active", could silently
// change reload to reload: the Snap tab's whole first card (a taller,
// highlighted block when it has logged stats) would swap for a plain one,
// shifting everything below it up by exactly that difference — which reads
// exactly like the page landing scrolled, without actually being a scroll
// bug at all. Routing every real assignment through here instead persists
// the chosen id, so loadState() can restore the one the user actually had
// selected instead of re-deriving a fresh, potentially different guess.
function setActiveWatch(id){
  state.activeId = id;
  try{
    if(id) localStorage.setItem('timekeeper-active-watch', id);
    else localStorage.removeItem('timekeeper-active-watch');
  }catch(e){}
}

// The shared reference catalog behind the Collection tab's "Add watch"
// search (see collection.js) — read-only reference data, not personal
// watches, so it's cached at module level here rather than living on
// `state`. null means "not fetched yet", not "empty catalog".
let watchCatalog = null;
let watchCatalogLoading = false;

async function ensureCatalogLoaded(){
  if(watchCatalog || watchCatalogLoading) return watchCatalog;
  watchCatalogLoading = true;
  try{
    const { data, error } = await sb.from('watch_catalog').select('*')
      .order('brand', { ascending: true }).order('model', { ascending: true });
    if(error) throw error;
    watchCatalog = data || [];
  }catch(e){
    // Table not migrated yet on this install, or a network hiccup — same
    // "don't take the rest of the app down with you" treatment as
    // wear_days and sort_order above. The manual "add a watch" path never
    // depended on this table, so it still works either way.
    watchCatalog = [];
  }
  watchCatalogLoading = false;
  return watchCatalog;
}

async function loadState(){
  try{
    // sort_order drives the Collection tab's drag-to-reorder; created_at is
    // the tiebreaker for however many watches predate that column. Ordering
    // by it can 404 on an install that hasn't run the README's migration
    // yet — same situation as wear_days below, so it gets the same
    // "fall back, don't take the whole app down" treatment rather than
    // throwing straight into the outer catch and wiping every watch.
    //
    // id is a THIRD tiebreaker, after both of those — two watches can share
    // the same sort_order (never dragged into a custom order) and the same
    // created_at (added in the same batch/transaction, which is common for
    // duplicate test data), and Postgres makes no promise about the order
    // of genuinely tied rows across separate query executions. Without a
    // final tiebreaker guaranteed unique per row, watchRows' own order — and
    // so which watch state.activeId below ends up defaulting to — could
    // silently differ reload to reload. id always is unique, so this is
    // what actually pins the order down completely.
    let watchRows;
    {
      const primary = await sb.from('watches').select('*')
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if(primary.error){
        const fallback = await sb.from('watches').select('*')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true });
        if(fallback.error) throw fallback.error;
        watchRows = fallback.data;
      }else{
        watchRows = primary.data;
      }
    }
    const { data: readingRows, error: rErr } = await sb
      .from('readings').select('*').order('date', { ascending: true });
    if(rErr) throw rErr;

    // Its own try/catch: this table is newer than the rest of the schema, so
    // an install that hasn't run its migration yet shouldn't lose every
    // watch and reading just because this one query 404s.
    let wearRows = [];
    try{
      const { data: wearData, error: wearErr } = await sb.from('wear_days').select('watch_id, date');
      if(wearErr) throw wearErr;
      wearRows = wearData || [];
    }catch(e){
      wearRows = [];
    }

    // Same "newer table, don't take the whole app down if it's not
    // migrated yet" treatment as wear_days above (see service_records.sql).
    let serviceRows = [];
    try{
      const { data: serviceData, error: serviceErr } = await sb
        .from('service_records').select('*').order('service_date', { ascending: true });
      if(serviceErr) throw serviceErr;
      serviceRows = serviceData || [];
    }catch(e){
      serviceRows = [];
    }

    state.watches = (watchRows || []).map(w => ({
      id: w.id,
      name: w.name,
      model: w.model || '',
      reference: w.reference || '',
      sortOrder: w.sort_order === null || w.sort_order === undefined ? null : Number(w.sort_order),
      // Which catalog entry this watch was created from, if any — null for
      // a manually-added watch. Drives the Collection tab's edit form: the
      // fields a catalog entry supplied stay locked, so they can't drift
      // out of sync with the real spec (collection.js).
      catalogId: w.catalog_id || null,
      shareStats: !!w.share_stats,
      purchasePrice: w.purchase_price === null || w.purchase_price === undefined ? null : Number(w.purchase_price),
      purchaseCurrency: w.purchase_currency || 'EUR',
      purchaseDate: w.purchase_date || '',
      photoUrl: w.photo_url || '',
      conditionNotes: w.condition_notes || '',
      accuracySpec: w.accuracy_spec || '',
      powerReserveHours: w.power_reserve_hours === null || w.power_reserve_hours === undefined ? null : Number(w.power_reserve_hours),
      lastWoundAt: w.last_wound_at || null,
      certifications: w.certifications ? w.certifications.split(',').filter(Boolean) : [],
      // Warranty status is personal data about this one specific watch,
      // never catalog data — flat fields here, same treatment as
      // purchasePrice/photoUrl, unaffected by whether the watch is
      // catalog-locked or manual.
      underWarranty: !!w.under_warranty,
      warrantyExpiration: w.warranty_expiration || '',
      // Every case/movement/functions column the edit form's new sections
      // read (collection.js) — specFieldsFromRow (below in this file)
      // shares the same mapping addWatchFromCatalog uses, since it's
      // reading the same column names off the same table either way.
      ...specFieldsFromRow(w),
      wornDates: new Set(wearRows.filter(r => r.watch_id === w.id).map(r => r.date)),
      readings: (readingRows || [])
        .filter(r => r.watch_id === w.id)
        .map(r => ({
          id: r.id,
          date: r.date,
          offset: Number(r.offset_seconds),
          note: r.note || '',
          isReset: r.is_reset || undefined,
          position: r.position || '',
          wearState: r.wear_state || '',
          timeOfDay: r.time_of_day || ''
        })),
      serviceRecords: serviceRows
        .filter(r => r.watch_id === w.id)
        .map(serviceRecordFromRow)
    }));
    // Restores whichever watch was actually last selected (see
    // setActiveWatch, above) rather than re-deriving a fresh guess every
    // load — only falls back to the first watch if nothing was saved yet,
    // or the saved id no longer matches any watch this account still has
    // (deleted, or a different account's id from a shared device).
    let savedActiveId = null;
    try{ savedActiveId = localStorage.getItem('timekeeper-active-watch'); }catch(e){}
    const savedStillExists = savedActiveId && state.watches.some(w => w.id === savedActiveId);
    state.activeId = savedStillExists ? savedActiveId : (state.watches[0] ? state.watches[0].id : null);
  }catch(e){
    // network hiccup or not signed in yet — leave state empty rather than crash
    state.watches = [];
    state.activeId = null;
  }
  loaded = true;
  render();
}

// No longer persists anything itself — every CRUD function below already
// awaited its own Supabase call before updating local state. This just
// flashes the save-status indicator the UI already shows.
function saveState(){
  saveStatus = 'saved';
  render();
}

// --- Export / Import ------------------------------------------------------
// The rule throughout: a field only ever travels through export/import if
// it's something the user actually typed themselves, never catalog data.
// Personal fields (purchase/photo/notes/warranty, plus the wear calendar,
// readings, and service history) are never catalog data on any watch, so
// they always travel. The rest of the spec — model/reference/dial/case/
// movement/functions/crown/bezel/accuracy/power reserve/certifications —
// only travels for a watch that's unlocked (catalogId null) at export
// time, since on a catalog-linked watch every one of those values is just
// a copy of what watch_catalog already says, not something the user
// entered. A catalog-linked watch instead exports its catalogId, so
// import can re-link and pull a *fresh* copy of the spec straight from
// watch_catalog again rather than carrying around a stale duplicate —
// this is also exactly what makes importing a manually-typed watch's
// export onto a later catalog-linked version of the same watch safe: the
// file simply never contains any spec fields to conflict with the
// catalog's own.

// Personal fields — always exported, and always importable regardless of
// whether the target watch is locked or not.
const PERSONAL_WATCH_FIELDS = [
  { key: 'purchasePrice', db: 'purchase_price', type: 'number' },
  { key: 'purchaseCurrency', db: 'purchase_currency' },
  { key: 'purchaseDate', db: 'purchase_date' },
  { key: 'photoUrl', db: 'photo_url' },
  { key: 'conditionNotes', db: 'condition_notes' },
  { key: 'underWarranty', db: 'under_warranty', type: 'boolean' },
  { key: 'warrantyExpiration', db: 'warranty_expiration' }
];

// Every db column name this app knows how to read/write, mapped back to
// its local camelCase key and type — built from the same field lists
// collection.js already maintains (ALL_EDIT_TEXT_FIELDS/MOVEMENT_BOOL_
// FIELDS/etc.), so there's one source of truth for "what fields exist"
// rather than a second hand-kept list here. Safe to call any time after
// load despite collection.js loading after this file — see emptySpecFields
// above for the same cross-file-timing reasoning.
function watchFieldMap(){
  const map = {};
  PERSONAL_WATCH_FIELDS.forEach(f => { map[f.db] = f; });
  ALL_EDIT_TEXT_FIELDS.forEach(f => { map[f.db] = f; });
  MOVEMENT_BOOL_FIELDS.concat(FUNCTIONS_BOOL_FIELDS, CASE_BOOL_FIELDS).forEach(dbName => {
    map[dbName] = { key: snakeToCamel(dbName), db: dbName, type: 'boolean' };
  });
  map.accuracy_spec = { key: 'accuracySpec', db: 'accuracy_spec' };
  map.power_reserve_hours = { key: 'powerReserveHours', db: 'power_reserve_hours', type: 'number' };
  map.model = { key: 'model', db: 'model' };
  map.reference = { key: 'reference', db: 'reference' };
  return map;
}

// db-keyed payload -> writes straight onto the local watch object, using
// watchFieldMap for the type coercion each field needs. Shared by both
// the full-backup restore path and the per-watch merge-import path below,
// so the two can't drift out of sync on how a given field gets applied.
function applyDbFieldsToWatch(w, dbPayload){
  const map = watchFieldMap();
  Object.keys(dbPayload).forEach(dbKey => {
    const f = map[dbKey];
    if(!f) return;
    const raw = dbPayload[dbKey];
    w[f.key] = f.type === 'number' ? (raw === null || raw === undefined ? null : Number(raw))
      : f.type === 'boolean' ? !!raw
      : (raw || '');
  });
}

// A watch's personal fields, as a db-column-keyed payload — usable
// directly as either an insert or an update payload.
function personalFieldsInsertPayload(entry){
  const payload = {};
  PERSONAL_WATCH_FIELDS.forEach(f => {
    const v = entry[f.key];
    payload[f.db] = f.type === 'boolean' ? !!v : (v === undefined || v === '' ? null : v);
  });
  return payload;
}

// A watch's spec fields read off a camelCase *local-shape* object (an
// imported entry, or another watch's own state) rather than a raw
// watch_catalog row — the mirror image of specInsertPayloadFromEntry
// above, which reads the snake_case shape a catalog row already has.
function specInsertPayloadFromLocalFields(entry){
  const payload = {};
  ALL_EDIT_TEXT_FIELDS.forEach(f => {
    const v = entry[f.key];
    payload[f.db] = f.type === 'number' ? (v === '' || v === null || v === undefined ? null : Number(v)) : ((v || '').toString().trim() || null);
  });
  MOVEMENT_BOOL_FIELDS.concat(FUNCTIONS_BOOL_FIELDS, CASE_BOOL_FIELDS).forEach(dbName => {
    payload[dbName] = !!entry[snakeToCamel(dbName)];
  });
  return payload;
}

// One watch, in export-file shape — see the file-level comment above for
// exactly which fields travel and why.
function exportableWatchRecord(w){
  const locked = !!w.catalogId;
  const record = {
    name: w.name,
    model: w.model || '',
    reference: w.reference || '',
    catalogId: w.catalogId || null
  };
  PERSONAL_WATCH_FIELDS.forEach(f => { record[f.key] = w[f.key]; });
  record.wornDates = Array.from(w.wornDates || []).sort();
  record.readings = (w.readings || []).map(r => ({
    date: r.date, offset: r.offset, note: r.note || '', isReset: !!r.isReset,
    position: r.position || '', wearState: r.wearState || '', timeOfDay: r.timeOfDay || ''
  }));
  record.serviceRecords = (w.serviceRecords || []).map(r => ({
    date: r.date, types: r.types, notes: r.notes, warrantyMonths: r.warrantyMonths,
    coveredByWarranty: r.coveredByWarranty, cost: r.cost, currency: r.currency,
    provider: r.provider, attachmentUrls: r.attachmentUrls
  }));
  if(!locked){
    ALL_EDIT_TEXT_FIELDS.forEach(f => { record[f.key] = w[f.key]; });
    MOVEMENT_BOOL_FIELDS.concat(FUNCTIONS_BOOL_FIELDS, CASE_BOOL_FIELDS).forEach(dbName => {
      const key = snakeToCamel(dbName);
      record[key] = !!w[key];
    });
    record.accuracySpec = w.accuracySpec || '';
    record.powerReserveHours = w.powerReserveHours;
    record.certifications = w.certifications || [];
  }
  return record;
}

function exportData(){
  const payload = { watches: state.watches.map(exportableWatchRecord) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `timekeeper-backup.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  lastExportAt = new Date();
  render();
}

// One watch only, same record shape exportData uses for each entry in its
// own array — just wrapped as { watch: {...} } instead of { watches: [...] },
// so the two file shapes are never ambiguous with each other.
function exportWatchData(watchId){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  const blob = new Blob([JSON.stringify({ watch: exportableWatchRecord(w) }, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const slug = (w.name || 'watch').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'watch';
  a.download = `timekeeper-${slug}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importData(file){
  const reader = new FileReader();
  reader.onload = async () => {
    try{
      const parsed = JSON.parse(reader.result);
      const entries = Array.isArray(parsed.watches) ? parsed.watches : null;
      if(!entries) throw new Error('bad format');
      saveStatus = 'saving'; render();
      // Needed to re-link a catalog-sourced entry and pull its spec fresh
      // rather than from anything stored in the file itself.
      await ensureCatalogLoaded();
      let nextOrder = state.watches.reduce((max, x) => Math.max(max, x.sortOrder || 0), 0);
      for(const entry of entries){
        nextOrder += 1;
        const catalogEntry = entry.catalogId ? (watchCatalog || []).find(c => c.id === entry.catalogId) : null;
        const insertPayload = catalogEntry ? {
          user_id: currentUser.id,
          name: catalogEntry.brand,
          model: catalogEntry.model || '',
          reference: catalogEntry.reference || '',
          accuracy_spec: catalogEntry.accuracy_spec || '',
          power_reserve_hours: catalogEntry.power_reserve_hours ?? null,
          certifications: catalogEntry.certifications || '',
          catalog_id: catalogEntry.id,
          sort_order: nextOrder,
          ...specInsertPayloadFromEntry(catalogEntry),
          ...personalFieldsInsertPayload(entry)
        } : {
          // No catalogId, or that catalog entry couldn't be found this
          // time (a different install, or the row's since been removed)
          // — falls back to a plain manual watch, using whatever spec the
          // file actually has (real data for a watch that was unlocked at
          // export time; just the bare name/model/reference fallback for
          // one that was catalog-linked but unresolvable here).
          user_id: currentUser.id,
          name: entry.name || 'Watch',
          model: entry.model || null,
          reference: entry.reference || null,
          accuracy_spec: entry.accuracySpec || null,
          power_reserve_hours: entry.powerReserveHours === '' || entry.powerReserveHours === undefined ? null : entry.powerReserveHours,
          certifications: (entry.certifications || []).length ? entry.certifications.join(',') : null,
          catalog_id: null,
          sort_order: nextOrder,
          ...specInsertPayloadFromLocalFields(entry),
          ...personalFieldsInsertPayload(entry)
        };
        const { data: watchRow, error: wErr } = await sb.from('watches').insert(insertPayload).select().single();
        if(wErr) throw wErr;
        const newWatch = {
          id: watchRow.id, name: watchRow.name, model: watchRow.model || '', reference: watchRow.reference || '',
          sortOrder: watchRow.sort_order === null || watchRow.sort_order === undefined ? nextOrder : Number(watchRow.sort_order),
          catalogId: watchRow.catalog_id || null,
          shareStats: !!watchRow.share_stats,
          purchasePrice: watchRow.purchase_price === null || watchRow.purchase_price === undefined ? null : Number(watchRow.purchase_price),
          purchaseCurrency: watchRow.purchase_currency || 'EUR',
          purchaseDate: watchRow.purchase_date || '',
          photoUrl: watchRow.photo_url || '',
          conditionNotes: watchRow.condition_notes || '',
          accuracySpec: watchRow.accuracy_spec || '',
          powerReserveHours: watchRow.power_reserve_hours === null || watchRow.power_reserve_hours === undefined ? null : Number(watchRow.power_reserve_hours),
          lastWoundAt: null,
          certifications: watchRow.certifications ? watchRow.certifications.split(',').filter(Boolean) : [],
          underWarranty: !!watchRow.under_warranty,
          warrantyExpiration: watchRow.warranty_expiration || '',
          wornDates: new Set(),
          readings: [],
          serviceRecords: [],
          ...specFieldsFromRow(watchRow)
        };
        if((entry.wornDates || []).length){
          const { error: wearErr } = await sb.from('wear_days').insert(entry.wornDates.map(date => ({ watch_id: watchRow.id, date })));
          if(!wearErr) newWatch.wornDates = new Set(entry.wornDates);
        }
        if((entry.readings || []).length){
          const toInsert = entry.readings.map(r => ({
            watch_id: watchRow.id, date: r.date, offset_seconds: r.offset, note: r.note || null,
            is_reset: !!r.isReset, position: r.position || null, wear_state: r.wearState || null, time_of_day: r.timeOfDay || null
          }));
          const { data: readingRows, error: rErr } = await sb.from('readings').insert(toInsert).select();
          if(!rErr && readingRows){
            newWatch.readings = readingRows.map(r => ({
              id: r.id, date: r.date, offset: Number(r.offset_seconds), note: r.note || '', isReset: r.is_reset || undefined,
              position: r.position || '', wearState: r.wear_state || '', timeOfDay: r.time_of_day || ''
            }));
          }
        }
        if((entry.serviceRecords || []).length){
          const toInsert = entry.serviceRecords.map(r => ({
            watch_id: watchRow.id, service_date: r.date, service_types: (r.types || []).length ? r.types.join(',') : null,
            notes: r.notes || null, warranty_months: r.warrantyMonths ?? null, covered_by_warranty: !!r.coveredByWarranty,
            cost: r.cost ?? null, currency: r.currency || 'EUR', provider: r.provider || null, attachment_urls: r.attachmentUrls || []
          }));
          const { data: serviceRows, error: sErr } = await sb.from('service_records').insert(toInsert).select();
          if(!sErr && serviceRows) newWatch.serviceRecords = serviceRows.map(serviceRecordFromRow);
        }
        state.watches.push(newWatch);
      }
      if(!state.activeId && state.watches[0]) setActiveWatch(state.watches[0].id);
      saveStatus = 'saved';
      render();
    }catch(e){
      alert("Couldn't import — make sure it's a Timekeeper backup JSON.");
      saveStatus = 'error';
      render();
    }
  };
  reader.readAsText(file);
}

// Per-watch import — merges an exportWatchData file onto an *existing*
// watch (targetWatchId) rather than creating a new one. Personal fields
// always apply; spec fields only apply if the target isn't itself
// catalog-locked (see the file-level comment above — this is what makes
// importing a manually-typed watch's export onto its later catalog-linked
// version conflict-free, since the target being locked just means the
// spec half of dbUpdates never gets built at all). Wear days/readings/
// service records are merged additively — wear days deduplicated,
// readings and service records simply appended — never replacing
// anything already on the target watch.
function importWatchData(targetWatchId, file){
  const reader = new FileReader();
  reader.onload = async () => {
    try{
      const parsed = JSON.parse(reader.result);
      const entry = parsed.watch;
      if(!entry || typeof entry !== 'object') throw new Error('bad format');
      const w = state.watches.find(x => x.id === targetWatchId);
      if(!w) return;
      const locked = !!w.catalogId;
      saveStatus = 'saving'; render();

      const dbUpdates = personalFieldsInsertPayload(entry);
      if(!locked){
        Object.assign(dbUpdates, specInsertPayloadFromLocalFields(entry), {
          model: entry.model || null,
          reference: entry.reference || null,
          accuracy_spec: entry.accuracySpec || null,
          power_reserve_hours: entry.powerReserveHours === '' || entry.powerReserveHours === undefined ? null : entry.powerReserveHours,
          certifications: (entry.certifications || []).length ? entry.certifications.join(',') : null
        });
      }
      const { error } = await sb.from('watches').update(dbUpdates).eq('id', targetWatchId);
      if(error) throw error;
      applyDbFieldsToWatch(w, dbUpdates);
      if(!locked) w.certifications = entry.certifications || [];

      const incomingWorn = (entry.wornDates || []).filter(d => !w.wornDates.has(d));
      if(incomingWorn.length){
        const { error: wearErr } = await sb.from('wear_days').insert(incomingWorn.map(date => ({ watch_id: targetWatchId, date })));
        if(!wearErr) incomingWorn.forEach(d => w.wornDates.add(d));
      }
      if((entry.readings || []).length){
        const toInsert = entry.readings.map(r => ({
          watch_id: targetWatchId, date: r.date, offset_seconds: r.offset, note: r.note || null,
          is_reset: !!r.isReset, position: r.position || null, wear_state: r.wearState || null, time_of_day: r.timeOfDay || null
        }));
        const { data: readingRows, error: rErr } = await sb.from('readings').insert(toInsert).select();
        if(!rErr && readingRows){
          w.readings.push(...readingRows.map(r => ({
            id: r.id, date: r.date, offset: Number(r.offset_seconds), note: r.note || '', isReset: r.is_reset || undefined,
            position: r.position || '', wearState: r.wear_state || '', timeOfDay: r.time_of_day || ''
          })));
        }
      }
      if((entry.serviceRecords || []).length){
        const toInsert = entry.serviceRecords.map(r => ({
          watch_id: targetWatchId, service_date: r.date, service_types: (r.types || []).length ? r.types.join(',') : null,
          notes: r.notes || null, warranty_months: r.warrantyMonths ?? null, covered_by_warranty: !!r.coveredByWarranty,
          cost: r.cost ?? null, currency: r.currency || 'EUR', provider: r.provider || null, attachment_urls: r.attachmentUrls || []
        }));
        const { data: serviceRows, error: sErr } = await sb.from('service_records').insert(toInsert).select();
        if(!sErr && serviceRows){
          w.serviceRecords.push(...serviceRows.map(serviceRecordFromRow));
          w.serviceRecords.sort((a, b) => a.date.localeCompare(b.date));
        }
      }

      saveStatus = 'saved';
      if(typeof showToast === 'function') showToast('Watch data imported.');
      render();
    }catch(e){
      alert("Couldn't import — make sure it's a Timekeeper watch export JSON.");
      saveStatus = 'error';
      render();
    }
  };
  reader.readAsText(file);
}

function activeWatch(){
  return state.watches.find(w => w.id === state.activeId) || null;
}

function computeReadingRates(watch){
  // readings sorted by date, each has {date, offset, note, isReset}
  // rate for reading i = (offset_i - offset_{i-1}) / days_between
  // a reset point (post-service regulation) starts a fresh baseline, like i===0
  const readings = [...watch.readings].sort((a,b)=> a.date.localeCompare(b.date));
  return readings.map((r, i) => {
    if(i === 0 || r.isReset) return {...r, rate:null, deltaOffset:null, days:null, isBaseline:true};
    const prev = readings[i-1];
    const days = daysBetween(prev.date, r.date);
    const deltaOffset = r.offset - prev.offset;
    // Same date as the previous reading: shown as an ordinary reading like
    // any other, using the raw offset change since there's no elapsed time
    // to divide it by.
    const rate = days > 0 ? deltaOffset / days : deltaOffset;
    return {...r, rate, deltaOffset, days, isBaseline:false};
  });
}

function overallStats(watch){
  const readings = [...watch.readings].sort((a,b)=> a.date.localeCompare(b.date));
  if(readings.length === 0) return null;
  let lastResetIdx = -1;
  readings.forEach((r,i) => { if(r.isReset) lastResetIdx = i; });
  const segment = lastResetIdx >= 0 ? readings.slice(lastResetIdx) : readings;
  if(segment.length < 2) return null;
  const first = segment[0];
  const last = segment[segment.length-1];
  const days = daysBetween(first.date, last.date);
  if(days <= 0) return null;
  const avgRate = (last.offset - first.offset) / days;
  return { avgRate, days, count: segment.length, sinceReset: lastResetIdx >= 0 };
}

// The new spec columns (case/movement/functions/etc — see the
// expand_watches.sql migration) are shared by both addWatch and
// addWatchFromCatalog below, so their shape lives here once rather than
// twice. Reuses collection.js's own ALL_EDIT_TEXT_FIELDS/MOVEMENT_BOOL_
// FIELDS/FUNCTIONS_BOOL_FIELDS/snakeToCamel — safe even though collection.js
// loads after this file, since none of this runs until a watch is actually
// added, well after every script has loaded. The empty shape a brand new
// watch (manual, or catalog before addWatchFromCatalog fills it in) starts
// with — every text/number field blank, every boolean false.
function emptySpecFields(){
  const fields = {};
  ALL_EDIT_TEXT_FIELDS.forEach(f => { fields[f.key] = f.type === 'number' ? null : ''; });
  MOVEMENT_BOOL_FIELDS.concat(FUNCTIONS_BOOL_FIELDS, CASE_BOOL_FIELDS).forEach(dbName => { fields[snakeToCamel(dbName)] = false; });
  return fields;
}
// Same shape, read off a real row instead — either a fetched watch_catalog
// entry, or a watches row Supabase echoes back after insert/update; both
// use the same column names, so one function covers either source.
function specFieldsFromRow(row){
  const fields = {};
  ALL_EDIT_TEXT_FIELDS.forEach(f => {
    const raw = row[f.db];
    fields[f.key] = f.type === 'number' ? (raw === null || raw === undefined ? null : Number(raw)) : (raw || '');
  });
  MOVEMENT_BOOL_FIELDS.concat(FUNCTIONS_BOOL_FIELDS, CASE_BOOL_FIELDS).forEach(dbName => { fields[snakeToCamel(dbName)] = !!row[dbName]; });
  return fields;
}
// The insert payload's side of the same mirroring — db column names as
// keys (what .insert() needs), read straight off a catalog entry (whose
// own fields are already snake_case, straight from watch_catalog).
function specInsertPayloadFromEntry(entry){
  const payload = {};
  ALL_EDIT_TEXT_FIELDS.forEach(f => { payload[f.db] = entry[f.db] ?? null; });
  MOVEMENT_BOOL_FIELDS.concat(FUNCTIONS_BOOL_FIELDS, CASE_BOOL_FIELDS).forEach(dbName => { payload[dbName] = !!entry[dbName]; });
  return payload;
}

// One service_records row, in the local camelCase shape the Service /
// Maintenance section (collection.js) reads — same snake_case-in,
// camelCase-out convention as everything else here.
function serviceRecordFromRow(r){
  return {
    id: r.id,
    date: r.service_date,
    types: r.service_types ? r.service_types.split(',').filter(Boolean) : [],
    notes: r.notes || '',
    warrantyMonths: r.warranty_months === null || r.warranty_months === undefined ? null : Number(r.warranty_months),
    coveredByWarranty: !!r.covered_by_warranty,
    cost: r.cost === null || r.cost === undefined ? null : Number(r.cost),
    currency: r.currency || 'EUR',
    provider: r.provider || '',
    attachmentUrls: r.attachment_urls || []
  };
}

async function addWatch(name){
  saveStatus = 'saving'; render();
  // Goes on the end of the Collection tab's own order, same place a new
  // watch has always landed (previously that fell out of created_at for
  // free; sort_order needs it done explicitly).
  const nextOrder = state.watches.reduce((max, x) => Math.max(max, x.sortOrder || 0), 0) + 1;
  const { data, error } = await sb.from('watches')
    .insert({ user_id: currentUser.id, name: name.trim(), sort_order: nextOrder })
    .select().single();
  if(error){
    saveStatus = 'error';
    // Same reasoning as addWatchFromCatalog's own error handling — a null
    // return here is what lets addCollectionWatch (collection.js) tell a
    // real failure apart from success, instead of blindly opening whatever
    // watch was already active before this was ever called.
    if(typeof showToast === 'function') showToast(error.message || "Couldn't add that watch — the write was rejected.", 'error');
    render();
    return null;
  }
  const w = {
    id: data.id, name: data.name, model: data.model || '', reference: data.reference || '',
    sortOrder: data.sort_order === null || data.sort_order === undefined ? nextOrder : Number(data.sort_order),
    catalogId: null,
    shareStats: !!data.share_stats,
    purchasePrice: null, purchaseCurrency: 'EUR', purchaseDate: '', photoUrl: '', conditionNotes: '',
    accuracySpec: '', powerReserveHours: null, lastWoundAt: null, certifications: [],
    underWarranty: false, warrantyExpiration: '',
    wornDates: new Set(),
    readings: [],
    serviceRecords: [],
    ...emptySpecFields()
  };
  state.watches.push(w);
  setActiveWatch(w.id);
  saveState();
  return w;
}

// The Collection tab's "Add watch" search calls this instead of addWatch()
// when the user picked a catalog result rather than typing a name from
// scratch. The full spec (accuracy, power reserve, certifications, and now
// every case/movement/functions column — see specInsertPayloadFromEntry
// above) gets copied onto the new row as a snapshot, same as it always has
// — everything personal (price, date, condition, photo) is left blank for
// the owner, same as a manually-added watch.
async function addWatchFromCatalog(entry){
  saveStatus = 'saving'; render();
  const nextOrder = state.watches.reduce((max, x) => Math.max(max, x.sortOrder || 0), 0) + 1;
  const { data, error } = await sb.from('watches')
    .insert({
      user_id: currentUser.id,
      name: entry.brand,
      model: entry.model || '',
      reference: entry.reference || '',
      accuracy_spec: entry.accuracy_spec || '',
      power_reserve_hours: entry.power_reserve_hours === null || entry.power_reserve_hours === undefined ? null : entry.power_reserve_hours,
      certifications: entry.certifications || '',
      sort_order: nextOrder,
      catalog_id: entry.id,
      ...specInsertPayloadFromEntry(entry)
    })
    .select().single();
  if(error){
    saveStatus = 'error';
    // Without this, a failed insert (e.g. the watches table missing a
    // column specInsertPayloadFromEntry just tried to write — see
    // expand_watches_2.sql) failed completely silently: the caller
    // (selectCatalogWatch, collection.js) used to unconditionally jump to
    // state.activeId regardless of whether this actually returned a new
    // watch, landing on whatever watch happened to be active *before* this
    // was ever called instead of reporting anything went wrong.
    if(typeof showToast === 'function') showToast(error.message || "Couldn't add that watch — the write was rejected.", 'error');
    render();
    return null;
  }
  const w = {
    id: data.id, name: data.name, model: data.model || '', reference: data.reference || '',
    sortOrder: data.sort_order === null || data.sort_order === undefined ? nextOrder : Number(data.sort_order),
    catalogId: data.catalog_id || null,
    shareStats: !!data.share_stats,
    purchasePrice: null, purchaseCurrency: 'EUR', purchaseDate: '', photoUrl: '', conditionNotes: '',
    accuracySpec: data.accuracy_spec || '',
    powerReserveHours: data.power_reserve_hours === null || data.power_reserve_hours === undefined ? null : Number(data.power_reserve_hours),
    lastWoundAt: null,
    certifications: data.certifications ? data.certifications.split(',').filter(Boolean) : [],
    underWarranty: false, warrantyExpiration: '',
    wornDates: new Set(),
    readings: [],
    serviceRecords: [],
    ...specFieldsFromRow(data)
  };
  state.watches.push(w);
  setActiveWatch(w.id);
  saveState();
  return w;
}

// Called once a Collection tab drag settles on a new position. state.watches
// is already in its new order by then (collection.js reorders it before
// calling this) — this just renumbers everyone 1..n to match and writes only
// the rows whose number actually changed, rather than the whole collection
// every time.
async function persistWatchOrder(){
  const updates = [];
  state.watches.forEach((w, i) => {
    const order = i + 1;
    if(w.sortOrder !== order){
      w.sortOrder = order;
      updates.push(
        sb.from('watches').update({ sort_order: order }).eq('id', w.id)
          .then(({ error }) => error)
      );
    }
  });
  if(!updates.length) return;
  const errors = (await Promise.all(updates)).filter(Boolean);
  if(errors.length){
    // The drag already happened on screen and can't be undone from here —
    // this only warns that the *stored* order didn't take, so it reverts
    // next time these watches load (most likely cause: the README's
    // sort_order migration hasn't been run yet, so this column write 404s
    // the same way loadState's read of it already has its own fallback for).
    showToast(errors[0].message || "Couldn't save the new order — it may not stick after you sign out.", 'error');
  }
}

async function addReading(watchId, date, offset, note, conditions){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  const c = conditions || {};
  saveStatus = 'saving'; render();
  const { data, error } = await sb.from('readings')
    .insert({
      watch_id: watchId, date, offset_seconds: Number(offset), note: (note||'').trim() || null,
      position: c.position || null, wear_state: c.wearState || null, time_of_day: c.timeOfDay || null
    })
    .select().single();
  if(error){ saveStatus = 'error'; render(); return; }
  w.readings.push({
    id: data.id, date: data.date, offset: Number(data.offset_seconds), note: data.note || '',
    position: data.position || '', wearState: data.wear_state || '', timeOfDay: data.time_of_day || ''
  });
  saveState();
}

function ensureReadingIds(watch){
  // Kept as a no-op safety net — every reading now arrives from Supabase
  // with a real id already, so there's nothing to backfill in practice.
  watch.readings.forEach(r => { if(!r.id) r.id = uid(); });
}

async function saveEditReading(watchId, id){
  const dateEl = document.getElementById('editDate_'+id);
  const offsetEl = document.getElementById('editOffset_'+id);
  const noteEl = document.getElementById('editNote_'+id);
  const resetEl = document.getElementById('editReset_'+id);
  const positionEl = document.getElementById('editPosition_'+id);
  const wearEl = document.getElementById('editWear_'+id);
  const timeOfDayEl = document.getElementById('editTimeOfDay_'+id);
  if(!dateEl || !offsetEl || !dateEl.value || offsetEl.value === '') return;
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  const r = w.readings.find(x => x.id === id);
  if(!r) return;

  const updates = {
    date: dateEl.value,
    offset_seconds: Number(offsetEl.value),
    note: (noteEl ? noteEl.value : '').trim() || null,
    is_reset: !!(resetEl && resetEl.checked),
    position: (positionEl && positionEl.value) || null,
    wear_state: (wearEl && wearEl.value) || null,
    time_of_day: (timeOfDayEl && timeOfDayEl.value) || null
  };
  saveStatus = 'saving'; render();
  const { error } = await sb.from('readings').update(updates).eq('id', id);
  if(error){ saveStatus = 'error'; render(); return; }

  r.date = updates.date;
  r.offset = updates.offset_seconds;
  r.note = updates.note || '';
  if(updates.is_reset) r.isReset = true; else delete r.isReset;
  r.position = updates.position || '';
  r.wearState = updates.wear_state || '';
  r.timeOfDay = updates.time_of_day || '';
  editingReadingId = null;
  saveState();
}

async function deleteReading(watchId, id){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  saveStatus = 'saving'; render();
  const { error } = await sb.from('readings').delete().eq('id', id);
  if(error){ saveStatus = 'error'; render(); return; }
  w.readings = w.readings.filter(x => x.id !== id);
  editingReadingId = null;
  saveState();
}

// One new row in the watch's service history (collection.js's "+ Add
// service record" form) — its own immediate save, same as addReading
// above, rather than folding into the main Save button: a service record
// is a discrete past event being logged, not a field of the watch itself
// being edited. `fields.attachmentUrls` is expected already-uploaded
// (collection.js handles the Storage upload itself, same place the photo
// picker's own upload happens) — this just writes the resulting URLs.
// Deliberately doesn't touch saveStatus or call render() itself, unlike
// addReading/deleteReading above — those are only ever called from a tab
// of their own, but this one is called from *inside* the Collection tab's
// edit form (buildServiceRecordFormHtml, collection.js), which can easily
// have unsaved text sitting in other fields (Notes, Crown/Bezel, ...) at
// the same time. A full render() here would silently wipe all of that,
// the exact bug class this whole edit-form redesign was built to avoid.
// The caller does its own targeted DOM refresh instead (refreshServiceSection).
async function addServiceRecord(watchId, fields){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return null;
  const { data, error } = await sb.from('service_records')
    .insert({
      watch_id: watchId,
      service_date: fields.date,
      service_types: (fields.types || []).length ? fields.types.join(',') : null,
      notes: (fields.notes || '').trim() || null,
      warranty_months: fields.warrantyMonths === '' || fields.warrantyMonths === null || fields.warrantyMonths === undefined ? null : Number(fields.warrantyMonths),
      covered_by_warranty: !!fields.coveredByWarranty,
      cost: fields.cost === '' || fields.cost === null || fields.cost === undefined ? null : Number(fields.cost),
      currency: fields.currency || 'EUR',
      provider: (fields.provider || '').trim() || null,
      attachment_urls: fields.attachmentUrls || []
    })
    .select().single();
  if(error){
    if(typeof showToast === 'function') showToast(error.message || "Couldn't save that service record — the write was rejected.", 'error');
    return null;
  }
  const record = serviceRecordFromRow(data);
  w.serviceRecords.push(record);
  w.serviceRecords.sort((a, b) => a.date.localeCompare(b.date));
  return record;
}

// Same reasoning as addServiceRecord above — no saveStatus/render() here.
async function deleteServiceRecord(watchId, id){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return false;
  const { error } = await sb.from('service_records').delete().eq('id', id);
  if(error){
    if(typeof showToast === 'function') showToast(error.message || "Couldn't delete that service record.", 'error');
    return false;
  }
  w.serviceRecords = w.serviceRecords.filter(x => x.id !== id);
  return true;
}

// A day counts as worn either because it was tapped on directly in the
// wear calendar, or because a timing reading was logged that day with
// "Worn on wrist" as its condition — the calendar just reflects both, it
// only ever writes the explicit kind.
async function toggleWearDay(watchId, date){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  const isWorn = w.wornDates.has(date);
  saveStatus = 'saving'; render();
  if(isWorn){
    const { error } = await sb.from('wear_days').delete().eq('watch_id', watchId).eq('date', date);
    if(error){ saveStatus = 'error'; render(); return; }
    w.wornDates.delete(date);
  } else {
    const { error } = await sb.from('wear_days').insert({ watch_id: watchId, date });
    if(error){ saveStatus = 'error'; render(); return; }
    w.wornDates.add(date);
  }
  saveState();
}

function isDayWorn(w, dateStr){
  if(w.wornDates.has(dateStr)) return true;
  return w.readings.some(r => r.date === dateStr && r.wearState === 'worn');
}

// Every day in the given month that counts as worn — same rule as
// isDayWorn just above (an explicit calendar tap, or a reading logged
// "Worn on wrist" that day) — walked one whole month at a time to build
// the wear stats below.
function wearDaysInMonth(w, year, m){
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  let count = 0;
  for(let d = 1; d <= daysInMonth; d++){
    const dateStr = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if(isDayWorn(w, dateStr)) count++;
  }
  return count;
}

// The earliest date this watch has any wear activity on record — an
// explicit calendar tap or a reading logged "Worn on wrist" — so the
// average below only ever counts months the watch could actually have
// been tracked in, not months before it was even added.
function earliestWearActivityDate(w){
  let earliest = null;
  w.wornDates.forEach(d => { if(!earliest || d < earliest) earliest = d; });
  w.readings.forEach(r => {
    if(r.wearState === 'worn' && r.date && (!earliest || r.date < earliest)) earliest = r.date;
  });
  return earliest;
}

// How much a watch is actually being worn, month to month: the average
// worn days per month across every completed month since its first
// tracked wear day, the most recently completed month's own count, and
// how that compares to the month before it. Only ever looks at fully
// completed calendar months — the current, still-in-progress month would
// always read as artificially low next to a whole month, so it's left out
// of both the average and the "last month" figure entirely. Returns null
// when there isn't even one completed month of history yet to report on.
function computeWearStats(w){
  const earliest = earliestWearActivityDate(w);
  if(!earliest) return null;

  const [ey, em] = earliest.split('-').map(Number);
  const startKey = ey * 12 + (em - 1);

  const today = new Date();
  const curKey = today.getFullYear() * 12 + today.getMonth();
  const lastKey = curKey - 1; // most recently completed month
  if(startKey > lastKey) return null; // the watch's only activity is this month

  const keyToYM = (key) => [Math.floor(key / 12), ((key % 12) + 12) % 12];

  let total = 0, months = 0;
  for(let k = startKey; k <= lastKey; k++){
    const [y, m] = keyToYM(k);
    total += wearDaysInMonth(w, y, m);
    months++;
  }
  const avgPerMonth = total / months;

  const [ly, lm] = keyToYM(lastKey);
  const lastMonthDays = wearDaysInMonth(w, ly, lm);

  let deltaPct = null;
  const prevKey = lastKey - 1;
  if(startKey <= prevKey){
    const [py, pm] = keyToYM(prevKey);
    const prevMonthDays = wearDaysInMonth(w, py, pm);
    if(prevMonthDays > 0){
      deltaPct = Math.round(((lastMonthDays - prevMonthDays) / prevMonthDays) * 100);
    } else if(lastMonthDays === 0){
      deltaPct = 0;
    }
    // prevMonthDays === 0 and lastMonthDays > 0 is left as null (no prior
    // month to compare against) rather than a made-up "+100%".
  }

  return { avgPerMonth, lastMonthDays, deltaPct };
}

// How many days ago this watch was last worn — 0 for today, null if it has
// no wear activity on record at all. Walks backward from today one day at
// a time rather than scanning every reading/wornDate and sorting, since it
// almost always stops within the first few days in practice; the walk is
// bounded by the watch's own earliest tracked day, so it can never spin
// past the point where isDayWorn would have nothing left to match anyway.
function daysSinceLastWorn(w){
  const earliest = earliestWearActivityDate(w);
  if(!earliest) return null;
  const today = new Date();
  for(let i = 0; i <= 3650; i++){
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    if(isDayWorn(w, dateStr)) return i;
    if(dateStr <= earliest) break;
  }
  return null;
}

// The last `n` completed calendar months' worn-day counts, oldest first —
// a fixed-length window (unlike computeWearStats' average, which grows
// with the watch's whole history) so a sparkline of it is always the same
// width regardless of how long the watch has been tracked. Months before
// the watch had any activity just come back as zero, same as any other
// day wearDaysInMonth doesn't find a match for.
function wearMonthlySeries(w, n){
  const today = new Date();
  const curKey = today.getFullYear() * 12 + today.getMonth();
  const lastKey = curKey - 1;
  const keyToYM = (key) => [Math.floor(key / 12), ((key % 12) + 12) % 12];
  const series = [];
  for(let k = lastKey - n + 1; k <= lastKey; k++){
    const [y, m] = keyToYM(k);
    series.push({ year: y, month: m, days: wearDaysInMonth(w, y, m) });
  }
  return series;
}

// This watch's cut of all the wear tracked across the whole collection last
// month — e.g. one watch in five worn about equally would land near 20%.
// Only means anything with more than one watch being tracked; with a
// single watch it's always ~100%, which is true but not informative, so
// that case is left to show as null and the caller can decide to hide it.
function wearShareOfCollection(w){
  const today = new Date();
  const curKey = today.getFullYear() * 12 + today.getMonth();
  const lastKey = curKey - 1;
  const y = Math.floor(lastKey / 12), m = ((lastKey % 12) + 12) % 12;
  const totalAll = (state.watches || []).reduce((sum, watch) => sum + wearDaysInMonth(watch, y, m), 0);
  if(totalAll <= 0) return null;
  const mine = wearDaysInMonth(w, y, m);
  return Math.round((mine / totalAll) * 100);
}

// The single most statistically obvious day-of-week pattern in this
// watch's wear history, in plain language — the classic "which bucket
// shows up more than chance would predict" read, applied first to
// individual weekdays (falls back to a plain weekday/weekend split if no
// single day stands out enough on its own). Needs a modest sample before
// it'll claim anything specific, and says so plainly rather than going
// silent — an empty line where a pattern might have been reads as broken,
// not as "nothing to report", so this always returns a string.
function wearPatternInsight(w){
  const dates = new Set(w.wornDates);
  w.readings.forEach(r => { if(r.wearState === 'worn' && r.date) dates.add(r.date); });
  const total = dates.size;
  if(total < 8) return 'Not enough tracked wear days yet for a day-of-week pattern.';

  const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  dates.forEach(dateStr => {
    counts[new Date(dateStr + 'T00:00:00').getDay()]++;
  });

  let topDay = 0;
  for(let i = 1; i < 7; i++) if(counts[i] > counts[topDay]) topDay = i;
  const topShare = counts[topDay] / total;
  const evenShare = 1 / 7;

  // A day has to clear "even chance" by a wide enough margin, with enough
  // raw occurrences behind it, before it's worth calling out as a pattern
  // rather than noise from a small sample.
  if(topShare - evenShare >= 0.12 && counts[topDay] >= 3){
    return `Most often worn on ${dayNames[topDay]}s — ${Math.round(topShare * 100)}% of its ${total} tracked wear day${total===1?'':'s'}.`;
  }

  const weekendShare = (counts[0] + counts[6]) / total;
  const evenWeekendShare = 2 / 7;
  if(Math.abs(weekendShare - evenWeekendShare) >= 0.1){
    return weekendShare > evenWeekendShare
      ? `Leans weekend — ${Math.round(weekendShare * 100)}% of tracked wear days fall on a Saturday or Sunday.`
      : `Leans weekday — only ${Math.round(weekendShare * 100)}% of tracked wear days fall on a weekend.`;
  }

  return 'No clear day-of-week pattern yet — wear looks fairly even across the week.';
}

async function deleteWatch(watchId){
  saveStatus = 'saving'; render();
  const { error } = await sb.from('watches').delete().eq('id', watchId);
  if(error){ saveStatus = 'error'; render(); return; }
  state.watches = state.watches.filter(w => w.id !== watchId);
  if(state.activeId === watchId){
    setActiveWatch(state.watches[0] ? state.watches[0].id : null);
  }
  saveState();
}
