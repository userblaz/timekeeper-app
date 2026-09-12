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

async function loadState(){
  try{
    const { data: watchRows, error: wErr } = await sb
      .from('watches').select('*').order('created_at', { ascending: true });
    if(wErr) throw wErr;
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

    state.watches = (watchRows || []).map(w => ({
      id: w.id,
      name: w.name,
      model: w.model || '',
      reference: w.reference || '',
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
        }))
    }));
    state.activeId = state.watches[0] ? state.watches[0].id : null;
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

function exportData(){
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
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

function importData(file){
  const reader = new FileReader();
  reader.onload = async () => {
    try{
      const parsed = JSON.parse(reader.result);
      if(!parsed.watches) throw new Error('bad format');
      saveStatus = 'saving';
      render();
      for(const w of parsed.watches){
        const { data: watchRow, error: wErr } = await sb.from('watches')
          .insert({ user_id: currentUser.id, name: w.name, model: w.model || null, reference: w.reference || null })
          .select().single();
        if(wErr) throw wErr;
        const newWatch = {
          id: watchRow.id, name: watchRow.name,
          model: watchRow.model || '', reference: watchRow.reference || '',
          shareStats: !!watchRow.share_stats, readings: []
        };
        if(w.readings && w.readings.length){
          const toInsert = w.readings.map(r => ({
            watch_id: watchRow.id, date: r.date, offset_seconds: r.offset,
            note: r.note || null, is_reset: !!r.isReset
          }));
          const { data: readingRows, error: rErr } = await sb.from('readings').insert(toInsert).select();
          if(rErr) throw rErr;
          newWatch.readings = readingRows.map(r => ({
            id: r.id, date: r.date, offset: Number(r.offset_seconds),
            note: r.note || '', isReset: r.is_reset || undefined
          }));
        }
        state.watches.push(newWatch);
      }
      if(!state.activeId && state.watches[0]) state.activeId = state.watches[0].id;
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

async function addWatch(name){
  saveStatus = 'saving'; render();
  const { data, error } = await sb.from('watches')
    .insert({ user_id: currentUser.id, name: name.trim() })
    .select().single();
  if(error){ saveStatus = 'error'; render(); return; }
  const w = {
    id: data.id, name: data.name, model: data.model || '', reference: data.reference || '',
    shareStats: !!data.share_stats,
    purchasePrice: null, purchaseCurrency: 'EUR', purchaseDate: '', photoUrl: '', conditionNotes: '',
    accuracySpec: '', powerReserveHours: null, lastWoundAt: null, certifications: [],
    wornDates: new Set(),
    readings: []
  };
  state.watches.push(w);
  state.activeId = w.id;
  saveState();
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

async function deleteWatch(watchId){
  saveStatus = 'saving'; render();
  const { error } = await sb.from('watches').delete().eq('id', watchId);
  if(error){ saveStatus = 'error'; render(); return; }
  state.watches = state.watches.filter(w => w.id !== watchId);
  if(state.activeId === watchId){
    state.activeId = state.watches[0] ? state.watches[0].id : null;
  }
  saveState();
}
