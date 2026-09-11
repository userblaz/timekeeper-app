// Main app: UI state, render(), scroll handling, the tab-click wiring, and
// the final bootstrap calls at the bottom. Loaded last on purpose — every
// other file must be defined before this one runs its bootstrap code.

let selectedOffsetIdx = null;
let selectedDriftIdx = null;
let quickCaptured = null;
let manualMode = false;
let clockTimer = null;
let lastExportAt = null;
let chartZoom = 1;
let offsetScrollLeft = null;
let driftScrollLeft = null;
let editingReadingId = null;
let activeTab = 'data';

// The 5 standard COSC test positions — rate varies by orientation since
// gravity pulls differently on the balance wheel. Crown right is omitted:
// it mirrors crown left, so chronometer testing doesn't use it.
const POSITION_OPTIONS = [
  ['', 'Position (optional)'], ['DU', 'Dial up'], ['DD', 'Dial down'],
  ['CD', 'Crown down'], ['CL', 'Crown left'], ['CU', 'Crown up']
];
const WEAR_STATE_OPTIONS = [
  ['', 'Wear state (optional)'], ['worn', 'Worn on wrist'], ['rest', 'At rest'],
  ['winder', 'In a winder'], ['mixed', 'Mixed']
];
const TIME_OF_DAY_OPTIONS = [
  ['', 'Time of day (optional)'], ['overnight', 'Overnight'], ['day', 'Daytime'], ['mixed', 'Mixed']
];

// A custom dropdown rather than a native <select>: the popup a <select>
// opens is drawn by the OS and only partly honours CSS, so on some phones it
// came out unreadable (white-on-white, then dark-on-dark). The chosen value
// lives in a hidden input carrying the same id the caller asked for, so
// everything reading `document.getElementById(id).value` still works.
function buildSelect(id, options, selectedValue){
  const current = selectedValue || '';
  const currentLabel = (options.find(([value]) => value === current) || options[0])[1];
  const optionsHtml = options.map(([value, label]) =>
    `<button type="button" class="select-option${value===current?' selected':''}" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
  ).join('');
  return `
    <div class="select-wrap">
      <input type="hidden" id="${id}" value="${escapeHtml(current)}" />
      <button type="button" class="condition-select${current ? '' : ' placeholder'}" data-action="toggleselect" aria-expanded="false">
        <span class="select-value">${escapeHtml(currentLabel)}</span>
        <svg class="select-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <div class="select-menu" hidden>${optionsHtml}</div>
    </div>
  `;
}

function closeAllSelects(except){
  document.querySelectorAll('.select-wrap').forEach(wrap => {
    if(wrap === except) return;
    wrap.querySelector('.select-menu').hidden = true;
    wrap.querySelector('[data-action="toggleselect"]').setAttribute('aria-expanded', 'false');
  });
}

// Delegated once at load so it survives every re-render without rewiring.
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-action="toggleselect"]');
  if(toggle){
    e.preventDefault();
    e.stopPropagation();
    const wrap = toggle.closest('.select-wrap');
    const menu = wrap.querySelector('.select-menu');
    const willOpen = menu.hidden;
    closeAllSelects(wrap);
    menu.hidden = !willOpen;
    toggle.setAttribute('aria-expanded', String(willOpen));
    if(willOpen){
      // The menu is never scrollable, so when it doesn't fit below, open it
      // upward — but only if there's actually more room up there.
      menu.classList.remove('drop-up');
      const box = toggle.getBoundingClientRect();
      const spaceBelow = window.innerHeight - box.bottom;
      const spaceAbove = box.top;
      const needed = menu.getBoundingClientRect().height + 12;
      if(needed > spaceBelow && spaceAbove > spaceBelow) menu.classList.add('drop-up');
    }
    return;
  }

  const option = e.target.closest('.select-option');
  if(option){
    e.preventDefault();
    e.stopPropagation();
    const wrap = option.closest('.select-wrap');
    const button = wrap.querySelector('[data-action="toggleselect"]');
    wrap.querySelector('input[type="hidden"]').value = option.dataset.value;
    wrap.querySelector('.select-value').textContent = option.textContent;
    button.classList.toggle('placeholder', !option.dataset.value);
    wrap.querySelectorAll('.select-option').forEach(o => o.classList.toggle('selected', o === option));
    wrap.querySelector('.select-menu').hidden = true;
    button.setAttribute('aria-expanded', 'false');
    return;
  }

  closeAllSelects(null);
});

document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape') closeAllSelects(null);
});

function readConditionInputs(prefix){
  const positionEl = document.getElementById(prefix+'Position');
  const wearEl = document.getElementById(prefix+'Wear');
  const timeOfDayEl = document.getElementById(prefix+'TimeOfDay');
  return {
    position: positionEl ? positionEl.value : '',
    wearState: wearEl ? wearEl.value : '',
    timeOfDay: timeOfDayEl ? timeOfDayEl.value : ''
  };
}

function render(){
  const root = document.getElementById('root');
  if(!loaded){ root.innerHTML = 'Loading…'; return; }

  // Capture scroll position before rebuilding — but if the user was already
  // pinned to the right edge (viewing the newest point), keep it null so it
  // re-pins to the new right edge below, rather than freezing at the old
  // pixel offset once a new reading widens the chart.
  const existingOffsetScroll = document.getElementById('offsetChartScroll');
  if(existingOffsetScroll){
    const atEdge = existingOffsetScroll.scrollLeft >= existingOffsetScroll.scrollWidth - existingOffsetScroll.clientWidth - 4;
    offsetScrollLeft = atEdge ? null : existingOffsetScroll.scrollLeft;
  }
  const existingDriftScroll = document.getElementById('driftChartScroll');
  if(existingDriftScroll){
    const atEdge = existingDriftScroll.scrollLeft >= existingDriftScroll.scrollWidth - existingDriftScroll.clientWidth - 4;
    driftScrollLeft = atEdge ? null : existingDriftScroll.scrollLeft;
  }

  // While the capture panel is open the clock is held collapsed outright,
  // rather than scrolling far enough to collapse it the normal way — that
  // would drag the panel's own top up under the header, and the two can't
  // both be satisfied by scroll position alone. Derived here, once, so a tab
  // switch or a watch change can't leave it stuck on.
  setClockCollapsed(activeTab === 'data' && !manualMode && !!quickCaptured);

  const watch = activeWatch();
  const tabsSlotEl0 = document.getElementById('tabsSlot');

  if(activeTab === 'clock'){
    if(tabsSlotEl0) tabsSlotEl0.innerHTML = '';
    root.innerHTML = buildClockTabHtml();
    attachHandlers(watch);
    updateAnalogClock();
    if(typeof updateClockCollapse === 'function') updateClockCollapse();
    return;
  }
  if(activeTab === 'timegrapher'){
    if(tabsSlotEl0) tabsSlotEl0.innerHTML = '';
    root.innerHTML = buildTimegrapherTabHtml();
    attachHandlers(watch);
    if(typeof updateClockCollapse === 'function') updateClockCollapse();
    return;
  }
  if(activeTab === 'collection'){
    if(tabsSlotEl0) tabsSlotEl0.innerHTML = '';
    root.innerHTML = buildCollectionTabHtml();
    attachCollectionHandlers();
    const viewedWatch = state.watches.find(w => w.id === viewingCollectionId);
    if(viewedWatch && editingCollectionId !== viewedWatch.id){
      attachWatchStatsHandlers(viewedWatch);
      wireChartAndHistoryScroll();
    }
    if(typeof updateClockCollapse === 'function') updateClockCollapse();
    return;
  }

  let tabsHtml = state.watches.map(w => `
    <button class="tab ${w.id===state.activeId?'active':''}" data-action="select" data-id="${w.id}">${escapeHtml(w.name)}</button>
  `).join('');
  // Sits alongside the watch names so adding one is reachable from here
  // instead of only from the Collection tab. Spelled out rather than a bare
  // glyph, and in the same type as the names so the row keeps one baseline.
  tabsHtml += `<button class="tab tab-add" data-action="jumptoaddwatch" aria-label="Add a watch"><span class="tab-add-plus">+</span> Add watch</button>`;

  let bodyHtml = '';

  if(!watch){
    bodyHtml = '';
  } else {
    const bundle = buildWatchStatsBundle(watch);

    bodyHtml = `
      <div class="dial-wrap">
        ${bundle.dialHtml}
      </div>

      <div class="section" style="margin-top:8px;padding-top:0;border-top:none;">
        ${buildQuickLogArea()}
      </div>

      ${bundle.chartsHtml}

      ${bundle.historySectionHtml}
    `;
  }

  // Nothing to say when idle — the status line only appears while a save is
  // in flight, has failed, or a backup was just exported.
  const statusText = saveStatus === 'saving' ? 'saving…'
    : saveStatus === 'error' ? 'save failed — storage may be full or blocked'
    : lastExportAt ? 'backed up ' + lastExportAt.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
    : '';

  root.innerHTML = `
    ${bodyHtml}
    <div class="footer-row" style="flex-direction:column;align-items:stretch;gap:10px;">
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" data-action="export" style="flex:1;font-size:12px;padding:10px;">Export backup (.json)</button>
        <label class="btn-secondary" style="flex:1;font-size:12px;padding:10px;text-align:center;cursor:pointer;">
          Import backup
          <input type="file" id="importFile" accept="application/json" style="display:none;" />
        </label>
      </div>
      ${statusText ? `<span class="status ${saveStatus==='error'?'err':''}">${statusText}</span>` : ''}
    </div>
  `;

  const tabsSlotEl = document.getElementById('tabsSlot');
  if(tabsSlotEl) tabsSlotEl.innerHTML = `<div class="tabs">${tabsHtml}</div>`;

  attachHandlers(watch);
  wireChartAndHistoryScroll();
  if(typeof updateClockCollapse === 'function') updateClockCollapse();
}


// Wires up the offset/drift chart horizontal scroll + custom scrollbar, and
// the history list's vertical scrollbar. Shared by the Data tab's own watch
// view and the Collection tab's per-watch detail view — both render charts
// and history into the same element ids (#offsetChartScroll etc), just one
// tab's markup is in the DOM at a time.
function wireChartAndHistoryScroll(){
  const offsetScrollEl = document.getElementById('offsetChartScroll');
  if(offsetScrollEl){
    offsetScrollEl.scrollLeft = (offsetScrollLeft !== null) ? offsetScrollLeft : offsetScrollEl.scrollWidth;
    offsetScrollEl.onscroll = () => updateChartScrollbar('offset');
    updateChartScrollbar('offset');
    makeThumbDraggable('offsetChartScrollThumb', 'offsetChartScrollTrack', 'offsetChartScroll', 'x');
  }
  const driftScrollEl = document.getElementById('driftChartScroll');
  if(driftScrollEl){
    driftScrollEl.scrollLeft = (driftScrollLeft !== null) ? driftScrollLeft : driftScrollEl.scrollWidth;
    driftScrollEl.onscroll = () => updateChartScrollbar('drift');
    updateChartScrollbar('drift');
    makeThumbDraggable('driftChartScrollThumb', 'driftChartScrollTrack', 'driftChartScroll', 'x');
  }

  const histScrollEl = document.getElementById('historyScroll');
  if(histScrollEl){
    histScrollEl.onscroll = updateHistoryScrollbar;
    updateHistoryScrollbar();
    makeThumbDraggable('historyScrollThumb', 'historyScrollTrack', 'historyScroll', 'y');
  }
}


// Builds the dial figure, offset/drift charts, and history list for one
// watch — shared by the Data tab and the Collection tab's detail view.
function buildWatchStatsBundle(watch){
  ensureReadingIds(watch);
  const rated = computeReadingRates(watch);
  if(selectedOffsetIdx !== null && selectedOffsetIdx >= rated.length) selectedOffsetIdx = null;
  if(selectedDriftIdx !== null && selectedDriftIdx >= rated.length) selectedDriftIdx = null;
  const stats = overallStats(watch);
  const dialHtml = stats ? `
    <div class="dial-figure" style="color:${stats.avgRate>=0?'#22C55E':'#F87171'}">${fmtRate(stats.avgRate)}<span class="dial-unit"> s/day</span></div>
    <div class="dial-meta">average over ${stats.days} day${stats.days===1?'':'s'} · ${stats.count} readings${stats.sinceReset ? ' · since reset' : ''}</div>
  ` : `<div class="empty-dial">Log two readings to see your watch's drift rate.</div>`;

  const historyHtml = rated.length === 0 ? '<p class="empty-note">No readings yet.</p>' :
    [...rated].reverse().map(r => {
      if(r.id === editingReadingId){
        return `<div class="history-item history-edit-row">
          <div class="row2">
            <div class="field"><label for="editDate_${r.id}">Date</label><input type="date" id="editDate_${r.id}" value="${r.date}" /></div>
            <div class="field"><label for="editOffset_${r.id}">Offset (s)</label><input type="number" id="editOffset_${r.id}" value="${r.offset}" /></div>
          </div>
          <div class="field" style="margin-top:12px;">
            <label for="editNote_${r.id}">Note</label>
            <input type="text" id="editNote_${r.id}" value="${escapeHtml(r.note||'')}" />
          </div>
          <div class="field">${buildSelect('editPosition_'+r.id, POSITION_OPTIONS, r.position)}</div>
          <div class="field">${buildSelect('editWear_'+r.id, WEAR_STATE_OPTIONS, r.wearState)}</div>
          <div class="field">${buildSelect('editTimeOfDay_'+r.id, TIME_OF_DAY_OPTIONS, r.timeOfDay)}</div>
          <label class="reset-check-row" for="editReset_${r.id}" style="margin-top:12px;">
            <input type="checkbox" id="editReset_${r.id}" ${r.isReset ? 'checked' : ''} />
            Mark as reset point (watch was just serviced or regulated)
          </label>
          <div class="row2" style="margin-top:12px;">
            <button type="button" class="btn-secondary" data-action="canceledit">Cancel</button>
            <button type="button" class="btn-primary" data-action="saveedit" data-id="${r.id}" style="flex:1">Save</button>
          </div>
          <button type="button" class="reset-link" data-action="deletereading" data-id="${r.id}" style="margin-top:12px;">Delete this reading</button>
        </div>`;
      }
      const rateHtml = r.rate === null
        ? `<span class="hist-rate" style="color:var(--grey)">${r.isReset ? '⟲ reset' : 'reference'}</span>`
        : `<span class="hist-rate ${r.rate>=0?'slow':'fast'}">${fmtRate(r.rate)} s/day</span>`;
      const conditionLabels = [
        r.position ? POSITION_OPTIONS.find(([v])=>v===r.position)?.[1] : null,
        r.wearState ? WEAR_STATE_OPTIONS.find(([v])=>v===r.wearState)?.[1] : null,
        r.timeOfDay ? TIME_OF_DAY_OPTIONS.find(([v])=>v===r.timeOfDay)?.[1] : null
      ].filter(Boolean).join(' · ');
      // Conditions and note share one line, capped so a row is never taller
      // than two lines — the full text is still there when the row is tapped
      // open for editing.
      const metaLine = [conditionLabels, r.note].filter(Boolean).join(' · ');
      return `<div class="history-item" data-action="edithistory" data-id="${r.id}">
        <div class="hist-main">
          <span class="hist-date">${r.date} · offset ${r.offset>0?'+':''}${r.offset}s</span>
          ${rateHtml}
        </div>
        ${metaLine ? `<div class="hist-note">${escapeHtml(metaLine)}</div>` : ''}
      </div>`;
    }).join('');

  const chartsHtml = `
    <div class="chart-box">
      <div class="chart-header">
        <div class="chart-label">offset over time (sec, cumulative since set)</div>
        <div class="chart-zoom">
          <button type="button" class="zoom-btn" data-action="zoomout">−</button>
          <button type="button" class="zoom-btn" data-action="zoomin">+</button>
        </div>
      </div>
      ${buildOffsetChart(rated, selectedOffsetIdx)}
    </div>
    <div class="chart-box">
      <div class="chart-header">
        <div class="chart-label">drift trend (sec/day between readings)</div>
        <div class="chart-zoom">
          <button type="button" class="zoom-btn" data-action="zoomout">−</button>
          <button type="button" class="zoom-btn" data-action="zoomin">+</button>
        </div>
      </div>
      ${buildChart(rated, selectedDriftIdx, watch.accuracySpec, stats ? stats.avgRate : null)}
    </div>
  `;

  const historySectionHtml = `
    <div class="section">
      <h2 class="section-title">History</h2>
      <div class="history-wrap">
        <div class="history-scroll${editingReadingId ? ' editing' : ''}" id="historyScroll">${historyHtml}</div>
        <div class="history-scrollbar-track custom-scrollbar-track" id="historyScrollTrack"><div class="history-scrollbar-thumb custom-scrollbar-thumb" id="historyScrollThumb"></div></div>
      </div>
    </div>
  `;

  return { dialHtml, chartsHtml, historySectionHtml };
}


// Scrolls the page so `el` sits in the gap between the sticky header and the
// bottom tab bar — both are fixed, so a plain scrollIntoView would happily
// park it underneath either one. With pinTop the element's top is brought up
// against the header whether or not it already fits, which also carries the
// page past the point where the clock collapses and frees up the room.
function scrollPanelIntoView(el, pinTop){
  if(!el) return;

  const step = () => {
    const header = document.getElementById('stickyHeader');
    const tabs = document.querySelector('.bottom-tabs');
    // Pin flush to the header, with no gap of its own: the header already
    // carries 8px of its own background below the watch-tab row, so the panel
    // still looks like it floats clear — and a real gap would be a window
    // onto whatever content is scrolled behind, which reads as the panel
    // being clipped rather than as space.
    const topGap = pinTop ? 0 : 10;
    // Where the header's bottom edge will be once we've scrolled, not where
    // it is now. It's position:sticky, so until the page has scrolled past
    // it it's still sitting in flow, lower down — measuring that and then
    // scrolling makes it rise, which is a second moving target on top of the
    // collapse. Once stuck it settles at its `top` offset, so take the lower
    // of the two and the first pass is already the final geometry.
    let headerBottom = 0;
    if(header){
      const rect = header.getBoundingClientRect();
      const stuckTop = parseFloat(getComputedStyle(header).top) || 0;
      headerBottom = Math.min(rect.bottom, stuckTop + rect.height);
    }
    const topLimit = headerBottom + topGap;
    const bottomLimit = (tabs ? tabs.getBoundingClientRect().top : window.innerHeight) - 10;
    const box = el.getBoundingClientRect();

    let delta = 0;
    if(pinTop || box.height > bottomLimit - topLimit){
      delta = box.top - topLimit;        // pin the top: taller than the gap, or asked for
    } else if(box.bottom > bottomLimit){
      delta = box.bottom - bottomLimit;  // hanging below the tab bar
    } else if(box.top < topLimit){
      delta = box.top - topLimit;        // tucked under the header
    }
    if(Math.abs(delta) <= 1) return true;
    window.scrollTo({ top: window.scrollY + delta, behavior: 'auto' });
    return false;
  };

  // Why this iterates instead of scrolling once: the header collapses as the
  // page scrolls, shrinking the very gap just measured against, so a single
  // pass always lands short. Each pass closes part of what remains and the
  // collapse has a hard stop, so this converges in a handful of frames. The
  // scrolls are instant and one frame apart — the whole run is over in well
  // under a tenth of a second and reads as a single jump.
  let passes = 0;
  const run = () => {
    if(step() || ++passes > 12) return;
    requestAnimationFrame(run);
  };
  run();
}


// Puts the open capture panel back where it belongs. Call it straight after
// a render(), synchronously: render() has already collapsed the header, so
// the first measurement is the final geometry and the page arrives in one
// paint rather than converging over several frames.
//
// Needed on returning to the Data tab as well as on capture. The other tabs
// are shorter pages, so switching away clamps the scroll position to fit
// them, and the browser has no memory of where this tab was — coming back
// left the panel open but the page at the top, no longer pinned.
function pinCapturePanel(){
  if(!quickCaptured || manualMode || activeTab !== 'data') return;
  scrollPanelIntoView(document.querySelector('.quick-log-box'), true);
}


function scrollEditRowIntoView(){
  scrollPanelIntoView(document.querySelector('.history-edit-row'), false);
}

// Chart zoom buttons, chart-dot selection, and history-row edit/save/delete
// — shared by the Data tab and the Collection tab's detail view.
function attachWatchStatsHandlers(watch){
  document.querySelectorAll('[data-action="zoomin"]').forEach(el=>{
    el.onclick = () => {
      chartZoom = Math.min(3, Math.round((chartZoom + 0.4) * 10) / 10);
      offsetScrollLeft = null; driftScrollLeft = null;
      render();
    };
  });
  document.querySelectorAll('[data-action="zoomout"]').forEach(el=>{
    el.onclick = () => {
      chartZoom = Math.max(0.5, Math.round((chartZoom - 0.4) * 10) / 10);
      offsetScrollLeft = null; driftScrollLeft = null;
      render();
    };
  });

  document.querySelectorAll('[data-action="edithistory"]').forEach(el=>{
    el.onclick = () => {
      editingReadingId = el.dataset.id;
      render();
      // The form is far taller than the row it replaced, so it usually opens
      // running off the bottom of the screen. One frame for layout to settle,
      // then bring it fully into view.
      requestAnimationFrame(scrollEditRowIntoView);
    };
  });
  const cancelEditBtn = document.querySelector('[data-action="canceledit"]');
  if(cancelEditBtn) cancelEditBtn.onclick = () => { editingReadingId = null; render(); };
  const saveEditBtn = document.querySelector('[data-action="saveedit"]');
  if(saveEditBtn) saveEditBtn.onclick = () => saveEditReading(watch.id, saveEditBtn.dataset.id);
  const deleteReadingBtn = document.querySelector('[data-action="deletereading"]');
  if(deleteReadingBtn) deleteReadingBtn.onclick = () => {
    if(confirm('Delete this reading?')) deleteReading(watch.id, deleteReadingBtn.dataset.id);
    else { editingReadingId = null; render(); }
  };

  document.querySelectorAll('.chart-dot').forEach(el=>{
    el.onclick = () => {
      const idx = Number(el.dataset.idx);
      if(el.dataset.chart === 'offset'){
        selectedOffsetIdx = (selectedOffsetIdx === idx) ? null : idx;
      } else {
        selectedDriftIdx = (selectedDriftIdx === idx) ? null : idx;
      }
      render();
    };
  });
}


function makeThumbDraggable(thumbId, trackId, scrollId, axis){
  const thumb = document.getElementById(thumbId);
  const track = document.getElementById(trackId);
  const scrollEl = document.getElementById(scrollId);
  if(!thumb || !track || !scrollEl) return;
  thumb.onpointerdown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startScroll = axis === 'x' ? scrollEl.scrollLeft : scrollEl.scrollTop;
    const trackSize = axis === 'x' ? track.clientWidth : track.clientHeight;
    const contentSize = axis === 'x' ? scrollEl.scrollWidth : scrollEl.scrollHeight;
    const visibleSize = axis === 'x' ? scrollEl.clientWidth : scrollEl.clientHeight;
    const maxScroll = contentSize - visibleSize;
    const thumbSize = axis === 'x' ? thumb.offsetWidth : thumb.offsetHeight;
    const trackRange = trackSize - thumbSize;
    function onMove(ev){
      const pos = axis === 'x' ? ev.clientX : ev.clientY;
      const delta = pos - startPos;
      const scrollDelta = trackRange > 0 ? (delta / trackRange) * maxScroll : 0;
      let newScroll = startScroll + scrollDelta;
      newScroll = Math.max(0, Math.min(maxScroll, newScroll));
      if(axis === 'x') scrollEl.scrollLeft = newScroll;
      else scrollEl.scrollTop = newScroll;
    }
    function onUp(){
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };
}


function updateChartScrollbar(key){
  const scrollEl = document.getElementById(key+'ChartScroll');
  const track = document.getElementById(key+'ChartScrollTrack');
  const thumb = document.getElementById(key+'ChartScrollThumb');
  if(!scrollEl || !track || !thumb) return;
  const trackW = track.clientWidth;
  const contentW = scrollEl.scrollWidth;
  const visibleW = scrollEl.clientWidth;
  if(contentW <= visibleW + 1){
    track.style.display = 'none';
    return;
  }
  track.style.display = 'block';
  const thumbW = Math.max(20, (visibleW / contentW) * trackW);
  const maxScroll = contentW - visibleW;
  const scrollFrac = maxScroll > 0 ? scrollEl.scrollLeft / maxScroll : 0;
  const thumbLeft = scrollFrac * (trackW - thumbW);
  thumb.style.width = thumbW + 'px';
  thumb.style.left = thumbLeft + 'px';
}


function updateHistoryScrollbar(){
  const scrollEl = document.getElementById('historyScroll');
  const track = document.getElementById('historyScrollTrack');
  const thumb = document.getElementById('historyScrollThumb');
  if(!scrollEl || !track || !thumb) return;
  const trackH = track.clientHeight;
  const contentH = scrollEl.scrollHeight;
  const visibleH = scrollEl.clientHeight;
  if(contentH <= visibleH + 1){
    track.style.display = 'none';
    return;
  }
  track.style.display = 'block';
  const thumbH = Math.max(20, (visibleH / contentH) * trackH);
  const maxScroll = contentH - visibleH;
  const scrollFrac = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0;
  const thumbTop = scrollFrac * (trackH - thumbH);
  thumb.style.height = thumbH + 'px';
  thumb.style.top = thumbTop + 'px';
}


function buildQuickLogArea(){
  if(manualMode) return buildManualForm();

  if(!quickCaptured){
    return `
      <div class="quick-log-box">
        <p class="hint">Watch your mechanical watch's second hand against the clock above. The instant it crosses a mark, tap it:</p>
        <div class="quick-btns">
          <button type="button" class="quick-btn" data-action="quicksec" data-sec="0">:00</button>
          <button type="button" class="quick-btn" data-action="quicksec" data-sec="15">:15</button>
          <button type="button" class="quick-btn" data-action="quicksec" data-sec="30">:30</button>
          <button type="button" class="quick-btn" data-action="quicksec" data-sec="45">:45</button>
        </div>
        <button type="button" class="manual-link" data-action="manualmode">Enter offset manually instead</button>
      </div>
    `;
  }

  const c = quickCaptured.at;
  const timeStr = pad2(c.getHours()) + ':' + pad2(c.getMinutes()) + ':' + pad2(quickCaptured.second);
  // Seconds the watch is ahead of (+) or behind (-) true time, from the mark
  // that was tapped against the phone's own seconds. Wrapped into ±30 so a
  // watch two seconds fast reads as +2 rather than -58. The hour and minute
  // fields below default to the phone's, so this is the whole of the reading
  // unless they're overridden.
  let aheadBy = quickCaptured.second - c.getSeconds();
  while(aheadBy > 30) aheadBy -= 60;
  while(aheadBy <= -30) aheadBy += 60;
  return `
    <div class="quick-log-box snap-flash">
      <div class="confirm-time ${aheadBy >= 0 ? 'ahead' : 'behind'}">${timeStr}</div>
      <div class="confirm-sub">captured at <b>${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}</b> phone time</div>
      <div class="row2">
        <div class="field"><label for="qH">Watch hour</label><input type="number" id="qH" min="0" max="23" placeholder="${pad2(c.getHours())}" /></div>
        <div class="field"><label for="qM">Watch min</label><input type="number" id="qM" min="0" max="59" placeholder="${pad2(c.getMinutes())}" /></div>
      </div>
      <p class="hint" style="margin-top:10px;">Leave blank if your watch's hour and minute matched the phone's.</p>
      <div class="field">${buildSelect('qPosition', POSITION_OPTIONS)}</div>
      <div class="field">${buildSelect('qWear', WEAR_STATE_OPTIONS)}</div>
      <div class="field">${buildSelect('qTimeOfDay', TIME_OF_DAY_OPTIONS)}</div>
      <div class="field">
        <label for="qNote">Note (optional)</label>
        <input type="text" id="qNote" placeholder="worn daily, dial up overnight…" />
      </div>
      <div class="row2" style="margin-top:12px;">
        <button type="button" class="btn-secondary" data-action="quickcancel">Cancel</button>
        <button type="button" class="btn-primary" data-action="quickconfirm" style="flex:1">Log reading</button>
      </div>
    </div>
  `;
}


function buildManualForm(){
  return `
    <button type="button" class="manual-link" data-action="quickmode" style="margin:0 0 12px;">← Use quick tap instead</button>
    <form id="readingForm">
      <div class="row2">
        <div class="field">
          <label for="rDate">Date checked</label>
          <input type="date" id="rDate" required value="${todayStr()}" />
        </div>
        <div class="field">
          <label for="rOffset">Cumulative offset (sec)</label>
          <input type="number" id="rOffset" step="1" placeholder="e.g. -4 or 12" required />
        </div>
      </div>
      <p class="hint">Offset = how far the watch has drifted from correct time since you set it (negative = slow, positive = fast).</p>
      <div class="field">${buildSelect('rPosition', POSITION_OPTIONS)}</div>
      <div class="field">${buildSelect('rWear', WEAR_STATE_OPTIONS)}</div>
      <div class="field">${buildSelect('rTimeOfDay', TIME_OF_DAY_OPTIONS)}</div>
      <div class="field">
        <label for="rNote">Note (optional)</label>
        <input type="text" id="rNote" placeholder="worn daily, dial up overnight…" />
      </div>
      <button type="submit" class="btn-primary">Add reading</button>
    </form>
  `;
}


function attachHandlers(watch){
  document.querySelectorAll('[data-action="select"]').forEach(el=>{
    el.onclick = () => { if(tgListening) tgAbort(); state.activeId = el.dataset.id; selectedOffsetIdx=null; selectedDriftIdx=null; offsetScrollLeft=null; driftScrollLeft=null; editingReadingId=null; render(); };
  });

  // The + beside the watch names. Rather than duplicate the add form here,
  // it opens the Collection tab in exactly the state the tab's own "+ Add
  // watch" button would leave it in, then puts the cursor in the name field.
  const jumpAddBtn = document.querySelector('[data-action="jumptoaddwatch"]');
  if(jumpAddBtn) jumpAddBtn.onclick = () => {
    if(tgListening) tgAbort();
    activeTab = 'collection';
    viewingCollectionId = null;
    editingCollectionId = null;
    addingCollectionWatch = true;
    syncBottomTabs();
    render();
    const nameEl = document.getElementById('newCollectionWatchName');
    if(nameEl) nameEl.focus();
  };

  const form = document.getElementById('readingForm');
  if(form) form.onsubmit = (e) => {
    e.preventDefault();
    const date = document.getElementById('rDate').value;
    const offset = document.getElementById('rOffset').value;
    const note = document.getElementById('rNote').value;
    if(!date || offset === '') return;
    addReading(watch.id, date, offset, note, readConditionInputs('r'));
  };

  const toggleBtn = document.querySelector('[data-action="manualmode"]');
  if(toggleBtn) toggleBtn.onclick = () => { manualMode = true; quickCaptured = null; render(); };

  const quickModeBtn = document.querySelector('[data-action="quickmode"]');
  if(quickModeBtn) quickModeBtn.onclick = () => { manualMode = false; quickCaptured = null; render(); };

  if(watch) attachWatchStatsHandlers(watch);

  const tgStartBtn = document.querySelector('[data-action="tgstart"]');
  if(tgStartBtn) tgStartBtn.onclick = () => tgStart();
  const tgStopBtn = document.querySelector('[data-action="tgstop"]');
  if(tgStopBtn) tgStopBtn.onclick = () => tgStop();
  const tgSensSlider = document.getElementById('tgSensSlider');
  if(tgSensSlider){
    tgSensSlider.oninput = (e) => {
      tgSensitivity = parseFloat(e.target.value);
      const label = document.getElementById('tgSensValue');
      if(label) label.textContent = tgSensitivity.toFixed(1) + '×';
    };
  }

  document.querySelectorAll('[data-action="quicksec"]').forEach(el=>{
    el.onclick = () => {
      quickCaptured = { at: trueNow(), second: Number(el.dataset.sec) };
      playShutterSound();
      render();
      pinCapturePanel();
    };
  });

  const quickCancelBtn = document.querySelector('[data-action="quickcancel"]');
  // Cancelling undoes the jump the capture made, so the page is back where
  // it started rather than parked halfway down with the tap buttons above
  // the fold.
  if(quickCancelBtn) quickCancelBtn.onclick = () => {
    quickCaptured = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const quickConfirmBtn = document.querySelector('[data-action="quickconfirm"]');
  if(quickConfirmBtn) quickConfirmBtn.onclick = () => {
    if(!quickCaptured) return;
    const c = quickCaptured.at;
    const qH = document.getElementById('qH');
    const qM = document.getElementById('qM');
    const qNote = document.getElementById('qNote');
    const h = qH.value === '' ? c.getHours() : Number(qH.value);
    const m = qM.value === '' ? c.getMinutes() : Number(qM.value);
    const note = qNote ? qNote.value : '';
    const phoneSec = c.getHours()*3600 + c.getMinutes()*60 + c.getSeconds();
    const watchSec = h*3600 + m*60 + quickCaptured.second;
    let diff = watchSec - phoneSec;
    while(diff > 43200) diff -= 86400;
    while(diff <= -43200) diff += 86400;
    const date = c.toISOString().slice(0,10);
    const conditions = readConditionInputs('q');
    quickCaptured = null;
    addReading(watch.id, date, diff, note, conditions);
  };

  const exportBtn = document.querySelector('[data-action="export"]');
  if(exportBtn) exportBtn.onclick = () => exportData();

  const importInput = document.getElementById('importFile');
  if(importInput) importInput.onchange = (e) => {
    const file = e.target.files[0];
    if(file) importData(file);
  };
}


// --- tab switching ---
// The bottom bar lives outside #root, so render() never touches it — its
// highlight has to be moved by hand whenever activeTab changes, including
// when something other than the bar itself changes it.
function syncBottomTabs(){
  document.querySelectorAll('.bottom-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeTab);
  });
}

document.querySelectorAll('.bottom-tab').forEach(btn => {
  btn.onclick = () => {
    if(tgListening && btn.dataset.tab !== 'timegrapher') tgAbort();
    activeTab = btn.dataset.tab;
    syncBottomTabs();
    editingReadingId = null;
    editingCollectionId = null;
    viewingCollectionId = null;
    render();
    pinCapturePanel();
  };
});

// --- bootstrap ---
// loadState()/syncTrueTime() are no longer called from here. Since the app
// is now gated behind login, js/auth.js triggers them once a session is
// confirmed — see handleSignedIn() there.
