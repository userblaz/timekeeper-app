// Data layer: app state, localStorage persistence, watch/reading CRUD, stats.
// This is the boundary to swap for Supabase later — everything else calls
// these functions without knowing where the data actually lives.

const STORAGE_KEY = 'timekeeper-watches';
let state = { watches: [], activeId: null };
let loaded = false;
let saveStatus = '';

async function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      state.watches = parsed.watches || [];
      state.activeId = parsed.activeId || (state.watches[0] ? state.watches[0].id : null);
    }
  }catch(e){
    // storage unavailable or corrupted — start empty
  }
  loaded = true;
  render();
}

async function saveState(){
  try{
    saveStatus = 'saving';
    render();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    saveStatus = 'saved';
  }catch(e){
    saveStatus = 'error';
  }
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
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      if(!parsed.watches) throw new Error('bad format');
      state.watches = parsed.watches;
      state.activeId = parsed.activeId || (state.watches[0] ? state.watches[0].id : null);
      saveState();
    }catch(e){
      alert("Couldn't read that file — make sure it's a Timekeeper backup JSON.");
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
    if(i === 0 || r.isReset) return {...r, rate:null, days:null};
    const prev = readings[i-1];
    const days = daysBetween(prev.date, r.date);
    const rate = days > 0 ? (r.offset - prev.offset) / days : null;
    return {...r, rate, days};
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

function addWatch(name){
  const w = { id: uid(), name: name.trim(), readings: [] };
  state.watches.push(w);
  state.activeId = w.id;
  saveState();
}

function addDemoWatch(){
  const names = ['Demo Chronometer', 'Demo Diver', 'Test Watch'];
  const name = names[Math.floor(Math.random()*names.length)] + ' ' + Math.floor(Math.random()*90+10);
  const dailyRate = Math.round((Math.random()*6 - 1.5) * 10) / 10; // roughly -1.5 to +4.5 s/day
  const w = { id: uid(), name, readings: [] };
  let offset = 0;
  const start = new Date();
  start.setDate(start.getDate() - 32);
  let dayCursor = 0;
  const gaps = [0, 3, 4, 5, 4, 6, 5, 5];
  gaps.forEach((gap, i) => {
    dayCursor += gap;
    if(i > 0){
      offset += dailyRate * gap + (Math.random()*2 - 1);
    }
    const d = new Date(start);
    d.setDate(d.getDate() + dayCursor);
    w.readings.push({
      id: uid(),
      date: d.toISOString().slice(0,10),
      offset: Math.round(offset),
      note: i === 0 ? 'set to reference' : ''
    });
  });
  state.watches.push(w);
  state.activeId = w.id;
  saveState();
}

function addReading(watchId, date, offset, note){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  w.readings.push({ id: uid(), date, offset: Number(offset), note: (note||'').trim() });
  saveState();
}

function ensureReadingIds(watch){
  watch.readings.forEach(r => { if(!r.id) r.id = uid(); });
}

function saveEditReading(watchId, id){
  const dateEl = document.getElementById('editDate_'+id);
  const offsetEl = document.getElementById('editOffset_'+id);
  const noteEl = document.getElementById('editNote_'+id);
  const resetEl = document.getElementById('editReset_'+id);
  if(!dateEl || !offsetEl || !dateEl.value || offsetEl.value === '') return;
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  const r = w.readings.find(x => x.id === id);
  if(!r) return;
  r.date = dateEl.value;
  r.offset = Number(offsetEl.value);
  r.note = (noteEl ? noteEl.value : '').trim();
  if(resetEl && resetEl.checked) r.isReset = true;
  else delete r.isReset;
  editingReadingId = null;
  saveState();
}

function deleteReading(watchId, id){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  w.readings = w.readings.filter(x => x.id !== id);
  editingReadingId = null;
  saveState();
}

function saveRenameWatch(id){
  const inp = document.getElementById('renameInput');
  renamingWatchId = null;
  if(!inp || !inp.value.trim()){ render(); return; }
  const w = state.watches.find(x => x.id === id);
  if(w) w.name = inp.value.trim();
  saveState();
}

function deleteWatch(watchId){
  state.watches = state.watches.filter(w => w.id !== watchId);
  if(state.activeId === watchId){
    state.activeId = state.watches[0] ? state.watches[0].id : null;
  }
  saveState();
}
