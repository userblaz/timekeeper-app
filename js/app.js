// Main app: UI state, render(), scroll handling, the tab-click wiring, and
// the final bootstrap calls at the bottom. Loaded last on purpose — every
// other file must be defined before this one runs its bootstrap code.

let selectedOffsetIdx = null;
let selectedDriftIdx = null;
let quickCaptured = null;
let quickMinuteValue = null;
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
  ['', 'Position'], ['DU', 'Dial up'], ['DD', 'Dial down'],
  ['CD', 'Crown down'], ['CL', 'Crown left'], ['CU', 'Crown up']
];
const WEAR_STATE_OPTIONS = [
  ['', 'Wear state'], ['worn', 'Worn on wrist'], ['rest', 'At rest'],
  ['winder', 'In a winder'], ['mixed', 'Mixed']
];
const TIME_OF_DAY_OPTIONS = [
  ['', 'Time of day'], ['overnight', 'Overnight'], ['day', 'Daytime'], ['mixed', 'Mixed']
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

// A transient message that floats above the bottom dock, over everything,
// and takes itself away. It lives outside #root, so a render() can't destroy
// it mid-life, and showing one never reflows the page underneath.
let toastTimer = null;
function showToast(message, kind){
  if(!message) return;
  let el = document.getElementById('toast');
  if(!el){
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast' + (kind ? ' toast-' + kind : '');
  el.textContent = message;
  // A second message while one is still up restarts the clock rather than
  // inheriting the remainder of the first one's.
  clearTimeout(toastTimer);
  requestAnimationFrame(() => el.classList.add('show'));
  toastTimer = setTimeout(() => el.classList.remove('show'), 5000);
}


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

  // The snap trigger (tap buttons + manual-entry link) lives outside #root
  // entirely, fixed above the bottom dock, so it's always reachable without
  // scrolling on the Snap tab — its own content never changes with capture
  // state (see buildSnapTriggerHtml); only the pop-up that opens against the
  // selected watch's card does that. Set here, before any tab branches
  // below, so every one of them (including the early returns) leaves it in
  // the right state.
  const snapDockEl = document.getElementById('snapDock');
  if(snapDockEl){
    if(activeTab === 'data' && watch){
      snapDockEl.innerHTML = buildSnapTriggerHtml();
      snapDockEl.style.display = '';
      root.style.paddingBottom = (snapDockEl.offsetHeight + 24) + 'px';
    } else {
      snapDockEl.innerHTML = '';
      snapDockEl.style.display = 'none';
      root.style.paddingBottom = '';
    }
  }

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
    root.innerHTML = buildCollectionTabHtml();
    const viewedWatch = state.watches.find(w => w.id === viewingCollectionId);
    const showWatchBar = viewedWatch && editingCollectionId !== viewedWatch.id;
    if(tabsSlotEl0) tabsSlotEl0.innerHTML = showWatchBar ? buildCollectionWatchBarHtml(viewedWatch) : '';
    if(showWatchBar && collectionDetailJustOpened){
      const barCard = tabsSlotEl0 && tabsSlotEl0.querySelector('.collection-card');
      const detailBody = root.querySelector('.collection-detail-body');
      if(barCard) barCard.classList.add('collection-detail-enter');
      if(detailBody) detailBody.classList.add('collection-detail-enter');
    }
    collectionDetailJustOpened = false;
    attachCollectionHandlers();
    if(showWatchBar){
      attachWatchStatsHandlers(viewedWatch);
      wireChartAndHistoryScroll();
    }
    if(typeof updateClockCollapse === 'function') updateClockCollapse();
    return;
  }
  if(activeTab === 'profile'){
    if(tabsSlotEl0) tabsSlotEl0.innerHTML = '';
    root.innerHTML = buildProfileTabHtml();
    attachProfileHandlers();
    if(typeof updateClockCollapse === 'function') updateClockCollapse();
    return;
  }

  // The Data ("Snap") tab is now a watch picker, not a per-watch page — no
  // watch-tabs bar under the clock, no rate figure, charts or history here
  // (those live only in the Collection detail view). The snap panel opens
  // inline, directly under whichever card is selected (see
  // buildDataWatchListHtml), rather than living in a fixed dock.
  if(tabsSlotEl0) tabsSlotEl0.innerHTML = '';

  root.innerHTML = buildDataWatchListHtml();

  attachHandlers(watch);
  if(typeof updateClockCollapse === 'function') updateClockCollapse();
}

// One watch's picker card on the Data tab: a trimmed-down version of the
// Collection list's card — no condition notes, no model/reference line, no
// swipe-to-delete (deleting stays a Collection-only action). `connected`
// flattens the corners and drops the card's own border on the edge that
// touches the snap panel beneath it, so the two read as one shape wrapped in
// the group's border instead (see buildDataWatchGroupHtml). `selected` is
// the plain case — this watch is the one a snap will apply to, but no
// pop-up is open yet — so it just gets its own blue stroke.
function buildDataWatchCardHtml(w, connected, selected, locked){
  const photoHtml = w.photoUrl
    ? `<img class="collection-photo" src="${w.photoUrl}" alt="${escapeHtml(w.name)}" />`
    : `<div class="collection-photo collection-photo-empty">＋</div>`;
  const wornToday = isDayWorn(w, todayStr());
  // Just the measured rate here, not the factory spec badge alongside it
  // (buildCollectionCardStats shows both) — this card is about how the
  // watch is actually running, not what it's rated to.
  const stats = overallStats(w);
  const rateHtml = stats
    ? `<span class="card-rate ${stats.avgRate >= 0 ? 'good' : 'bad'}">${fmtRate(stats.avgRate)} s/day</span>`
    : '';
  const stateClass = connected ? ' connected' : selected ? ' selected' : '';
  return `
    <div class="collection-card data-watch-card${stateClass}${locked ? ' locked' : ''}" data-action="select" data-id="${w.id}">
      ${photoHtml}
      <div class="collection-card-body">
        <div class="collection-card-name"><span class="card-name-text">${escapeHtml(w.name)}</span>${rateHtml}</div>
        ${buildPowerReserveHtml(w)}
      </div>
      <div class="collection-card-actions data-watch-card-actions">
        <button type="button" class="zoom-btn collection-wind-btn" data-action="markwound" data-id="${w.id}" aria-label="Mark ${escapeHtml(w.name)} as fully wound" title="Fully wound now">
          ${windIconSvg()}
        </button>
        <button type="button" class="zoom-btn data-worn-btn${wornToday ? ' active' : ''}" data-action="toggleworntoday" data-id="${w.id}" aria-label="Mark ${escapeHtml(w.name)} as worn today" title="Worn today">
          ${wornIconSvg()}
        </button>
        <button type="button" class="zoom-btn data-menu-btn" data-action="viewwatchdetail" data-id="${w.id}" aria-label="View ${escapeHtml(w.name)} in Collection" title="View in Collection">
          ${menuIconSvg()}
        </button>
      </div>
    </div>
  `;
}

// The selected watch's card plus its snap pop-up, wrapped as one connected,
// blue-stroked block the same width as the card — shown only while a snap
// is actually under way (see buildDataWatchListHtml). The white
// shutter-flash plays around this whole block when it first appears, not
// just the form inside it.
function buildDataWatchGroupHtml(w){
  return `
    <div class="data-watch-group snap-flash" data-id="${w.id}">
      ${buildDataWatchCardHtml(w, true, false)}
      <div class="data-watch-snap-panel">${buildSnapPopupHtml()}</div>
    </div>
  `;
}

function buildDataWatchListHtml(){
  if(state.watches.length === 0){
    return `
      <div class="section" style="margin-top:2px;">
        <p class="empty-note">No watches yet.</p>
        <button type="button" class="btn-secondary" data-action="jumptoaddwatch" style="margin-top:10px;width:100%;">+ Add your first watch</button>
      </div>
    `;
  }
  const popupOpen = !!quickCaptured || manualMode;
  // While a snap's pop-up is open, the active watch always renders first —
  // paired with resetting scroll to the very top (see scrollToPageTop),
  // that's what lands it right under the header without having to measure
  // and animate to its actual position in the list, which was never quite
  // right once the clock had partly collapsed or the page was scrolled
  // somewhere else first. The rest keep their normal relative order below
  // it either way.
  let watchesInOrder = state.watches;
  if(popupOpen){
    const active = state.watches.find(w => w.id === state.activeId);
    if(active) watchesInOrder = [active, ...state.watches.filter(w => w.id !== state.activeId)];
  }
  const cardsHtml = watchesInOrder.map(w => {
    const isActive = w.id === state.activeId;
    if(isActive && popupOpen) return buildDataWatchGroupHtml(w);
    return buildDataWatchCardHtml(w, false, isActive, popupOpen);
  }).join('');
  return `
    <div class="collection-list" style="margin-top:2px;">${cardsHtml}</div>
    <button type="button" class="collection-add-btn data-add-watch-btn" data-action="jumptoaddwatch" style="margin-top:12px;">+ Add watch</button>
  `;
}

// Resets scroll to the very top over exactly `duration`ms — a fixed,
// deterministic target rather than measuring a card's position and
// animating to that, which was never quite right once the clock had partly
// collapsed or the page started somewhere other than the top: the header's
// height kept changing mid-scroll, and the target computed at the start
// went stale by the end. Y=0 is always the same "page load" geometry,
// which is also why buildDataWatchListHtml puts the active watch first
// while its pop-up is open — that's what actually lands it under the
// header, not this scroll on its own. No-ops if already there.
function scrollToPageTop(duration){
  if(window.scrollY < 2) return;
  const startY = window.scrollY;
  const startTime = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    window.scrollTo(0, startY * (1 - eased));
    if(t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
    <div class="dial-figure" style="color:${stats.avgRate>=0?'var(--good)':'var(--bad)'}">${fmtRate(stats.avgRate)}<span class="dial-unit"> s/day</span></div>
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
          <div class="row3" style="margin-top:12px;">
            <div class="field">${buildSelect('editPosition_'+r.id, POSITION_OPTIONS, r.position)}</div>
            <div class="field">${buildSelect('editWear_'+r.id, WEAR_STATE_OPTIONS, r.wearState)}</div>
            <div class="field">${buildSelect('editTimeOfDay_'+r.id, TIME_OF_DAY_OPTIONS, r.timeOfDay)}</div>
          </div>
          <div class="field" style="margin-top:10px;">
            <label for="editNote_${r.id}">Note (optional)</label>
            <input type="text" id="editNote_${r.id}" value="${escapeHtml(r.note||'')}" placeholder="worn daily, dial up overnight…" />
          </div>
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
        ? (r.isReset
            ? `<span class="hist-rate" style="color:var(--grey)">⟲ reset</span>`
            : `<span class="hist-rate" style="color:var(--grey)">reference</span>`)
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
      // Swipe left to reveal delete, the same interaction as the Collection
      // tab's cards (see wireCollectionSwipe in collection.js), just a
      // narrower reveal.
      return `<div class="swipe-row history-swipe-row" data-swipe-id="${r.id}">
        <div class="swipe-delete">
          <button type="button" class="swipe-delete-btn" data-action="deletereadingswipe" data-id="${r.id}" aria-label="Delete this reading">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7h16" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
            </svg>
          </button>
        </div>
        <div class="history-item" data-action="edithistory" data-id="${r.id}">
          <div class="hist-main">
            <span class="hist-date">${r.date} · offset ${r.offset>0?'+':''}${r.offset}s</span>
            ${rateHtml}
          </div>
          ${metaLine ? `<div class="hist-note">${escapeHtml(metaLine)}</div>` : ''}
        </div>
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


// A bit narrower than the Collection tab's SWIPE_REVEAL (collection.js) —
// matches the narrower .history-swipe-row button width in styles.css.
const HISTORY_SWIPE_REVEAL = 70;

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
      // A swipe ends in a click on whatever's underneath the finger — ignore
      // that one, and treat a tap on an already-open row as "put it back"
      // rather than "open me", same as the Collection tab's cards.
      if(Date.now() - swipeEndedAt < 300) return;
      const row = el.closest('.swipe-row');
      if(row && row.classList.contains('open')){ closeSwipeRows(null); return; }
      editingReadingId = el.dataset.id;
      render();
      // The form is far taller than the row it replaced, so it usually opens
      // running off the bottom of the screen. One frame for layout to settle,
      // then bring it fully into view.
      requestAnimationFrame(scrollEditRowIntoView);
    };
  });
  wireCollectionSwipe('.history-item', HISTORY_SWIPE_REVEAL);
  document.querySelectorAll('[data-action="deletereadingswipe"]').forEach(el=>{
    el.onclick = (e) => {
      e.stopPropagation();
      if(confirm('Delete this reading?')) deleteReading(watch.id, el.dataset.id);
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


// The always-visible capture trigger, fixed above the bottom dock — tapping
// one of these is "the snap" that opens the confirm pop-up against whichever
// watch is currently selected (see buildSnapPopupHtml, attachHandlers).
function buildSnapTriggerHtml(){
  return `
    <div class="quick-log-box">
      <p class="hint">Snap when your second hand hits a mark:</p>
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

// The pop-up attached to the selected watch's card once a snap is under way
// — the confirm form after a quick tap, or the manual-entry form. Only
// meaningful while quickCaptured or manualMode is set (see
// buildDataWatchGroupHtml, which is the only caller).
// The full diff (in seconds) between the watch reading currently dialled in
// — hour fixed to the phone's, minute from the stepper, second from the
// tapped mark — and the phone's own time at capture. Recomputed live as the
// minute stepper moves, so it always reflects what "Log" would actually
// save, not just the accuracy of the tapped second mark.
function computeQuickOffsetSeconds(){
  if(!quickCaptured) return 0;
  const c = quickCaptured.at;
  const mm = quickMinuteValue === null ? c.getMinutes() : quickMinuteValue;
  const phoneSec = c.getHours()*3600 + c.getMinutes()*60 + c.getSeconds();
  const watchSec = c.getHours()*3600 + mm*60 + quickCaptured.second;
  let diff = watchSec - phoneSec;
  while(diff > 43200) diff -= 86400;
  while(diff <= -43200) diff += 86400;
  return diff;
}
function formatQuickOffsetLabel(diff){
  if(diff === 0) return 'spot on';
  const sign = diff > 0 ? '+' : '-';
  const abs = Math.abs(diff);
  if(abs < 60) return `${sign}${abs}s`;
  const mins = Math.floor(abs / 60);
  const secs = abs % 60;
  return secs === 0 ? `${sign}${mins}m` : `${sign}${mins}m ${secs}s`;
}
function buildSnapPopupHtml(){
  if(manualMode) return buildManualForm();
  if(!quickCaptured) return '';

  const c = quickCaptured.at;
  const mm = quickMinuteValue === null ? c.getMinutes() : quickMinuteValue;
  const aheadBy = computeQuickOffsetSeconds();
  const offsetLabel = formatQuickOffsetLabel(aheadBy);
  return `
    <div class="quick-log-box">
      <div class="confirm-time-label">Dial in your watch's minutes</div>
      <div class="confirm-time-row">
        <button type="button" class="zoom-btn" data-action="minutestep" data-dir="-1">−</button>
        <div id="qConfirmTime" class="confirm-time ${aheadBy >= 0 ? 'ahead' : 'behind'}">${pad2(c.getHours())}:<span id="qMinuteDisplay" class="confirm-time-minute">${pad2(mm)}</span>:${pad2(quickCaptured.second)}</div>
        <button type="button" class="zoom-btn" data-action="minutestep" data-dir="1">+</button>
      </div>
      <div class="confirm-sub">captured <b>${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}</b> · <span id="qOffsetLabel" class="confirm-offset ${aheadBy >= 0 ? 'ahead' : 'behind'}">${offsetLabel}</span></div>
      <div class="row3">
        <div class="field">${buildSelect('qPosition', POSITION_OPTIONS)}</div>
        <div class="field">${buildSelect('qWear', [['', 'Wear'], ...WEAR_STATE_OPTIONS.slice(1)])}</div>
        <div class="field">${buildSelect('qTimeOfDay', [['', 'Time'], ...TIME_OF_DAY_OPTIONS.slice(1)])}</div>
      </div>
      <input type="text" id="qNote" class="note-inline-input" placeholder="+ optional note" style="margin-top:12px;" />
      <div class="row2" style="margin-top:12px;">
        <button type="button" class="btn-secondary" data-action="quickcancel" style="flex:1">Cancel</button>
        <button type="button" class="btn-primary" data-action="quickconfirm" style="flex:1">Log</button>
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
      <div class="row3">
        <div class="field">${buildSelect('rPosition', POSITION_OPTIONS)}</div>
        <div class="field">${buildSelect('rWear', WEAR_STATE_OPTIONS)}</div>
        <div class="field">${buildSelect('rTimeOfDay', TIME_OF_DAY_OPTIONS)}</div>
      </div>
      <div class="field" style="margin-top:10px;">
        <label for="rNote">Note (optional)</label>
        <input type="text" id="rNote" placeholder="worn daily, dial up overnight…" />
      </div>
      <button type="submit" class="btn-primary">Add reading</button>
    </form>
  `;
}


function attachHandlers(watch){
  document.querySelectorAll('[data-action="select"]').forEach(el=>{
    el.onclick = () => {
      // A snap in progress is scoped to one watch — switching away mid-snap
      // would strand the open pop-up against the wrong card, so selecting a
      // different watch is blocked until it's logged or cancelled.
      if(quickCaptured || manualMode) return;
      if(tgListening) tgAbort();
      state.activeId = el.dataset.id; selectedOffsetIdx=null; selectedDriftIdx=null; offsetScrollLeft=null; driftScrollLeft=null; editingReadingId=null;
      render();
    };
  });

  // Wind, worn-today and the menu button all act without selecting the card
  // underneath them, so each stops its click from bubbling up to the
  // "select" handler.
  document.querySelectorAll('[data-action="markwound"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); markFullyWound(btn.dataset.id); };
  });
  document.querySelectorAll('[data-action="toggleworntoday"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); toggleWearDay(btn.dataset.id, todayStr()); };
  });
  // Jumps straight to this watch's Collection detail page — the same state
  // a tap on its Collection-list card would leave things in, except its
  // back button returns here to Snap instead of the Collection list (see
  // collectionDetailReturnTab, consumed in collection.js's back button).
  document.querySelectorAll('[data-action="viewwatchdetail"]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      viewingCollectionId = btn.dataset.id;
      editingCollectionId = null;
      collectionPhotoFile = null;
      collectionDetailJustOpened = true;
      collectionDetailReturnTab = 'data';
      wearCalendarMonthIndex = new Date().getMonth();
      activeTab = 'collection';
      syncBottomTabs();
      render();
    };
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
  if(toggleBtn) toggleBtn.onclick = () => {
    manualMode = true; quickCaptured = null; quickMinuteValue = null;
    render();
    scrollToPageTop(250);
  };

  const quickModeBtn = document.querySelector('[data-action="quickmode"]');
  if(quickModeBtn) quickModeBtn.onclick = () => { manualMode = false; quickCaptured = null; quickMinuteValue = null; render(); };

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
      quickMinuteValue = quickCaptured.at.getMinutes();
      playShutterSound();
      render();
      scrollToPageTop(250);
    };
  });

  const quickCancelBtn = document.querySelector('[data-action="quickcancel"]');
  if(quickCancelBtn) quickCancelBtn.onclick = () => {
    quickCaptured = null;
    quickMinuteValue = null;
    render();
  };

  // Press-and-hold on the minute stepper: one step per tap, then after
  // ~800ms of holding it switches to 5-per-tick so a big correction
  // doesn't need dozens of taps. Ticks mutate the displayed number
  // directly rather than calling render(), since a full re-render on
  // every 150ms tick would be wasteful and can drop pointer capture.
  document.querySelectorAll('[data-action="minutestep"]').forEach(el=>{
    let holdTimeout = null;
    let holdInterval = null;
    const dir = Number(el.dataset.dir);
    const step = (amount) => {
      if(quickMinuteValue === null) return;
      quickMinuteValue = ((quickMinuteValue + amount) % 60 + 60) % 60;
      const display = document.getElementById('qMinuteDisplay');
      if(display) display.textContent = pad2(quickMinuteValue);
      const aheadBy = computeQuickOffsetSeconds();
      const side = aheadBy >= 0 ? 'ahead' : 'behind';
      const timeEl = document.getElementById('qConfirmTime');
      if(timeEl){
        timeEl.classList.remove('ahead', 'behind');
        timeEl.classList.add(side);
      }
      const offsetEl = document.getElementById('qOffsetLabel');
      if(offsetEl){
        offsetEl.classList.remove('ahead', 'behind');
        offsetEl.classList.add(side);
        offsetEl.textContent = formatQuickOffsetLabel(aheadBy);
      }
    };
    const clearHold = () => {
      if(holdTimeout) clearTimeout(holdTimeout);
      if(holdInterval) clearInterval(holdInterval);
      holdTimeout = null; holdInterval = null;
    };
    el.onpointerdown = (e) => {
      e.preventDefault();
      step(dir);
      holdTimeout = setTimeout(() => {
        holdInterval = setInterval(() => step(dir * 5), 150);
      }, 800);
    };
    el.onpointerup = clearHold;
    el.onpointerleave = clearHold;
    el.onpointercancel = clearHold;
  });

  const quickConfirmBtn = document.querySelector('[data-action="quickconfirm"]');
  if(quickConfirmBtn) quickConfirmBtn.onclick = () => {
    if(!quickCaptured) return;
    const c = quickCaptured.at;
    const qNote = document.getElementById('qNote');
    const h = c.getHours();
    const m = quickMinuteValue === null ? c.getMinutes() : quickMinuteValue;
    const note = qNote ? qNote.value : '';
    const phoneSec = c.getHours()*3600 + c.getMinutes()*60 + c.getSeconds();
    const watchSec = h*3600 + m*60 + quickCaptured.second;
    let diff = watchSec - phoneSec;
    while(diff > 43200) diff -= 86400;
    while(diff <= -43200) diff += 86400;
    const date = c.toISOString().slice(0,10);
    const conditions = readConditionInputs('q');
    quickCaptured = null;
    quickMinuteValue = null;
    addReading(watch.id, date, diff, note, conditions);
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

// Shared by a direct tap on a dock button and a swipe gesture over the page
// content — both are "go to this tab", and keeping one function means they
// can never drift apart in what that actually does.
function switchToTab(tab){
  if(tab === activeTab) return;
  const btn = document.querySelector(`.bottom-tab[data-tab="${tab}"]`);
  if(!btn) return;
  if(tgListening && tab !== 'timegrapher') tgAbort();
  activeTab = tab;
  syncBottomTabs();
  // Small bounce on the icon being switched to — a one-shot CSS animation
  // class, removed once it finishes so it can replay cleanly next time.
  btn.classList.remove('tab-pop');
  void btn.offsetWidth; // force a reflow so re-adding the class restarts the animation
  btn.classList.add('tab-pop');
  btn.addEventListener('animationend', () => btn.classList.remove('tab-pop'), { once: true });
  // Jump straight to the top on every tab switch, so leaving a scrolled-down
  // tab for a much shorter one never lands on a leftover scroll position the
  // new page barely has room for.
  window.scrollTo(0, 0);
  editingReadingId = null;
  editingCollectionId = null;
  viewingCollectionId = null;
  render();
}

document.querySelectorAll('.bottom-tab').forEach(btn => {
  btn.onclick = () => switchToTab(btn.dataset.tab);
  // iOS Safari often never applies :active on tap at all unless something
  // on the page explicitly listens for touch — a real touch listener
  // toggling this class sidesteps that, on every platform, rather than
  // depending on WebKit's touch-to-:active mapping.
  btn.addEventListener('touchstart', () => btn.classList.add('pressed'), { passive: true });
  const clearPressed = () => btn.classList.remove('pressed');
  btn.addEventListener('touchend', clearPressed);
  btn.addEventListener('touchcancel', clearPressed);
});

// --- swipe between tabs ---
// A horizontal swipe anywhere over the page does the same thing as tapping
// the next or previous dock icon — an alternative to reaching down to the
// bar, not a replacement for it.
//
// --- bootstrap ---
// loadState()/syncTrueTime() are no longer called from here. Since the app
// is now gated behind login, js/auth.js triggers them once a session is
// confirmed — see handleSignedIn() there.
