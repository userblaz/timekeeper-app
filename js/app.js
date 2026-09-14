// Main app: UI state, render(), scroll handling, the tab-click wiring, and
// the final bootstrap calls at the bottom. Loaded last on purpose — every
// other file must be defined before this one runs its bootstrap code.

let selectedOffsetIdx = null;
let selectedDriftIdx = null;
let quickCaptured = null;
// The confirm popup's stepper tracks one signed, additive correction (in
// seconds) from the captured reading, rather than three separate wall-clock
// field values — that's what keeps the offset math correct across a minute,
// second or hour wrap (see computeQuickOffsetSeconds and
// quickDisplaySeconds): the displayed h/m/s and the logged offset are both
// derived from the same sum, never reconstructed from a bare field and
// re-diffed against the captured hour. Unbounded — a real accuracy
// correction is rarely more than a few minutes, but there's nothing here
// that stops working at any size, so there's nothing to gain by capping it.
let quickAdjustSeconds = 0;
// Which field the +/- stepper currently acts on — tapping a field in the
// confirm popup's time readout (see buildSnapPopupHtml) switches this, and
// only that field pulses.
let quickSelectedField = 'minute';
// The note currently being written for whichever snap pop-up is open — the
// confirm form and the manual form are never both up at once (see
// buildSnapPopupHtml), so one draft covers both. Held here rather than read
// off the field at save time because the field it belongs to now lives in
// an overlay that outlives any single render (see openNoteEditor).
let noteDraft = '';
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
  ['', 'Wear state'], ['worn', 'On wrist'], ['rest', 'At rest'],
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
// `compact` marks the Snap tab's Position/Wear/Time dropdowns specifically —
// they live inside the scrollable watch list (see the escape-to-portal logic
// below) and get the tightened, merged-with-trigger treatment; every other
// caller (Collection's reading-edit fields, the currency and wear-calendar
// pickers) keeps the plain, spaced-out look, since those were never part of
// this request and sit in normal-flow contexts that don't need to escape.
function buildSelect(id, options, selectedValue, compact){
  const current = selectedValue || '';
  const currentLabel = (options.find(([value]) => value === current) || options[0])[1];
  // The first entry (empty value) is a placeholder label for the closed
  // button, not a real choice — listing it in the open menu just repeated
  // that same word ("Position", "Wear", "Time"...) as a bogus, always-first
  // option with nothing behind it.
  const optionClass = 'select-option' + (compact ? ' select-option-compact' : '');
  const optionsHtml = options.filter(([value]) => value !== '').map(([value, label]) =>
    `<button type="button" class="${optionClass}${value===current?' selected':''}" data-value="${escapeHtml(value)}">${escapeHtml(label)}</button>`
  ).join('');
  // The hidden input's id is also how a portaled-out menu finds its way back
  // to the right wrap later (see findSelectWrap) — the menu itself may no
  // longer be a DOM descendant of the wrap by then, so `.closest()` alone
  // can't be used for that lookup once it's escaped.
  return `
    <div class="select-wrap">
      <input type="hidden" id="${id}" value="${escapeHtml(current)}" />
      <button type="button" class="condition-select${current ? '' : ' placeholder'}" data-action="toggleselect" data-placeholder="${escapeHtml(options[0][1])}" aria-expanded="false">
        <span class="select-value">${escapeHtml(currentLabel)}</span>
        <svg class="select-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <div class="select-menu${compact ? ' select-menu-compact' : ''}" data-for="${id}" hidden>${optionsHtml}</div>
    </div>
  `;
}

function findSelectWrap(menu){
  const owner = document.getElementById(menu.dataset.for);
  return owner ? owner.closest('.select-wrap') : null;
}

// The other direction of findSelectWrap — needed because a wrap's menu isn't
// always its child in the DOM: once escaped it's been moved out to <body>
// (see the toggleselect handler below), so `wrap.querySelector('.select-menu')`
// would miss it, e.g. when the same open toggle is tapped again to close it.
function findMenuForWrap(wrap){
  const hiddenInput = wrap.querySelector('input[type="hidden"]');
  if(!hiddenInput) return null;
  for(const menu of document.querySelectorAll('.select-menu')){
    if(menu.dataset.for === hiddenInput.id) return menu;
  }
  return null;
}

// An escaped (portaled, viewport-fixed) menu is positioned once, at open
// time, against wherever its trigger happens to be. Keeping that in sync
// with a live scroll turned out worse than the staleness it was fixing —
// recomputing it only on a scroll *event* lags well behind the list's own
// smooth momentum-scrolling, so the menu visibly snapped to catch up,
// reading as the text wobbling in place. Simplest fix: leave the list
// scrollable (nothing here should stop that) and just close the menu the
// moment a scroll, resize, orientation change or keyboard happens, instead
// of chasing any of them. Only one select can be open at a time, so a single
// tracked listener set is enough.
let escapedMenuTracker = null;

// widthBox lets a caller size/position the menu against a wider box than
// the toggle itself — the catalog filters (see the toggleselect handler
// below) pass their whole three-across row so an open menu spans all
// three columns instead of just its own third, since there's nothing else
// there to use that space while it's open anyway. Left unset, the menu
// sizes to the toggle like every other escaped menu always has.
function positionEscapedMenu(menu, toggle, widthBox){
  menu.classList.remove('drop-up');
  const box = toggle.getBoundingClientRect();
  const spaceBelow = window.innerHeight - box.bottom;
  const spaceAbove = box.top;
  // No gap for the compact popup dropdowns — they're styled to read as a
  // seamless continuation of the trigger (see the CSS), so leaving room for
  // one here would reopen the gap the styling is trying to close. The
  // generic (non-compact) case keeps its small breathing gap — a couple of
  // px more for a widthBox menu, since it's sitting below the other two
  // triggers in the row too, not just its own, and the plain 6px read as
  // slightly crowding into them.
  const gap = menu.classList.contains('select-menu-compact') ? 0 : (widthBox ? 10 : 6);
  // The menu is never scrollable, so when it doesn't fit below, open it
  // upward — but only if there's actually more room up there.
  const needed = menu.getBoundingClientRect().height + 12;
  const dropUp = needed > spaceBelow && spaceAbove > spaceBelow;
  menu.classList.toggle('drop-up', dropUp);
  const sizeBox = widthBox || box;
  menu.style.left = sizeBox.left + 'px';
  menu.style.width = sizeBox.width + 'px';
  if(dropUp){
    menu.style.bottom = (window.innerHeight - box.top + gap) + 'px';
    menu.style.top = '';
  } else {
    menu.style.top = (box.bottom + gap) + 'px';
    menu.style.bottom = '';
  }
}

function stopTrackingEscapedMenu(){
  if(!escapedMenuTracker) return;
  // `true` here is capture, not bubble — scroll events don't bubble, but a
  // capture-phase listener on document still sees every descendant's scroll
  // (including the watch list's own internal container), which is what lets
  // one listener cover any scrollable ancestor the menu happens to be near
  // without having to know which one it is.
  document.removeEventListener('scroll', escapedMenuTracker, true);
  window.removeEventListener('resize', escapedMenuTracker);
  window.removeEventListener('orientationchange', escapedMenuTracker);
  if(window.visualViewport) window.visualViewport.removeEventListener('resize', escapedMenuTracker);
  escapedMenuTracker = null;
}

// Hides one menu and, if it was portaled out to <body> (see the toggleselect
// handler below), moves it back home into its own wrap — otherwise a wrap
// destroyed by some unrelated render() while its menu was off in <body>
// would orphan that menu there forever, invisible but never cleaned up.
function closeSelectMenu(menu){
  const wrap = findSelectWrap(menu);
  const wasEscaped = menu.classList.contains('select-menu-escaped');
  menu.hidden = true;
  if(wasEscaped && wrap){
    wrap.appendChild(menu);
  }
  menu.classList.remove('select-menu-escaped', 'drop-up');
  menu.style.left = menu.style.top = menu.style.bottom = menu.style.width = '';
  if(wrap){
    wrap.classList.remove('select-open', 'drop-up');
    wrap.querySelector('[data-action="toggleselect"]').setAttribute('aria-expanded', 'false');
  }
}

// A multi-choice variant of buildSelect above — same custom-dropdown shell
// (so it gets the same overflow-escaping, drop-up and outside-click-closes
// behavior for free, see the delegated handlers below), but checkboxes
// instead of one-tap-and-close buttons, and a short fixed label instead of
// echoing back whatever's chosen — there's no length of value list that
// reads well in the space a button like this has, so it just says how many
// are checked instead (see the change handler below, which is what keeps
// that count in sync without a full re-render).
function buildMultiSelect(id, shortLabel, options, selectedValues){
  const selected = new Set(selectedValues || []);
  const optionsHtml = options.map(([value, label]) => `
    <label class="multi-select-option">
      <input type="checkbox" data-action="multiselecttoggle" value="${escapeHtml(value)}" ${selected.has(value) ? 'checked' : ''} />
      <span>${escapeHtml(label)}</span>
    </label>
  `).join('');
  // data-for links this menu back to its wrap the same way buildSelect's
  // does (see findSelectWrap/findMenuForWrap) — without it, a multi-select
  // menu would be invisible to those lookups and the toggle handler above
  // would crash trying to read .hidden off a null menu.
  return `
    <div class="select-wrap multi-select-wrap" data-short-label="${escapeHtml(shortLabel)}">
      <input type="hidden" id="${id}" value="${escapeHtml(Array.from(selected).join(','))}" />
      <button type="button" class="condition-select${selected.size ? '' : ' placeholder'}" data-action="toggleselect" aria-expanded="false">
        <span class="select-value">${escapeHtml(shortLabel)}${selected.size ? ` (${selected.size})` : ''}</span>
        <svg class="select-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <div class="select-menu multi-select-menu" data-for="${id}" hidden>${optionsHtml}</div>
    </div>
  `;
}

function closeAllSelects(except){
  stopTrackingEscapedMenu();
  // Querying menus directly (rather than each wrap's own child) is what
  // makes this still find a menu that's currently portaled out to <body> —
  // it's no longer a descendant of its wrap at that point, so a
  // wrap-relative lookup would silently miss it.
  document.querySelectorAll('.select-menu').forEach(menu => {
    if(findSelectWrap(menu) === except) return;
    closeSelectMenu(menu);
  });
}

// Delegated once at load so it survives every re-render without rewiring.
document.addEventListener('click', (e) => {
  // Tapping the already-selected value itself acts as a clear button — the
  // dropdown otherwise has no way to get back to "no selection" once
  // something's been picked. Only fires when there's a real value to clear;
  // with nothing selected the button just shows its placeholder text, and
  // tapping that should open the menu as usual, not "clear" a non-selection.
  const valueText = e.target.closest('.select-value');
  const valueToggle = valueText && valueText.closest('[data-action="toggleselect"]');
  if(valueToggle && !valueToggle.classList.contains('placeholder')){
    e.preventDefault();
    e.stopPropagation();
    const wrap = valueToggle.closest('.select-wrap');
    const hiddenInput = wrap.querySelector('input[type="hidden"]');
    const menu = findMenuForWrap(wrap);
    hiddenInput.value = '';
    valueText.textContent = valueToggle.dataset.placeholder || '';
    valueToggle.classList.add('placeholder');
    if(menu) menu.querySelectorAll('.select-option').forEach(o => o.classList.remove('selected'));
    stopTrackingEscapedMenu();
    closeAllSelects(null);
    return;
  }

  const toggle = e.target.closest('[data-action="toggleselect"]');
  if(toggle){
    e.preventDefault();
    e.stopPropagation();
    const wrap = toggle.closest('.select-wrap');
    const menu = findMenuForWrap(wrap);
    const willOpen = menu.hidden;
    closeAllSelects(wrap);
    if(!willOpen){
      // Tapping the same toggle again while its own menu is open — close it
      // through the normal path (closeSelectMenu) so an escaped one gets
      // portaled back home and fully cleaned up, not just hidden in place.
      closeSelectMenu(menu);
      return;
    }
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    // The confirm pop-up's Position/Wear/Time dropdowns are tall enough to
    // reach the bottom of the screen, where the trigger dock and bottom tab
    // bar are both fixed on top of the page. Escaping — moving the menu
    // itself to <body> and positioning it in viewport coordinates — lets it
    // draw over those instead of disappearing behind them, and keeps it
    // clear of any ancestor's overflow no matter what that ancestor does
    // later.
    // The Add Watch catalog filters (Case/Movement/Dial) stay inline,
    // three across, while closed — that's the whole point of them there.
    // But there's nothing else in that row for the other two triggers to
    // do while one's open, so the open menu spans the full row instead of
    // just its own third: same escape-to-<body> mechanism as the
    // data-watch-scroll case below, just sized against the row
    // (catalogFiltersRow) instead of the toggle it came from.
    const catalogFiltersRow = wrap.closest('.watch-catalog-filters');
    if(wrap.closest('.data-watch-scroll') || catalogFiltersRow){
      document.body.appendChild(menu);
      menu.classList.add('select-menu-escaped');
      positionEscapedMenu(menu, toggle, catalogFiltersRow ? catalogFiltersRow.getBoundingClientRect() : null);
      // Positioned once, above — rather than keep it glued to the trigger
      // through a live scroll (see the comment on escapedMenuTracker), just
      // close it as soon as the list moves under it, the keyboard opens, or
      // the phone rotates. The list itself is never touched here, so
      // scrolling the page works normally the whole time this is open.
      // Scrolling the *menu's own* option list (catalog filters can have
      // enough entries to need that — see the max-height/overflow-y on
      // .select-menu) fires a real 'scroll' event too, captured right along
      // with everything else here; without the target check below that
      // closed the menu the instant you tried to scroll its own list,
      // rather than only when something outside it moved.
      escapedMenuTracker = (e) => {
        if(e && e.type === 'scroll' && menu.contains(e.target)) return;
        closeAllSelects(null);
      };
      document.addEventListener('scroll', escapedMenuTracker, true);
      window.addEventListener('resize', escapedMenuTracker);
      window.addEventListener('orientationchange', escapedMenuTracker);
      if(window.visualViewport) window.visualViewport.addEventListener('resize', escapedMenuTracker);
      wrap.classList.toggle('drop-up', menu.classList.contains('drop-up'));
    } else {
      // Plain, wrap-relative menus get the drop-up decision made once here
      // instead — they never move, so there's nothing to re-track.
      menu.classList.remove('drop-up');
      const box = toggle.getBoundingClientRect();
      const spaceBelow = window.innerHeight - box.bottom;
      const spaceAbove = box.top;
      const needed = menu.getBoundingClientRect().height + 12;
      const dropUp = needed > spaceBelow && spaceAbove > spaceBelow;
      menu.classList.toggle('drop-up', dropUp);
      wrap.classList.toggle('drop-up', dropUp);
    }
    wrap.classList.add('select-open');
    return;
  }

  const option = e.target.closest('.select-option');
  if(option){
    e.preventDefault();
    e.stopPropagation();
    const wrap = option.closest('.select-wrap') || findSelectWrap(option.closest('.select-menu'));
    const button = wrap.querySelector('[data-action="toggleselect"]');
    const menu = option.closest('.select-menu');
    const hidden = wrap.querySelector('input[type="hidden"]');
    hidden.value = option.dataset.value;
    wrap.querySelector('.select-value').textContent = option.textContent;
    button.classList.toggle('placeholder', !option.dataset.value);
    menu.querySelectorAll('.select-option').forEach(o => o.classList.toggle('selected', o === option));
    stopTrackingEscapedMenu();
    closeSelectMenu(menu);
    // A real <select> fires 'change' on its own when the value changes;
    // this one has to do it itself, since setting .value on the hidden
    // input programmatically doesn't. Nothing listened for it before the
    // Collection tab's catalog search filters (collection.js) — purely
    // additive, so every existing select keeps working exactly as before.
    hidden.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // A checkbox toggle (see the 'change' handler below) fires a click too —
  // without this, the fallthrough closeAllSelects() right below would shut
  // the menu after every single checkbox tap, defeating the entire point
  // of a multi-select.
  if(e.target.closest('.multi-select-option')) return;

  closeAllSelects(null);
});

// Delegated the same way as the click handler above: survives every
// re-render without rewiring, and stays a plain 'change' (not 'click') so
// it fires once per actual state change rather than per pointer tap.
// Deliberately doesn't close the menu or call closeAllSelects — that's the
// one behavioral difference from a single-select's option buttons, and the
// whole reason this needs its own handler instead of reusing that one.
document.addEventListener('change', (e) => {
  const checkbox = e.target.closest('[data-action="multiselecttoggle"]');
  if(!checkbox) return;
  const wrap = checkbox.closest('.multi-select-wrap');
  if(!wrap) return;
  const hidden = wrap.querySelector('input[type="hidden"]');
  const checked = Array.from(wrap.querySelectorAll('[data-action="multiselecttoggle"]:checked')).map(el => el.value);
  hidden.value = checked.join(',');
  const shortLabel = wrap.dataset.shortLabel;
  const valueEl = wrap.querySelector('.select-value');
  if(valueEl) valueEl.textContent = shortLabel + (checked.length ? ` (${checked.length})` : '');
  const button = wrap.querySelector('[data-action="toggleselect"]');
  if(button) button.classList.toggle('placeholder', checked.length === 0);
  // Same reasoning as the single-select's hidden-input dispatch above —
  // callers (the Collection tab's catalog filters) listen for 'change' on
  // this hidden input, not on the checkboxes themselves.
  hidden.dispatchEvent(new Event('change', { bubbles: true }));
});

document.addEventListener('keydown', (e) => {
  if(e.key === 'Escape'){
    if(noteEditorFor){ closeNoteEditor(false); return; }
    closeAllSelects(null);
    return;
  }
  // Enter commits the note, the way it would submit a one-field form.
  if(e.key === 'Enter' && noteEditorFor){
    e.preventDefault();
    closeNoteEditor(true);
  }
});

// --- the note field -----------------------------------------------------
// A note is written in its own overlay rather than in an inline field.
// Anchored to the *top* of the screen, where a keyboard rising from the
// bottom can never cover it — so nothing about this has to reason about how
// much room the keyboard left, which is what the inline field kept getting
// wrong on real hardware. It lives in <body> too, so unlike the inline
// field a render() mid-edit can't destroy what's being typed.
let noteEditorFor = null;

// The hidden input carries the caller's id, so everything already reading
// `document.getElementById('qNote').value` keeps working untouched — the
// same arrangement buildSelect uses to stand in for a native control.
function buildNoteField(id){
  return `
    <input type="hidden" id="${id}" value="${escapeHtml(noteDraft)}" />
    <button type="button" class="note-inline-btn${noteDraft ? '' : ' placeholder'}" data-action="editnote" data-for="${id}">${noteDraft ? escapeHtml(noteDraft) : '+ optional note'}</button>
  `;
}

// Built once, up front rather than on first use: the tap that opens the
// editor has to focus its field in that same tick to bring the keyboard up
// (see openNoteEditor), and a field the document has never laid out is the
// shakiest thing to hand focus to at that moment.
function ensureNoteEditor(){
  let el = document.getElementById('noteEditor');
  if(!el){
    el = document.createElement('div');
    el.id = 'noteEditor';
    el.className = 'note-editor';
    el.innerHTML = `
      <div class="note-editor-panel">
        <label class="note-editor-label" for="noteEditorInput">Note</label>
        <input type="text" id="noteEditorInput" class="note-editor-input" placeholder="Anything worth remembering" autocomplete="off" />
        <div class="row2">
          <button type="button" class="btn-secondary" data-action="notecancel" style="flex:1">Cancel</button>
          <button type="button" class="btn-primary" data-action="notesave" style="flex:1">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(el);
  }
  return el;
}
ensureNoteEditor();

function openNoteEditor(id){
  noteEditorFor = id;
  const el = ensureNoteEditor();
  const input = el.querySelector('#noteEditorInput');
  input.value = noteDraft;
  el.classList.add('open');
  // Everything from here has to stay synchronous inside the tap that opened
  // the editor: iOS only raises the keyboard for a focus() call that happens
  // within the gesture asking for it, so deferring this by even one frame
  // (which is what it did before) left the field focused with the keyboard
  // still down, needing a second tap on it to type. Reading offsetHeight
  // forces the display:none -> block above to resolve now rather than at the
  // next paint — an element the browser still considers unrendered can't
  // take focus at all.
  void el.offsetHeight;
  input.focus({ preventScroll: true });
  // Caret at the end rather than the whole note selected, so reopening a
  // note to add to it doesn't replace it with the first key pressed.
  const end = input.value.length;
  input.setSelectionRange(end, end);
}

function closeNoteEditor(save){
  const el = document.getElementById('noteEditor');
  if(!el) return;
  const id = noteEditorFor;
  const input = el.querySelector('#noteEditorInput');
  if(save) noteDraft = input.value.trim();
  // Blur first so the keyboard is already on its way down as the overlay
  // goes, rather than being dismissed by the overlay vanishing under it.
  input.blur();
  el.classList.remove('open');
  noteEditorFor = null;
  if(!save || !id) return;
  // Written straight through to the open pop-up instead of re-rendering it:
  // a render() here would rebuild the whole group and replay its entrance
  // animation for what is only a line of text changing.
  const hidden = document.getElementById(id);
  if(hidden) hidden.value = noteDraft;
  const trigger = document.querySelector(`[data-action="editnote"][data-for="${id}"]`);
  if(trigger){
    trigger.textContent = noteDraft || '+ optional note';
    trigger.classList.toggle('placeholder', !noteDraft);
  }
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-action="editnote"]');
  if(trigger){
    e.preventDefault();
    openNoteEditor(trigger.dataset.for);
    return;
  }
  if(e.target.closest('[data-action="notesave"]')){ closeNoteEditor(true); return; }
  if(e.target.closest('[data-action="notecancel"]')){ closeNoteEditor(false); return; }
  // Tapping the dimmed area outside the panel keeps what's been typed
  // rather than throwing it away — losing a note to a stray tap is a worse
  // outcome than keeping one the user half-meant, and Cancel is right there
  // for actually discarding it.
  if(e.target.closest('#noteEditor') && !e.target.closest('.note-editor-panel')) closeNoteEditor(true);
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

  // Rebuilding #root below (innerHTML) destroys every select-wrap under it —
  // including, for a menu currently portaled out to <body> (see
  // closeAllSelects), the only thing that would otherwise have moved it back
  // and cleaned it up. Closing here first returns it home before its wrap
  // disappears, so it gets torn down with everything else instead of being
  // orphaned in <body> forever.
  closeAllSelects(null);

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
    } else {
      snapDockEl.innerHTML = '';
      snapDockEl.style.display = 'none';
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
  sizeSnapDockClearance();

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
    : `<div class="collection-photo collection-photo-empty">${watchPlaceholderIconSvg()}</div>`;
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
      <div class="collection-card-body data-watch-card-body">
        <div class="collection-card-name"><span class="card-name-text">${escapeHtml(w.name)}</span></div>
        ${rateHtml ? `<div class="data-watch-card-rate">${rateHtml}</div>` : ''}
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
  // The list keeps its natural order even while a snap pop-up is open —
  // watches above the active one scroll off above instead of jumping out
  // of place, and the rest are still reachable below (see
  // scrollWatchCardToTop, called right after this renders).
  const cardsHtml = state.watches.map(w => {
    const isActive = w.id === state.activeId;
    if(isActive && popupOpen) return buildDataWatchGroupHtml(w);
    return buildDataWatchCardHtml(w, false, isActive, popupOpen);
  }).join('');
  return `
    <div class="data-watch-scroll" id="dataWatchScroll">
      <div class="collection-list" style="margin-top:2px;">${cardsHtml}</div>
      <button type="button" class="collection-add-btn data-add-watch-btn" data-action="jumptoaddwatch" style="margin-top:12px;">+ Add watch</button>
    </div>
  `;
}

// The Snap tab scrolls as one ordinary page, like every other tab. It used
// to lock page scroll and give the watch list its own fixed-height scroll
// region instead, so the reference clock could stay expanded while the list
// was browsed — but that meant the region's height had to be re-derived, in
// pixels, from the viewport, the sticky header, the fixed dock and the
// on-screen keyboard, none of which hold still on a phone. Worse, browsers
// scroll the page themselves to reveal a focused field whether or not CSS
// says overflow:hidden, and with page scroll otherwise frozen there was no
// way back: the clock ended up stuck half-collapsed with nothing able to
// scroll it back. Letting the page scroll normally hands all of that to the
// browser. The only thing still measured here is how much room the fixed
// dock needs at the bottom, so the end of the list can be scrolled clear of
// it — a plain "how tall is this element" question, not a viewport one.
function sizeSnapDockClearance(){
  const listEl = document.getElementById('dataWatchScroll');
  if(!listEl) return;
  const dock = document.getElementById('snapDock');
  if(!dock || dock.style.display === 'none'){ listEl.style.paddingBottom = '0px'; return; }
  // .app already ends with enough padding to clear the bottom tab bar on
  // every tab, and the dock's own box covers that same strip — so only the
  // difference is needed here. Adding the dock's full height on top of it
  // would reserve the tab bar's share twice, stopping the end of the list
  // well short of the dock with the slack showing as dead space.
  const appEl = document.getElementById('app');
  const appPadding = appEl ? parseFloat(getComputedStyle(appEl).paddingBottom) || 0 : 0;
  const base = Math.max(0, dock.offsetHeight + 12 - appPadding);

  // With a pop-up open, the snapped watch also has to be able to reach the
  // top of the page (see scrollWatchCardToTop) — and for one near the end of
  // the list there's nothing below it to scroll against, so the page runs out
  // of travel with the card still stranded halfway down and the pop-up's own
  // buttons left under the dock. Topping the page's scroll range up by
  // whatever it falls short by is what the list's old trailing spacer was
  // for; this is the same idea against the page instead of a private scroll
  // region, and only while a pop-up is actually open.
  //
  // Measured off the content's own bottom edge — the current padding backed
  // out of it — rather than by writing a smaller padding first and measuring
  // what that gives. Shrinking the page even for the instant between two
  // writes lets the browser clamp the scroll position to the shorter
  // document, and it doesn't come back when the padding does: a scroll
  // already under way (this runs on focus changes, which a snap fires) would
  // be quietly cut short partway. One write, no intermediate state.
  let extra = 0;
  const group = document.querySelector('.data-watch-group');
  if(group){
    const currentPad = parseFloat(getComputedStyle(listEl).paddingBottom) || 0;
    const contentBottom = listEl.getBoundingClientRect().bottom - currentPad;
    const roomBelowGroup = (contentBottom + base + appPadding) - group.getBoundingClientRect().top;
    extra = Math.max(0, window.innerHeight - roomBelowGroup);
  }
  listEl.style.paddingBottom = (base + extra) + 'px';
}
window.addEventListener('resize', sizeSnapDockClearance);

// Keeping a focused field clear of the on-screen keyboard used to be done
// by hand here — scrolling the list's own region, stretching a spacer,
// re-measuring against the visual viewport, and snapping window scroll back
// to 0 because the page was never supposed to move on this tab. All of it
// existed only because the page couldn't scroll (see sizeSnapDockClearance);
// now that it can, the browser does this itself, correctly, on every device.
// The one thing still worth doing is getting the fixed trigger dock out of
// the way, since a fixed element is exactly what the browser's own
// scroll-into-view can't account for — that lives in updateKeyboardHideState
// below, alongside the bottom bar's version of the same decision.

// The bottom nav bar is fixed near the bottom of the layout viewport, but
// once the on-screen keyboard opens, iOS Safari keeps fixed elements
// pinned to the shrunken *visual* viewport instead — which is exactly what
// makes it look like it "jumps up": it ends up floating partway up the
// page, on top of whatever real content happens to sit there (the
// Collection tab's catalog search results, most often), rather than at the
// bottom where there'd be nothing left to cover. Simplest fix is to just
// get it out of the way for as long as a text field actually has the
// keyboard open. Guarded on the app screen actually being visible so this
// never fights showApp/showAuthScreen's own use of the same element on the
// sign-in screen.
//
// The reference clock at the top gets the same treatment, but only while
// the Collection tab's add-watch search is open — it's the biggest single
// thing eating into the room a phone's keyboard leaves for search results,
// bigger than the bottom bar. Scoped to just that view (rather than
// applied globally like the bottom bar above) so it can't interact with
// whatever made the Snap tab's own force-collapse behavior get switched
// off (see CLOCK_FORCE_COLLAPSE_ENABLED in clock.js) — this is a separate,
// narrower mechanism, not a reuse of that one. Reappears the moment the
// keyboard closes, whether that's from tapping outside the field or
// switching away from search mode.
//
// This used to key off visualViewport resize (measuring how much the
// visible area shrank), the same signal the Snap tab logic above uses —
// but on at least one real iOS device it never fired reliably here, so the
// bar and clock stayed put with the keyboard fully open. Focus/blur on the
// field itself is a more direct signal for "is the keyboard actually up"
// and doesn't depend on the viewport-resize event firing at all: it's
// driven straight off document.activeElement changing, via the bubbling
// focusin/focusout events.
function isKeyboardTextInput(el){
  if(!el) return false;
  if(el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  // Checkboxes/radios (the multi-select filter options, the reset-point
  // checkbox, etc.) are <input> elements too but never bring up a keyboard.
  if(el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return false;
  return true;
}
function updateKeyboardHideState(){
  const bar = document.getElementById('bottomTabs');
  const appShown = document.getElementById('app');
  if(!bar || !appShown || appShown.style.display === 'none') return;
  const active = document.activeElement;
  const keyboardOpen = isKeyboardTextInput(active);
  // The bottom bar stays put for the Snap tab's own fields — it's navigation
  // the user expects to always have on screen, and nothing on that tab needs
  // the room taking it away would free.
  const dataWatchScroll = document.getElementById('dataWatchScroll');
  const inSnapList = dataWatchScroll && active && dataWatchScroll.contains(active);
  bar.style.display = (keyboardOpen && !inSnapList) ? 'none' : '';

  // The trigger dock does have to go, though, and it's decided here rather
  // than anywhere else on purpose: it and the bottom bar are the two fixed
  // things that can cover a field being typed into, and they got out of sync
  // — one updated for the keyboard, the other not — every time they were
  // toggled from separate places. Now it's one focus-driven decision. Focus
  // rather than a viewport-resize measurement because focus is the thing
  // that's actually true: a resize event can lag, or never arrive at all.
  const dock = document.getElementById('snapDock');
  if(dock){
    dock.classList.toggle('dock-hidden-for-keyboard', keyboardOpen && !!inSnapList);
    sizeSnapDockClearance();
  }

  const clockBox = document.getElementById('masterClockBox');
  if(clockBox){
    const inAddWatchView = activeTab === 'collection' && addingCollectionWatch;
    clockBox.style.display = (keyboardOpen && inAddWatchView) ? 'none' : '';
  }
}
document.addEventListener('focusin', updateKeyboardHideState);
// focusout fires just before activeElement actually clears (it briefly
// becomes document.body), so check on the next tick once it's settled —
// otherwise a tap from one field straight to another would flash the bar
// back on in between.
document.addEventListener('focusout', () => setTimeout(updateKeyboardHideState, 0));

// Resets scroll to the very top over exactly `duration`ms — a fixed,
// deterministic target rather than measuring a card's position and
// animating to that, which was never quite right once the clock had partly
// collapsed or the page started somewhere other than the top: the header's
// height kept changing mid-scroll, and the target computed at the start
// went stale by the end. No-ops if already there.
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

// Brings the snapped watch's card — or its snap group, once the pop-up is
// open — up under the header, so the thing just captured is what you're
// looking at, with the cards above it scrolled off and the rest still
// reachable below. The list keeps its natural order (see
// buildDataWatchListHtml) rather than jumping the active watch to the front.
//
// This scrolls the page now, not a private scroll region, so it hands the
// job to scrollPanelIntoView — the same helper the Collection tab already
// uses for exactly this. That one knows the header is sticky AND collapses
// as the page moves, and re-measures across a few frames until it settles
// instead of computing one target up front and landing short of it. For the
// first watch in the list that lands back at the top of the page with the
// clock full size again: the default view, which is where a snap should
// always put you.
function scrollWatchCardToTop(watchId){
  const el = document.querySelector(`.data-watch-group[data-id="${watchId}"]`) ||
    document.querySelector(`.data-watch-card[data-id="${watchId}"]`);
  if(!el) return;
  // Nothing above the first card to scroll out of the way, so the top of the
  // page is already where it belongs — go there rather than pinning it under
  // the header, which would scroll down by the list's own top margin to close
  // a gap that's meant to be there. That's a dozen pixels of travel with
  // nothing to show for it, and it reads as the card twitching on every snap.
  if(!el.previousElementSibling){ scrollToPageTop(220); return; }
  scrollPanelIntoView(el, true);
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
    <div class="dial-meta">average over ${stats.days} day${stats.days===1?'':'s'}<br>${stats.count} readings${stats.sinceReset ? ' · since reset' : ''}</div>
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
    // On the Snap tab the trigger dock is fixed above the tab bar and is the
    // taller of the two, so it's the real bottom edge there; everywhere else
    // it's display:none and the tab bar is. Measuring whichever is actually
    // on screen keeps one rule for both.
    const dock = document.getElementById('snapDock');
    const bottomEl = (dock && dock.style.display !== 'none') ? dock : tabs;
    const bottomLimit = (bottomEl ? bottomEl.getBoundingClientRect().top : window.innerHeight) - 10;
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
// The captured reading's own position in the day, in seconds — the fixed
// point every correction is measured from.
function quickBaseSeconds(){
  const c = quickCaptured.at;
  return c.getHours()*3600 + c.getMinutes()*60 + quickCaptured.second;
}
// The reading currently dialled in, normalized back into a 0-86399 wall-
// clock position — purely for display. Adding the correction here rather
// than folding it into its own field first (a bare minute number wrapped
// mod 60, say) is what avoids ever needing to reconstruct a wall-clock time
// and re-diff it: this and computeQuickOffsetSeconds both just add the same
// number to two different starting points.
function quickDisplaySeconds(){
  const total = quickBaseSeconds() + quickAdjustSeconds;
  return ((total % 86400) + 86400) % 86400;
}
// The full diff (in seconds) between the watch reading currently dialled in
// and the phone's own time at capture — just the captured diff plus
// whatever's been added since, so it's exact regardless of how many times
// the stepper has crossed a minute, hour or day boundary. Recomputed live as
// the stepper moves, so it always reflects what "Log" would actually save,
// not just the accuracy of the tapped second mark.
function computeQuickOffsetSeconds(){
  if(!quickCaptured) return 0;
  const c = quickCaptured.at;
  const phoneSec = c.getHours()*3600 + c.getMinutes()*60 + c.getSeconds();
  let diff = (quickBaseSeconds() - phoneSec) + quickAdjustSeconds;
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
  const displaySec = quickDisplaySeconds();
  const h = Math.floor(displaySec / 3600);
  const mm = Math.floor((displaySec % 3600) / 60);
  const ss = displaySec % 60;
  const aheadBy = computeQuickOffsetSeconds();
  const offsetLabel = formatQuickOffsetLabel(aheadBy);
  const fieldHtml = (field, id, value) => `<span id="${id}" class="confirm-time-field${quickSelectedField === field ? ' confirm-time-field-selected' : ''}" data-action="selecttimefield" data-field="${field}">${pad2(value)}</span>`;
  return `
    <div class="quick-log-box">
      <div class="confirm-time-label">Adjust your watch's time</div>
      <div class="confirm-time-row">
        <button type="button" class="zoom-btn" data-action="timestep" data-dir="-1">−</button>
        <div id="qConfirmTime" class="confirm-time ${aheadBy >= 0 ? 'ahead' : 'behind'}">${fieldHtml('hour', 'qHourDisplay', h)}:${fieldHtml('minute', 'qMinuteDisplay', mm)}:${fieldHtml('second', 'qSecondDisplay', ss)}</div>
        <button type="button" class="zoom-btn" data-action="timestep" data-dir="1">+</button>
      </div>
      <div class="confirm-sub">captured <b>${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}</b> · <span id="qOffsetLabel" class="confirm-offset ${aheadBy >= 0 ? 'ahead' : 'behind'}">${offsetLabel}</span></div>
      <div class="row3">
        <div class="field">${buildSelect('qPosition', POSITION_OPTIONS, undefined, true)}</div>
        <div class="field">${buildSelect('qWear', [['', 'Wear'], ...WEAR_STATE_OPTIONS.slice(1)], undefined, true)}</div>
        <div class="field">${buildSelect('qTimeOfDay', [['', 'Time'], ...TIME_OF_DAY_OPTIONS.slice(1)], undefined, true)}</div>
      </div>
      <div style="margin-top:12px;">${buildNoteField('qNote')}</div>
      <div class="row2" style="margin-top:12px;">
        <button type="button" class="btn-secondary" data-action="quickcancel" style="flex:1">Cancel</button>
        <button type="button" class="btn-primary" data-action="quickconfirm" style="flex:1">Log</button>
      </div>
    </div>
  `;
}


function buildManualForm(){
  return `
    <div class="quick-log-box">
      <form id="readingForm">
        <div class="row2">
          <div class="field">
            <label for="rDate">Date checked</label>
            <input type="date" id="rDate" required value="${todayStr()}" />
          </div>
          <div class="field stepper-row-field">
            <label for="rOffsetSeconds">Cumulative offset (sec)</label>
            <div class="stepper-row">
              <button type="button" class="zoom-btn" data-action="offsetstep" data-dir="-1">−</button>
              <input type="number" inputmode="numeric" id="rOffsetSeconds" step="1" value="0" required />
              <button type="button" class="zoom-btn" data-action="offsetstep" data-dir="1">+</button>
            </div>
          </div>
        </div>
        <p class="hint" style="margin:0;">Negative = slow, positive = fast, since you set it.</p>
        <div class="row3">
          <div class="field">${buildSelect('rPosition', POSITION_OPTIONS, undefined, true)}</div>
          <div class="field">${buildSelect('rWear', [['', 'Wear'], ...WEAR_STATE_OPTIONS.slice(1)], undefined, true)}</div>
          <div class="field">${buildSelect('rTimeOfDay', [['', 'Time'], ...TIME_OF_DAY_OPTIONS.slice(1)], undefined, true)}</div>
        </div>
        ${buildNoteField('rNote')}
        <div class="row2">
          <button type="button" class="btn-secondary" data-action="quickmode" style="flex:1">Cancel</button>
          <button type="submit" class="btn-primary" style="flex:1">Add reading</button>
        </div>
      </form>
    </div>
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
      wearCalendarYear = new Date().getFullYear();
      wearCalendarMonth = new Date().getMonth();
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
    const seconds = document.getElementById('rOffsetSeconds').value;
    const note = document.getElementById('rNote').value;
    if(!date || seconds === '') return;
    noteDraft = '';
    addReading(watch.id, date, Number(seconds), note, readConditionInputs('r'));
  };

  // Same tap-to-step, hold-to-accelerate interaction as the quick-snap
  // popup's time stepper (see the "timestep" handler below) — one second per
  // tap, five per tick once held past 800ms, no bound in either direction.
  document.querySelectorAll('[data-action="offsetstep"]').forEach(btn => {
    let holdTimeout = null;
    let holdInterval = null;
    const dir = Number(btn.dataset.dir);
    const step = (steps) => {
      const input = document.getElementById('rOffsetSeconds');
      if(!input) return;
      const current = input.value === '' ? 0 : Number(input.value);
      input.value = String(current + steps);
    };
    const clearHold = () => {
      if(holdTimeout) clearTimeout(holdTimeout);
      if(holdInterval) clearInterval(holdInterval);
      holdTimeout = null; holdInterval = null;
    };
    btn.onpointerdown = (e) => {
      e.preventDefault();
      step(dir);
      holdTimeout = setTimeout(() => {
        holdInterval = setInterval(() => step(dir * 5), 150);
      }, 800);
    };
    btn.onpointerup = clearHold;
    btn.onpointerleave = clearHold;
    btn.onpointercancel = clearHold;
  });

  const toggleBtn = document.querySelector('[data-action="manualmode"]');
  if(toggleBtn) toggleBtn.onclick = () => {
    manualMode = true; quickCaptured = null; quickAdjustSeconds = 0; quickSelectedField = 'minute'; noteDraft = '';
    render();
    if(watch) scrollWatchCardToTop(watch.id);
  };

  const quickModeBtn = document.querySelector('[data-action="quickmode"]');
  if(quickModeBtn) quickModeBtn.onclick = () => { manualMode = false; quickCaptured = null; quickAdjustSeconds = 0; quickSelectedField = 'minute'; noteDraft = ''; render(); };

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
      quickAdjustSeconds = 0;
      quickSelectedField = 'minute';
      noteDraft = '';
      playShutterSound();
      render();
      if(watch) scrollWatchCardToTop(watch.id);
    };
  });

  const quickCancelBtn = document.querySelector('[data-action="quickcancel"]');
  if(quickCancelBtn) quickCancelBtn.onclick = () => {
    quickCaptured = null;
    quickAdjustSeconds = 0;
    quickSelectedField = 'minute';
    noteDraft = '';
    render();
  };

  // Tapping a field in the time readout (hour/minute/second) switches which
  // one the +/- stepper below acts on — it's the only visible state here,
  // shown by which field is pulsing (see .confirm-time-field-selected).
  // Toggled directly on the existing elements rather than through render():
  // a full re-render recreates the confirm-time element and the group's
  // one-shot snap-flash overlay, retriggering both of their entrance
  // animations on every tap — a jarring flash for what should be a quiet
  // selection change.
  document.querySelectorAll('[data-action="selecttimefield"]').forEach(el=>{
    el.onclick = (e) => {
      e.stopPropagation();
      quickSelectedField = el.dataset.field;
      document.querySelectorAll('.confirm-time-field').forEach(f => {
        f.classList.toggle('confirm-time-field-selected', f.dataset.field === quickSelectedField);
      });
    };
  });

  // Press-and-hold on the stepper: one step per tap, then after ~800ms of
  // holding it switches to 5-per-tick so a big correction doesn't need
  // dozens of taps. Ticks mutate the displayed number directly rather than
  // calling render(), since a full re-render on every 150ms tick would be
  // wasteful and can drop pointer capture.
  document.querySelectorAll('[data-action="timestep"]').forEach(el=>{
    let holdTimeout = null;
    let holdInterval = null;
    const dir = Number(el.dataset.dir);
    // `steps` is a count, not seconds — converted to the right unit for
    // whichever field is selected (an hour step is 3600s, minute 60s,
    // second 1s), then just added to the one running total.
    const step = (steps) => {
      if(!quickCaptured) return;
      const unit = quickSelectedField === 'hour' ? 3600 : quickSelectedField === 'second' ? 1 : 60;
      quickAdjustSeconds += steps * unit;
      const displaySec = quickDisplaySeconds();
      const hourDisplay = document.getElementById('qHourDisplay');
      const minuteDisplay = document.getElementById('qMinuteDisplay');
      const secondDisplay = document.getElementById('qSecondDisplay');
      if(hourDisplay) hourDisplay.textContent = pad2(Math.floor(displaySec / 3600));
      if(minuteDisplay) minuteDisplay.textContent = pad2(Math.floor((displaySec % 3600) / 60));
      if(secondDisplay) secondDisplay.textContent = pad2(displaySec % 60);
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
    const note = qNote ? qNote.value : '';
    const diff = computeQuickOffsetSeconds();
    const date = c.toISOString().slice(0,10);
    const conditions = readConditionInputs('q');
    quickCaptured = null;
    quickAdjustSeconds = 0;
    quickSelectedField = 'minute';
    noteDraft = '';
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
