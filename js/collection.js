// Collection tab: portfolio-style view of owned watches — purchase price,
// current value, photo and condition notes, with totals and per-watch
// profit/loss. Persists straight to the `watches` table columns added for
// this feature; photos go to the `watch-photos` Supabase Storage bucket.

let editingCollectionId = null;
let collectionPhotoFile = null;
let addingCollectionWatch = false;
let viewingCollectionId = null;

const CERTIFICATION_OPTIONS = [
  'COSC',
  'METAS (Master Chronometer)',
  'Rolex Superlative Chronometer',
  'Patek Philippe Seal',
  'Geneva Seal',
  'Qualité Fleurier',
  'Chronofiable',
  'Omega Co-Axial Chronometer',
  'ISO 3159',
  'JIS',
  'A. Lange & Söhne in-house',
  'Grand Seiko VFA'
];

function fmtMoney(n){
  if(n === null || n === undefined || isNaN(n)) return '—';
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(n) + ' €';
}

function buildCollectionTabHtml(){
  if(viewingCollectionId){
    const w = state.watches.find(x => x.id === viewingCollectionId);
    if(w) return buildCollectionDetailHtml(w);
    viewingCollectionId = null;
  }

  const watchesHtml = state.watches.map(w => buildCollectionCard(w)).join('');
  const addHtml = addingCollectionWatch ? `
    <div class="collection-card collection-card-edit">
      <div class="field">
        <label for="newCollectionWatchName">Watch name</label>
        <input type="text" id="newCollectionWatchName" placeholder="e.g. Seiko 5, Speedmaster…" />
      </div>
      <div class="row2" style="margin-top:6px;">
        <button type="button" class="btn-secondary" data-action="canceladdcollectionwatch">Cancel</button>
        <button type="button" class="btn-primary" data-action="addcollectionwatch" style="flex:1">Add watch</button>
      </div>
    </div>
  ` : `
    <button type="button" class="collection-add-btn" data-action="startaddcollectionwatch">+ Add watch</button>
  `;

  return `
    <div class="section" style="margin-top:22px;padding-top:0;border-top:none;">
      <h2 class="section-title">${state.watches.length} watch${state.watches.length===1?'':'es'} owned</h2>
      <div class="collection-list">
        ${addHtml}
        ${typeof buildDemoWatchButtonHtml === 'function' ? buildDemoWatchButtonHtml() : ''}
        ${watchesHtml}
      </div>
    </div>
  `;
}

function buildCollectionCard(w){
  const photoHtml = w.photoUrl
    ? `<img class="collection-photo" src="${w.photoUrl}" alt="${escapeHtml(w.name)}" />`
    : `<div class="collection-photo collection-photo-empty">＋</div>`;
  const subtitle = [w.model, w.reference].filter(Boolean).join(' · ');

  return `
    <div class="collection-card" data-action="viewcollection" data-id="${w.id}">
      ${photoHtml}
      <div class="collection-card-body">
        <div class="collection-card-name">${escapeHtml(w.name)}</div>
        <div class="collection-card-value">${subtitle ? escapeHtml(subtitle) : 'no model/reference set'}</div>
        ${w.conditionNotes ? `<div class="collection-card-note">${escapeHtml(w.conditionNotes)}</div>` : ''}
      </div>
      ${w.accuracySpec ? `<span class="collection-card-spec">${escapeHtml(w.accuracySpec)}</span>` : ''}
      <button type="button" class="collection-delete-btn" data-action="deletecollectionwatch" data-id="${w.id}" aria-label="Delete ${escapeHtml(w.name)}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h16" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
        </svg>
      </button>
    </div>
  `;
}

// Groups interval rates by each logged condition (position/wear/time-of-day)
// and writes plain-English pointers where the spread between groups is large
// enough to be worth a second look. An interval's rate is attributed to the
// condition logged on its *later* reading, since that reading is what the
// condition dropdowns describe — e.g. "overnight" means the watch sat
// overnight leading up to that check.
function buildConditionInsightsHtml(watch){
  const rated = computeReadingRates(watch);
  const dimensions = [
    { key: 'position', label: 'position', options: POSITION_OPTIONS },
    { key: 'wearState', label: 'wear state', options: WEAR_STATE_OPTIONS },
    { key: 'timeOfDay', label: 'time of day', options: TIME_OF_DAY_OPTIONS }
  ];

  const blocks = [];
  const pointers = [];

  dimensions.forEach(dim => {
    const groups = {};
    rated.forEach(r => {
      const value = r[dim.key];
      if(!value || r.rate === null || r.rate === undefined) return;
      if(!groups[value]) groups[value] = [];
      groups[value].push(r.rate);
    });
    const entries = Object.entries(groups).filter(([, rates]) => rates.length > 0);
    if(entries.length < 2) return;

    const summarized = entries.map(([value, rates]) => {
      const avg = rates.reduce((a,b) => a+b, 0) / rates.length;
      const label = dim.options.find(([v]) => v === value)?.[1] || value;
      return { label, avg, count: rates.length };
    }).sort((a,b) => b.avg - a.avg);

    blocks.push(`
      <div style="margin-bottom:14px;">
        <div class="hint" style="margin-bottom:6px;text-transform:capitalize;">By ${dim.label}</div>
        ${summarized.map(s => `
          <div class="tg-stat-row"><span>${escapeHtml(s.label)} (${s.count} reading${s.count===1?'':'s'})</span><b style="color:${s.avg>=0?'#22C55E':'#F87171'}">${s.avg>=0?'+':''}${s.avg.toFixed(1)} s/day</b></div>
        `).join('')}
      </div>
    `);

    const spread = summarized[0].avg - summarized[summarized.length-1].avg;
    if(spread >= 0.5 && summarized[0].count >= 2 && summarized[summarized.length-1].count >= 2){
      pointers.push(`Runs faster ${summarized[0].label.toLowerCase()} (${summarized[0].avg>=0?'+':''}${summarized[0].avg.toFixed(1)} s/day) than ${summarized[summarized.length-1].label.toLowerCase()} (${summarized[summarized.length-1].avg>=0?'+':''}${summarized[summarized.length-1].avg.toFixed(1)} s/day) — a ${spread.toFixed(1)} s/day difference worth a closer look.`);
    }
  });

  if(blocks.length === 0){
    return `
      <div class="section">
        <h2 class="section-title">Insights</h2>
        <p class="empty-note">Log a few readings with different positions, wear states, or times of day to see whether they affect this watch's rate.</p>
      </div>
    `;
  }

  return `
    <div class="section">
      <h2 class="section-title">Insights</h2>
      ${pointers.length > 0 ? `<p class="hint" style="margin-bottom:16px;">${pointers.map(escapeHtml).join(' ')}</p>` : ''}
      ${blocks.join('')}
    </div>
  `;
}

function buildCollectionDetailHtml(w){
  if(editingCollectionId === w.id){
    return `
      <button type="button" class="reset-link" data-action="backtocollectionlist" style="margin:22px 0 14px;">‹ Back to collection</button>
      ${buildCollectionEditForm(w)}
    `;
  }

  const photoHtml = w.photoUrl
    ? `<img class="collection-photo" src="${w.photoUrl}" alt="${escapeHtml(w.name)}" />`
    : `<div class="collection-photo collection-photo-empty">＋</div>`;
  const bundle = buildWatchStatsBundle(w);
  const subtitle = [w.model, w.reference].filter(Boolean).join(' · ');

  const detailRows = [
    ['Brand & model', w.model || null],
    ['Reference number', w.reference || null],
    ['Purchase price', w.purchasePrice ? fmtMoney(w.purchasePrice) : null],
    ['Purchase date', w.purchaseDate ? formatShortDate(w.purchaseDate) : null],
    ['Factory accuracy spec', w.accuracySpec || null],
    ['Certificates', (w.certifications && w.certifications.length) ? w.certifications.join(', ') : null],
    ['Notes / condition', w.conditionNotes || null]
  ].filter(([, value]) => value);
  const detailsListHtml = detailRows.length === 0 ? '' : `
    <div class="section" style="margin-top:20px;padding-top:16px;">
      ${detailRows.map(([label, value]) => `
        <div class="tg-stat-row"><span>${label}</span><b>${escapeHtml(String(value))}</b></div>
      `).join('')}
    </div>
  `;

  return `
    <button type="button" class="reset-link" data-action="backtocollectionlist" style="margin:22px 0 14px;">‹ Back to collection</button>

    <div class="collection-card" style="cursor:default;">
      ${photoHtml}
      <div class="collection-card-body">
        <div class="collection-card-name">${escapeHtml(w.name)}</div>
        <div class="collection-card-value">${subtitle ? escapeHtml(subtitle) : 'no model/reference set'}</div>
      </div>
    </div>

    ${detailsListHtml}

    <button type="button" class="btn-secondary" data-action="startcollectionedit" data-id="${w.id}" style="margin-top:20px;width:100%;">Edit details</button>

    <div class="dial-wrap" style="margin-top:26px;">
      ${bundle.dialHtml}
    </div>

    ${buildConditionInsightsHtml(w)}

    ${bundle.chartsHtml}

    ${bundle.historySectionHtml}
  `;
}

function buildCollectionEditForm(w){
  const accuracyRange = parseAccuracySpec(w.accuracySpec);
  return `
    <div class="collection-card collection-card-edit">
      <div class="field">
        <label for="colPhoto_${w.id}">Photo</label>
        <label class="btn-secondary" style="text-align:center;cursor:pointer;">
          ${collectionPhotoFile ? 'New photo selected' : (w.photoUrl ? 'Change photo' : 'Add photo')}
          <input type="file" id="colPhoto_${w.id}" accept="image/*" style="display:none;" />
        </label>
      </div>
      <div class="row2">
        <div class="field">
          <label for="colModel_${w.id}">Brand & model</label>
          <input type="text" id="colModel_${w.id}" value="${escapeHtml(w.model || '')}" placeholder="e.g. Omega Speedmaster" />
        </div>
        <div class="field">
          <label for="colReference_${w.id}">Reference number</label>
          <input type="text" id="colReference_${w.id}" value="${escapeHtml(w.reference || '')}" placeholder="e.g. 311.30.42.30.01.005" />
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label for="colPrice_${w.id}">Purchase price (€)</label>
          <input type="number" id="colPrice_${w.id}" step="1" value="${w.purchasePrice ?? ''}" />
        </div>
        <div class="field">
          <label for="colDate_${w.id}">Purchase date</label>
          <input type="date" id="colDate_${w.id}" value="${w.purchaseDate || ''}" />
        </div>
      </div>
      <div class="field">
        <label>Factory accuracy spec (s/day)</label>
        <div class="row2">
          <div class="field stepper-row-field">
            <label for="colAccuracySlow_${w.id}">Slow</label>
            <div class="stepper-row">
              <button type="button" class="zoom-btn" data-action="accuracystep" data-id="${w.id}" data-field="slow" data-dir="-1">−</button>
              <input type="number" id="colAccuracySlow_${w.id}" step="1" placeholder="-4" value="${accuracyRange && accuracyRange.min < 0 ? accuracyRange.min : ''}" />
              <button type="button" class="zoom-btn" data-action="accuracystep" data-id="${w.id}" data-field="slow" data-dir="1">+</button>
            </div>
          </div>
          <div class="field stepper-row-field">
            <label for="colAccuracyFast_${w.id}">Fast</label>
            <div class="stepper-row">
              <button type="button" class="zoom-btn" data-action="accuracystep" data-id="${w.id}" data-field="fast" data-dir="-1">−</button>
              <input type="text" inputmode="numeric" id="colAccuracyFast_${w.id}" placeholder="+6" value="${accuracyRange && accuracyRange.max > 0 ? '+'+accuracyRange.max : (accuracyRange && accuracyRange.max < 0 ? accuracyRange.max : '')}" />
              <button type="button" class="zoom-btn" data-action="accuracystep" data-id="${w.id}" data-field="fast" data-dir="1">+</button>
            </div>
          </div>
        </div>
      </div>
      <div class="field">
        <label>Certificates</label>
        <div class="cert-checkbox-list">
          ${CERTIFICATION_OPTIONS.map(c => `
            <label class="cert-checkbox">
              <input type="checkbox" class="colCert_${w.id}" value="${escapeHtml(c)}" ${(w.certifications||[]).includes(c) ? 'checked' : ''} />
              <span>${escapeHtml(c)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="field">
        <label for="colNotes_${w.id}">Notes / condition</label>
        <input type="text" id="colNotes_${w.id}" value="${escapeHtml(w.conditionNotes || '')}" placeholder="full set, box & papers…" />
      </div>
      ${saveStatus === 'error' ? '<p class="hint" style="color:var(--bad);">Save failed — check your connection, or the database may be missing the collection columns (see the setup SQL).</p>' : ''}
      <div class="row2" style="margin-top:6px;">
        <button type="button" class="btn-secondary" data-action="cancelcollection">Cancel</button>
        <button type="button" class="btn-primary" data-action="savecollection" data-id="${w.id}" style="flex:1">${saveStatus==='saving' ? 'Saving…' : 'Save'}</button>
      </div>
      <button type="button" class="reset-link" data-action="deletecollectionwatch" data-id="${w.id}" style="margin-top:10px;">Delete "${escapeHtml(w.name)}"</button>
    </div>
  `;
}

async function saveCollectionEdit(watchId){
  const modelEl = document.getElementById('colModel_'+watchId);
  const referenceEl = document.getElementById('colReference_'+watchId);
  const priceEl = document.getElementById('colPrice_'+watchId);
  const dateEl = document.getElementById('colDate_'+watchId);
  const notesEl = document.getElementById('colNotes_'+watchId);
  const accuracySlowEl = document.getElementById('colAccuracySlow_'+watchId);
  const accuracyFastEl = document.getElementById('colAccuracyFast_'+watchId);
  const certEls = document.querySelectorAll('.colCert_'+watchId+':checked');
  const certifications = Array.from(certEls).map(el => el.value);
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;

  saveStatus = 'saving'; render();

  let photoUrl = w.photoUrl;
  if(collectionPhotoFile){
    const ext = collectionPhotoFile.name.split('.').pop();
    const path = `${currentUser.id}/${watchId}-${Date.now()}.${ext}`;
    const { error: upErr } = await sb.storage.from('watch-photos').upload(path, collectionPhotoFile, { upsert: true });
    if(upErr){ saveStatus = 'error'; render(); return; }
    const { data: pub } = sb.storage.from('watch-photos').getPublicUrl(path);
    photoUrl = pub.publicUrl;
  }

  const slowVal = accuracySlowEl.value === '' ? null : Number(accuracySlowEl.value);
  const fastVal = accuracyFastEl.value === '' ? null : Number(accuracyFastEl.value);
  const accuracySpec = (slowVal !== null || fastVal !== null)
    ? `${slowVal !== null ? (slowVal>0?'-':'')+slowVal : '—'}/${fastVal !== null ? (fastVal>0?'+':'')+fastVal : '—'} s/day`
    : null;

  const updates = {
    model: (modelEl.value || '').trim() || null,
    reference: (referenceEl.value || '').trim() || null,
    purchase_price: priceEl.value === '' ? null : Number(priceEl.value),
    purchase_date: dateEl.value || null,
    condition_notes: (notesEl.value || '').trim() || null,
    accuracy_spec: accuracySpec,
    certifications: certifications.length ? certifications.join(',') : null,
    photo_url: photoUrl || null
  };
  const { error } = await sb.from('watches').update(updates).eq('id', watchId);
  if(error){ saveStatus = 'error'; render(); return; }

  w.model = updates.model || '';
  w.reference = updates.reference || '';
  w.purchasePrice = updates.purchase_price;
  w.purchaseDate = updates.purchase_date;
  w.conditionNotes = updates.condition_notes || '';
  w.accuracySpec = updates.accuracy_spec || '';
  w.certifications = updates.certifications ? updates.certifications.split(',').filter(Boolean) : [];
  w.photoUrl = updates.photo_url || '';

  editingCollectionId = null;
  collectionPhotoFile = null;
  saveState();
}

async function addCollectionWatch(name){
  if(!name || !name.trim()) return;
  await addWatch(name.trim());
  addingCollectionWatch = false;
  viewingCollectionId = state.activeId;
  editingCollectionId = state.activeId;
  render();
}

function attachCollectionHandlers(){
  document.querySelectorAll('[data-action="viewcollection"]').forEach(el => {
    el.onclick = () => { viewingCollectionId = el.dataset.id; editingCollectionId = null; collectionPhotoFile = null; render(); };
  });
  const backBtn = document.querySelector('[data-action="backtocollectionlist"]');
  if(backBtn) backBtn.onclick = () => { viewingCollectionId = null; editingCollectionId = null; collectionPhotoFile = null; render(); };
  const startEditBtn = document.querySelector('[data-action="startcollectionedit"]');
  if(startEditBtn) startEditBtn.onclick = () => { editingCollectionId = startEditBtn.dataset.id; collectionPhotoFile = null; saveStatus = ''; render(); };
  const cancelBtn = document.querySelector('[data-action="cancelcollection"]');
  if(cancelBtn) cancelBtn.onclick = () => { editingCollectionId = null; collectionPhotoFile = null; render(); };
  const saveBtn = document.querySelector('[data-action="savecollection"]');
  if(saveBtn) saveBtn.onclick = () => saveCollectionEdit(saveBtn.dataset.id);
  document.querySelectorAll('[data-action="deletecollectionwatch"]').forEach(deleteBtn => {
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      const w = state.watches.find(x => x.id === deleteBtn.dataset.id);
      if(w && confirm(`Delete "${w.name}" and all its readings? This can't be undone.`)){
        editingCollectionId = null;
        viewingCollectionId = null;
        deleteWatch(deleteBtn.dataset.id);
      }
    };
  });

  if(editingCollectionId){
    const photoInput = document.getElementById('colPhoto_'+editingCollectionId);
    if(photoInput) photoInput.onchange = (e) => {
      collectionPhotoFile = e.target.files[0] || null;
      render();
    };
    const slowInput = document.getElementById('colAccuracySlow_'+editingCollectionId);
    if(slowInput) slowInput.onblur = () => {
      if(slowInput.value !== '' && Number(slowInput.value) > 0) slowInput.value = 0;
    };
    const fastInput = document.getElementById('colAccuracyFast_'+editingCollectionId);
    if(fastInput) fastInput.onblur = () => {
      if(fastInput.value !== '' && Number(fastInput.value) < 0) fastInput.value = '+0';
    };
  }

  document.querySelectorAll('[data-action="accuracystep"]').forEach(btn => {
    btn.onclick = () => {
      const input = document.getElementById(`colAccuracy${btn.dataset.field === 'slow' ? 'Slow' : 'Fast'}_${btn.dataset.id}`);
      if(!input) return;
      const current = input.value === '' ? 0 : Number(input.value);
      let next = current + Number(btn.dataset.dir);
      next = btn.dataset.field === 'slow' ? Math.min(0, next) : Math.max(0, next);
      input.value = (btn.dataset.field === 'fast' && next >= 0) ? '+'+next : String(next);
    };
  });

  const startAddBtn = document.querySelector('[data-action="startaddcollectionwatch"]');
  if(startAddBtn) startAddBtn.onclick = () => {
    addingCollectionWatch = true;
    render();
    setTimeout(()=>{ const inp = document.getElementById('newCollectionWatchName'); if(inp) inp.focus(); }, 0);
  };
  const cancelAddBtn = document.querySelector('[data-action="canceladdcollectionwatch"]');
  if(cancelAddBtn) cancelAddBtn.onclick = () => { addingCollectionWatch = false; render(); };
  const addBtn = document.querySelector('[data-action="addcollectionwatch"]');
  if(addBtn) addBtn.onclick = () => {
    const inp = document.getElementById('newCollectionWatchName');
    if(inp) addCollectionWatch(inp.value);
  };
  const nameInput = document.getElementById('newCollectionWatchName');
  if(nameInput) nameInput.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); addCollectionWatch(nameInput.value); }
  });
}
