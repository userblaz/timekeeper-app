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

const CURRENCY_OPTIONS = [
  ['EUR', 'EUR'], ['USD', 'USD'], ['GBP', 'GBP'], ['CHF', 'CHF'], ['JPY', 'JPY'],
  ['AUD', 'AUD'], ['CAD', 'CAD'], ['HKD', 'HKD'], ['SGD', 'SGD'], ['CNY', 'CNY'],
  ['SEK', 'SEK'], ['NOK', 'NOK'], ['DKK', 'DKK'], ['PLN', 'PLN'], ['AED', 'AED']
];

function fmtMoney(n, currency){
  if(n === null || n === undefined || isNaN(n)) return '—';
  return new Intl.NumberFormat('de-DE', {
    style: 'currency', currency: currency || 'EUR', maximumFractionDigits: 0
  }).format(n);
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
    <div class="section" style="margin-top:0;padding-top:0;border-top:none;">
      <h2 class="section-title">${state.watches.length} watch${state.watches.length===1?'':'es'} owned</h2>
      <div class="collection-list">
        ${addHtml}
        ${typeof buildDemoWatchButtonHtml === 'function' ? buildDemoWatchButtonHtml() : ''}
        ${watchesHtml}
      </div>
    </div>
  `;
}

// How the watch is actually running, and the factory spec it's measured
// against — set small beside the name so they read as a qualifier on it
// rather than as a second column competing with the reserve bar. Either half
// is omitted when there's nothing to show.
function buildCollectionCardStats(w){
  const stats = overallStats(w);
  if(!stats && !w.accuracySpec) return '';
  const rateHtml = stats
    ? `<span class="card-rate ${stats.avgRate>=0?'good':'bad'}">${fmtRate(stats.avgRate)} s/day</span>`
    : '';
  // The rate right before it already carries the unit, so drop the spec's
  // own copy rather than printing "s/day" twice on one line.
  const specText = (w.accuracySpec || '').replace(/\s*s\/day\s*$/i, '');
  const specHtml = specText
    ? `<span class="card-spec">${escapeHtml(specText)}</span>`
    : '';
  return `${rateHtml}${specHtml}`;
}

// The last stretch of a mainspring's travel runs at reduced amplitude, and
// the rate drifts before the watch actually stops — so the bar marks it as a
// distinct zone rather than pretending the reserve is uniformly good. A
// quarter is the rough shape of it across most movements.
const POWER_RESERVE_LOW_FRACTION = 0.25;

// Hours elapsed since the watch was last marked fully wound, or null when
// either half of the sum is missing.
function powerReserveElapsed(w){
  if(!w.powerReserveHours || !w.lastWoundAt) return null;
  const wound = new Date(w.lastWoundAt).getTime();
  if(isNaN(wound)) return null;
  return (Date.now() - wound) / 3600000;
}

function formatReserveRemaining(hoursLeft){
  if(hoursLeft <= 0) return 'wound down';
  // Round to whole minutes first, then split. Rounding the minutes out of a
  // fractional hour lets them land on 60 and print "57h 60m".
  const totalMin = Math.round(hoursLeft * 60);
  if(totalMin < 60) return `${totalMin} min left`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h ${m}m left` : `${h}h left`;
}

// Nothing at all when no reserve has been set: a bar with a guessed capacity
// would be worse than no bar. Before the first wind it shows an empty track
// prompting the button rather than a full one, which would be a claim the
// app has no basis for.
function buildPowerReserveHtml(w){
  // The wind button is always there, so the row always says something —
  // otherwise the button looks like it does nothing.
  if(!w.powerReserveHours){
    return `<div class="reserve-row"><span class="reserve-label reserve-hint">set a power reserve to track it</span></div>`;
  }
  const elapsed = powerReserveElapsed(w);
  if(elapsed === null){
    return `<div class="reserve-row"><div class="reserve-track"></div><span class="reserve-label">not wound yet</span></div>`;
  }
  const hoursLeft = Math.max(0, w.powerReserveHours - elapsed);
  const pct = Math.max(0, Math.min(100, hoursLeft / w.powerReserveHours * 100));
  const low = pct <= POWER_RESERVE_LOW_FRACTION * 100;
  return `
    <div class="reserve-row" data-reserve-for="${w.id}">
      <div class="reserve-track">
        ${hoursLeft > 0 ? `<div class="reserve-low-zone" style="width:${(POWER_RESERVE_LOW_FRACTION*100).toFixed(0)}%"></div>` : ''}
        <div class="reserve-fill${hoursLeft <= 0 ? ' empty' : low ? ' low' : ''}" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <span class="reserve-label${hoursLeft <= 0 ? ' empty' : low ? ' low' : ''}">${formatReserveRemaining(hoursLeft)}</span>
    </div>
  `;
}

// A mainspring: the thing the button actually refers to. Deliberately not a
// circular arrow, which every app on the phone already uses for "refresh".
function windIconSvg(){
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
   <g transform="rotate(180 12 12)">
    <path d="M12.0,10.1 L12.4,10.0 L12.7,10.0 L13.1,10.1 L13.5,10.2 L13.9,10.4 L14.3,10.7 L14.6,11.1 L14.8,11.5 L14.9,12.0 L15.0,12.6 L15.0,13.1 L14.8,13.7 L14.6,14.2 L14.2,14.7 L13.8,15.2 L13.2,15.5 L12.6,15.8 L11.9,16.0 L11.2,16.0 L10.5,15.9 L9.8,15.7 L9.1,15.3 L8.4,14.9 L7.9,14.2 L7.5,13.5 L7.2,12.7 L7.0,11.9 L7.0,11.0 L7.1,10.1 L7.4,9.2 L7.9,8.4 L8.5,7.6 L9.3,7.0 L10.2,6.5 L11.2,6.1 L12.2,5.9 L13.3,6.0 L14.4,6.2 L15.4,6.6 L16.4,7.2 L17.2,7.9 L18.0,8.9 L18.5,9.9 L18.9,11.1 L19.1,12.3 L19.0,13.6 L18.8,14.8 L18.3,16.0 L17.6,17.1 L16.6,18.1 L15.6,18.9 L14.3,19.6 L13.0,20.0 L11.6,20.1 L10.1,20.0 L8.7,19.7 L7.4,19.1 L6.1,18.3" />
    <path d="M6.1,18.3 L9.3,17.5" /><path d="M6.1,18.3 L7.2,21.4" />
   </g>
  </svg>`;
}

// --- swipe-to-delete ---------------------------------------------------
// How far the card slides to reveal the delete panel, and how recently a
// swipe has to have ended for the click it generates to be ignored.
const SWIPE_REVEAL = 84;
let swipeEndedAt = 0;

// Shared by every swipeable row in the app (Collection cards, History rows)
// — whichever of these the row actually contains is the element that slides.
const SWIPE_CARD_SELECTOR = '.collection-card, .history-item';

function closeSwipeRows(except){
  document.querySelectorAll('.swipe-row.open').forEach(row => {
    if(row === except) return;
    row.classList.remove('open');
    row.classList.add('swiping');
    setTimeout(() => row.classList.remove('swiping'), 240);
    const card = row.querySelector(SWIPE_CARD_SELECTOR);
    if(card) card.style.transform = '';
  });
}

// Pointer events rather than touch events: one code path covers a finger and
// a mouse, which is also what makes this testable. The card carries
// touch-action:pan-y, so the browser keeps vertical scrolling for itself and
// hands us the horizontal movement — no preventDefault needed, so the
// listeners stay passive.
//
// cardSelector defaults to the Collection tab's own card, but any swipeable
// row (e.g. History's) can reuse this same gesture logic by passing its own.
// revealPx likewise defaults to the Collection tab's own reveal width, but a
// narrower delete button (History's) should only need to slide open that far.
function wireCollectionSwipe(cardSelector = '.collection-card', revealPx = SWIPE_REVEAL){
  document.querySelectorAll('.swipe-row').forEach(row => {
    const card = row.querySelector(cardSelector);
    if(!card) return;
    let startX = 0, startY = 0, base = 0, dx = 0;
    let decided = false, dragging = false;

    card.addEventListener('pointerdown', (e) => {
      // Deliberately not excluding the buttons on the card: a swipe that
      // happens to start on one still has to work, since you can't be
      // expected to aim around them. A tap on a button never starts a drag
      // (it doesn't move), so the two don't collide.
      startX = e.clientX; startY = e.clientY;
      base = row.classList.contains('open') ? -revealPx : 0;
      dx = base; decided = false; dragging = false;
      card.style.transition = 'none';
    });

    card.addEventListener('pointermove', (e) => {
      if(e.buttons === 0 && e.pointerType === 'mouse') return;
      const mx = e.clientX - startX, my = e.clientY - startY;
      if(!decided){
        // Wait for enough movement to tell a swipe from a scroll or a tap,
        // then commit — flipping mid-gesture feels broken.
        if(Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        decided = true;
        dragging = Math.abs(mx) > Math.abs(my);
      }
      if(!dragging) return;
      row.classList.add('swiping');
      // Rubber-banding past the reveal width, and no rightward travel beyond
      // closed — there's nothing to show on that side.
      dx = Math.min(0, Math.max(-revealPx - 20, base + mx));
      card.style.transform = `translateX(${dx}px)`;
    });

    const finish = () => {
      card.style.transition = '';
      if(!dragging) return;
      dragging = false;
      const open = dx < -revealPx / 2;
      closeSwipeRows(open ? row : null);
      row.classList.toggle('open', open);
      card.style.transform = open ? `translateX(${-revealPx}px)` : '';
      // While closing, the panel stays visible until the card has finished
      // sliding back over it — cutting it the instant the finger lifts looks
      // like the panel vanished rather than was covered.
      if(open) row.classList.remove('swiping');
      else setTimeout(() => row.classList.remove('swiping'), 240);
      swipeEndedAt = Date.now();
    };
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);
    card.addEventListener('pointerleave', finish);
  });
}

// Recomputes the bars from the clock. Used both by the 30-second tick — the
// bar moves about 0.04% a minute, so there is nothing to animate, it just
// needs refreshing — and straight after a wind, where keeping the existing
// elements is what lets the fill's width transition run.
function updatePowerReserveBars(){
  document.querySelectorAll('[data-reserve-for]').forEach(row => {
    const w = state.watches.find(x => x.id === row.dataset.reserveFor);
    if(!w) return;
    const elapsed = powerReserveElapsed(w);
    if(elapsed === null) return;
    const hoursLeft = Math.max(0, w.powerReserveHours - elapsed);
    const pct = Math.max(0, Math.min(100, hoursLeft / w.powerReserveHours * 100));
    const low = pct <= POWER_RESERVE_LOW_FRACTION * 100 && hoursLeft > 0;
    // Drop the low-zone marker once the reserve runs out — left behind on an
    // empty track it reads as a quarter still remaining.
    const zone = row.querySelector('.reserve-low-zone');
    if(zone) zone.hidden = hoursLeft <= 0;
    const fill = row.querySelector('.reserve-fill');
    const label = row.querySelector('.reserve-label');
    if(fill){
      fill.style.width = pct.toFixed(1) + '%';
      fill.classList.toggle('low', low);
      fill.classList.toggle('empty', hoursLeft <= 0);
    }
    if(label){
      label.textContent = formatReserveRemaining(hoursLeft);
      label.classList.toggle('low', low);
      label.classList.toggle('empty', hoursLeft <= 0);
    }
  });
}
setInterval(updatePowerReserveBars, 30000);

function buildCollectionCard(w){
  const photoHtml = w.photoUrl
    ? `<img class="collection-photo" src="${w.photoUrl}" alt="${escapeHtml(w.name)}" />`
    : `<div class="collection-photo collection-photo-empty">＋</div>`;
  const subtitle = [w.model, w.reference].filter(Boolean).join(' · ');

  // The card rides on top of a delete panel that's revealed by swiping it
  // left, the way a mail list works — so the destructive action isn't sitting
  // under your thumb on a card you only meant to open.
  return `
  <div class="swipe-row" data-swipe-id="${w.id}">
    <div class="swipe-delete">
      <button type="button" class="swipe-delete-btn" data-action="deletecollectionwatch" data-id="${w.id}" aria-label="Delete ${escapeHtml(w.name)}">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 7h16" /><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
        </svg>
      </button>
    </div>
    <div class="collection-card" data-action="viewcollection" data-id="${w.id}">
      ${photoHtml}
      <div class="collection-card-body">
        <div class="collection-card-name"><span class="card-name-text">${escapeHtml(w.name)}</span>${buildCollectionCardStats(w)}</div>
        <div class="collection-card-value">${subtitle ? escapeHtml(subtitle) : 'no model/reference set'}</div>
        ${w.conditionNotes ? `<div class="collection-card-note">${escapeHtml(w.conditionNotes)}</div>` : ''}
        ${buildPowerReserveHtml(w)}
      </div>
      <div class="collection-card-actions">
        <button type="button" class="zoom-btn collection-wind-btn" data-action="markwound" data-id="${w.id}" aria-label="Mark ${escapeHtml(w.name)} as fully wound" title="Fully wound now">
          ${windIconSvg()}
        </button>
      </div>
    </div>
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
          <div class="tg-stat-row"><span>${escapeHtml(s.label)} (${s.count} reading${s.count===1?'':'s'})</span><b style="color:${s.avg>=0?'var(--good)':'var(--bad)'}">${s.avg>=0?'+':''}${s.avg.toFixed(1)} s/day</b></div>
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
      <button type="button" class="reset-link back-link" data-action="backtocollectionlist" style="margin:22px 0 14px;">‹ Back to collection</button>
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
    ['Purchase price', w.purchasePrice ? fmtMoney(w.purchasePrice, w.purchaseCurrency) : null],
    ['Purchase date', w.purchaseDate ? formatShortDate(w.purchaseDate) : null],
    ['Factory accuracy spec', w.accuracySpec || null],
    ['Power reserve', w.powerReserveHours ? w.powerReserveHours + ' hours' : null],
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
    <button type="button" class="reset-link back-link" data-action="backtocollectionlist" style="margin:22px 0 14px;">‹ Back to collection</button>

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
        <label for="colName_${w.id}">Watch name</label>
        <input type="text" id="colName_${w.id}" value="${escapeHtml(w.name || '')}" placeholder="e.g. Submariner Date" />
      </div>
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
          <label for="colPrice_${w.id}">Purchase price</label>
          <div class="price-currency-row">
            <input type="number" id="colPrice_${w.id}" step="1" value="${w.purchasePrice ?? ''}" />
            ${buildSelect('colCurrency_'+w.id, CURRENCY_OPTIONS, w.purchaseCurrency || 'EUR')}
          </div>
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
        <label for="colReserve_${w.id}">Power reserve (hours)</label>
        <input type="number" id="colReserve_${w.id}" step="1" min="0" placeholder="e.g. 70" value="${w.powerReserveHours || ''}" />
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
  const nameEl = document.getElementById('colName_'+watchId);
  const modelEl = document.getElementById('colModel_'+watchId);
  const referenceEl = document.getElementById('colReference_'+watchId);
  const priceEl = document.getElementById('colPrice_'+watchId);
  const currencyEl = document.getElementById('colCurrency_'+watchId);
  const dateEl = document.getElementById('colDate_'+watchId);
  const notesEl = document.getElementById('colNotes_'+watchId);
  const reserveEl = document.getElementById('colReserve_'+watchId);
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
    // a watch always needs a name, so an emptied field keeps the old one
    name: (nameEl.value || '').trim() || w.name,
    model: (modelEl.value || '').trim() || null,
    reference: (referenceEl.value || '').trim() || null,
    purchase_price: priceEl.value === '' ? null : Number(priceEl.value),
    purchase_currency: (currencyEl && currencyEl.value) || 'EUR',
    purchase_date: dateEl.value || null,
    condition_notes: (notesEl.value || '').trim() || null,
    accuracy_spec: accuracySpec,
    power_reserve_hours: reserveEl && reserveEl.value !== '' ? Number(reserveEl.value) : null,
    certifications: certifications.length ? certifications.join(',') : null,
    photo_url: photoUrl || null
  };
  const { error } = await sb.from('watches').update(updates).eq('id', watchId);
  if(error){
    saveStatus = 'error';
    showToast(error.message || "Couldn't save — the write was rejected.", 'error');
    render();
    return;
  }

  w.name = updates.name;
  w.model = updates.model || '';
  w.reference = updates.reference || '';
  w.purchasePrice = updates.purchase_price;
  w.purchaseCurrency = updates.purchase_currency;
  w.purchaseDate = updates.purchase_date;
  w.conditionNotes = updates.condition_notes || '';
  w.accuracySpec = updates.accuracy_spec || '';
  w.powerReserveHours = updates.power_reserve_hours;
  w.certifications = updates.certifications ? updates.certifications.split(',').filter(Boolean) : [];
  w.photoUrl = updates.photo_url || '';

  editingCollectionId = null;
  collectionPhotoFile = null;
  saveState();
}

// Records "I have just fully wound this" — the only input the reserve bar
// takes. Nothing infers it: an automatic is being wound whenever it's worn,
// so any guess the app made would be wrong as often as right.
// Records "I have just fully wound this" — the only input the reserve bar
// takes. Nothing infers it: an automatic is being wound whenever it's worn,
// so any guess the app made would be wrong as often as right.
async function markFullyWound(watchId){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  const previous = w.lastWoundAt;
  const now = new Date().toISOString();

  // Applied before the write goes out — the feedback belongs to the press,
  // not to a network round trip. A rejected write rolls it back below.
  w.lastWoundAt = now;
  if(typeof playWindSound === 'function') playWindSound();

  // Updated in place rather than through render(). A full re-render rebuilds
  // the card's <img>, which repaints and made the photo twitch on every
  // press; keeping the element also lets the bar's width transition run from
  // where it actually was, with no need to fake a starting value.
  const card = document.querySelector(`.swipe-row[data-swipe-id="${watchId}"] .collection-card`);
  if(card && card.querySelector('.reserve-fill')){
    updatePowerReserveBars();
    playWoundFlash(card);
  } else {
    // First wind on this watch: there's no bar in the DOM yet to update.
    render();
    playWoundFlash(document.querySelector(`.swipe-row[data-swipe-id="${watchId}"] .collection-card`));
  }

  const { error } = await sb.from('watches').update({ last_wound_at: now }).eq('id', watchId);
  if(error){
    w.lastWoundAt = previous;
    render();
    showToast(error.message || "Couldn't save — the write was rejected.", 'error');
  }
}

// The green sweep across the card, cleaning up after itself.
function playWoundFlash(card){
  if(!card) return;
  card.classList.add('wound-flash');
  card.addEventListener('animationend', () => card.classList.remove('wound-flash'), { once:true });
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
    el.onclick = () => {
      // A swipe ends in a click. Ignore that one, and treat a tap on an
      // already-open card as "put it back" rather than "open me".
      if(Date.now() - swipeEndedAt < 300) return;
      const row = el.closest('.swipe-row');
      if(row && row.classList.contains('open')){ closeSwipeRows(null); return; }
      viewingCollectionId = el.dataset.id; editingCollectionId = null; collectionPhotoFile = null; render();
    };
  });
  wireCollectionSwipe();
  const backBtn = document.querySelector('[data-action="backtocollectionlist"]');
  if(backBtn) backBtn.onclick = () => { viewingCollectionId = null; editingCollectionId = null; collectionPhotoFile = null; render(); };
  const startEditBtn = document.querySelector('[data-action="startcollectionedit"]');
  if(startEditBtn) startEditBtn.onclick = () => { editingCollectionId = startEditBtn.dataset.id; collectionPhotoFile = null; saveStatus = ''; render(); };
  const cancelBtn = document.querySelector('[data-action="cancelcollection"]');
  if(cancelBtn) cancelBtn.onclick = () => { editingCollectionId = null; collectionPhotoFile = null; render(); };
  const saveBtn = document.querySelector('[data-action="savecollection"]');
  if(saveBtn) saveBtn.onclick = () => saveCollectionEdit(saveBtn.dataset.id);
  document.querySelectorAll('[data-action="markwound"]').forEach(btn => {
    btn.onclick = (e) => {
      // The card underneath opens the detail view, so this must not bubble.
      e.stopPropagation();
      // A swipe that started on this button ends in a click on it.
      if(Date.now() - swipeEndedAt < 300) return;
      markFullyWound(btn.dataset.id);
    };
  });
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
