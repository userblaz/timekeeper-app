// Collection tab: portfolio-style view of owned watches — purchase price,
// current value, photo and condition notes, with totals and per-watch
// profit/loss. Persists straight to the `watches` table columns added for
// this feature; photos go to the `watch-photos` Supabase Storage bucket.

let editingCollectionId = null;
let collectionPhotoFile = null;

function fmtMoney(n){
  if(n === null || n === undefined || isNaN(n)) return '—';
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(n) + ' €';
}

function watchGainPct(w){
  if(!w.purchasePrice || !w.currentValue) return null;
  return ((w.currentValue - w.purchasePrice) / w.purchasePrice) * 100;
}

function collectionTotals(){
  const owned = state.watches.filter(w => w.currentValue !== null && w.currentValue !== undefined);
  const totalValue = owned.reduce((sum, w) => sum + (w.currentValue || 0), 0);
  const totalCost = owned.reduce((sum, w) => sum + (w.purchasePrice || 0), 0);
  const profit = totalCost > 0 ? totalValue - totalCost : null;
  const pct = totalCost > 0 ? (profit / totalCost) * 100 : null;
  return { totalValue, totalCost, profit, pct, count: state.watches.length };
}

function buildCollectionTabHtml(){
  const totals = collectionTotals();
  const pctBadge = totals.pct === null ? '' : `
    <span class="gain-badge ${totals.pct>=0?'good':'bad'}">${totals.pct>=0?'+':''}${totals.pct.toFixed(1)}%</span>
  `;
  const profitHtml = totals.profit === null ? '' : `
    <div class="collection-profit ${totals.profit>=0?'good':'bad'}">${totals.profit>=0?'+':''}${fmtMoney(totals.profit)} <span>profit</span></div>
  `;

  const watchesHtml = state.watches.length === 0
    ? `<p class="empty-note">Add a watch from the Data tab first, then fill in its collection details here.</p>`
    : state.watches.map(w => buildCollectionCard(w)).join('');

  return `
    <div class="collection-summary chart-box">
      <div class="chart-header">
        <div class="chart-label">Collection value</div>
      </div>
      <div class="collection-total-row">
        <div class="collection-total">${fmtMoney(totals.totalValue)}</div>
        ${pctBadge}
      </div>
      ${profitHtml}
    </div>

    <div class="section" style="margin-top:22px;">
      <h2 class="section-title">${state.watches.length} watch${state.watches.length===1?'':'es'} owned</h2>
      <div class="collection-list">${watchesHtml}</div>
    </div>
  `;
}

function buildCollectionCard(w){
  if(editingCollectionId === w.id){
    return buildCollectionEditForm(w);
  }
  const pct = watchGainPct(w);
  const pctBadge = pct === null ? '' : `<span class="gain-badge ${pct>=0?'good':'bad'}">${pct>=0?'+':''}${pct.toFixed(1)}%</span>`;
  const photoHtml = w.photoUrl
    ? `<img class="collection-photo" src="${w.photoUrl}" alt="${escapeHtml(w.name)}" />`
    : `<div class="collection-photo collection-photo-empty">＋</div>`;

  return `
    <div class="collection-card" data-action="editcollection" data-id="${w.id}">
      ${photoHtml}
      <div class="collection-card-body">
        <div class="collection-card-name">${escapeHtml(w.name)}</div>
        <div class="collection-card-value">${w.currentValue ? fmtMoney(w.currentValue) : 'no value set'}</div>
        ${w.conditionNotes ? `<div class="collection-card-note">${escapeHtml(w.conditionNotes)}</div>` : ''}
      </div>
      ${pctBadge}
    </div>
  `;
}

function buildCollectionEditForm(w){
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
          <label for="colPrice_${w.id}">Purchase price (€)</label>
          <input type="number" id="colPrice_${w.id}" step="1" value="${w.purchasePrice ?? ''}" />
        </div>
        <div class="field">
          <label for="colDate_${w.id}">Purchase date</label>
          <input type="date" id="colDate_${w.id}" value="${w.purchaseDate || ''}" />
        </div>
      </div>
      <div class="field">
        <label for="colValue_${w.id}">Current value (€)</label>
        <input type="number" id="colValue_${w.id}" step="1" value="${w.currentValue ?? ''}" />
      </div>
      <div class="field">
        <label for="colNotes_${w.id}">Notes / condition</label>
        <input type="text" id="colNotes_${w.id}" value="${escapeHtml(w.conditionNotes || '')}" placeholder="full set, box & papers…" />
      </div>
      <div class="row2" style="margin-top:6px;">
        <button type="button" class="btn-secondary" data-action="cancelcollection">Cancel</button>
        <button type="button" class="btn-primary" data-action="savecollection" data-id="${w.id}" style="flex:1">Save</button>
      </div>
    </div>
  `;
}

async function saveCollectionEdit(watchId){
  const priceEl = document.getElementById('colPrice_'+watchId);
  const dateEl = document.getElementById('colDate_'+watchId);
  const valueEl = document.getElementById('colValue_'+watchId);
  const notesEl = document.getElementById('colNotes_'+watchId);
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

  const updates = {
    purchase_price: priceEl.value === '' ? null : Number(priceEl.value),
    purchase_date: dateEl.value || null,
    current_value: valueEl.value === '' ? null : Number(valueEl.value),
    condition_notes: (notesEl.value || '').trim() || null,
    photo_url: photoUrl || null
  };
  const { error } = await sb.from('watches').update(updates).eq('id', watchId);
  if(error){ saveStatus = 'error'; render(); return; }

  w.purchasePrice = updates.purchase_price;
  w.purchaseDate = updates.purchase_date;
  w.currentValue = updates.current_value;
  w.conditionNotes = updates.condition_notes || '';
  w.photoUrl = updates.photo_url || '';

  editingCollectionId = null;
  collectionPhotoFile = null;
  saveState();
}

function attachCollectionHandlers(){
  document.querySelectorAll('[data-action="editcollection"]').forEach(el => {
    el.onclick = () => { editingCollectionId = el.dataset.id; collectionPhotoFile = null; render(); };
  });
  const cancelBtn = document.querySelector('[data-action="cancelcollection"]');
  if(cancelBtn) cancelBtn.onclick = () => { editingCollectionId = null; collectionPhotoFile = null; render(); };
  const saveBtn = document.querySelector('[data-action="savecollection"]');
  if(saveBtn) saveBtn.onclick = () => saveCollectionEdit(saveBtn.dataset.id);

  if(editingCollectionId){
    const photoInput = document.getElementById('colPhoto_'+editingCollectionId);
    if(photoInput) photoInput.onchange = (e) => {
      collectionPhotoFile = e.target.files[0] || null;
      render();
    };
  }
}
