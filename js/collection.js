// Collection tab: portfolio-style view of owned watches — purchase price,
// current value, photo and condition notes, with totals and per-watch
// profit/loss. Persists straight to the `watches` table columns added for
// this feature; photos go to the `watch-photos` Supabase Storage bucket.

let editingCollectionId = null;
let collectionPhotoFile = null;
let addingCollectionWatch = false;
// Which half of the "Add watch" card is showing — the catalog search
// (default) or the plain name-only fallback form. Reset to 'search' every
// time the card is opened fresh; see startaddcollectionwatch below.
let addWatchMode = 'search';
// Set on pointerdown, not click, on the catalog/manual switch buttons —
// see the comment above wireAddWatchModeSwitch below for why.
let addWatchSwitchHadFocus = false;
let watchSearchQuery = '';
// Each holds zero or more selected values now (see buildMultiSelect in
// app.js) rather than one — empty means "no filter", same as before, but
// picking more than one value within the same filter now widens the
// match instead of narrowing it (an OR within the filter, an AND across
// the four). Case material and dial hold *group* labels (see
// caseMaterialGroupOf/dialColorGroupOf below), not the catalog's own raw
// values — case_material alone already has far more raw variety than is
// usable in a checkbox list, so the filter groups them into a handful of
// buckets and matches a raw value through the same grouping.
let watchSearchCaseMaterials = [];
let watchSearchCaseDiameters = [];
let watchSearchMovementTypes = [];
let watchSearchDials = [];
let viewingCollectionId = null;
// Set right before the render() that first shows a watch's detail page, and
// consumed by that one render — so the opening animation plays exactly once
// per open, not on every later re-render while the detail page is up (an
// edit save, a scroll-driven clock collapse, etc).
let collectionDetailJustOpened = false;
// Which tab the back button on a watch's detail page returns to — the
// Collection tab's own list normally, but the Snap tab's "view in
// Collection" menu button opens the same detail page directly from there,
// so its back button needs to know to return to Snap instead.
let collectionDetailReturnTab = 'collection';

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

  // While the add-watch flow is open, the existing collection is hidden —
  // the add form is the only thing that needs attention, and it sits at
  // the top rather than buried under a full list of owned watches.
  const watchesHtml = addingCollectionWatch ? '' : state.watches.map(w => buildCollectionCard(w)).join('');
  const addHtml = buildAddWatchHtml();
  // The hint only earns its place once there's an actual order to change —
  // a single watch has nowhere to drag to. Same line as the count rather
  // than its own row underneath: two short fragments of text, not two
  // things worth a full line each.
  const headingHtml = addingCollectionWatch ? '' : `
    <div class="section-title-row">
      <h2 class="section-title">${state.watches.length} watch${state.watches.length===1?'':'es'} owned</h2>
      ${state.watches.length > 1 ? `<span class="hint">Drag cards to reorder</span>` : ''}
    </div>
  `;

  return `
    <div class="section" style="margin-top:0;padding-top:0;border-top:none;">
      ${headingHtml}
      <div class="collection-list">
        ${watchesHtml}
        ${addHtml}
        ${(!addingCollectionWatch && typeof buildDemoWatchButtonHtml === 'function') ? buildDemoWatchButtonHtml() : ''}
      </div>
    </div>
  `;
}

// How the watch is actually running, and the factory spec it's measured
// against — set small beside the name so they read as a qualifier on it
// rather than as a second column competing with the reserve bar. Either half
// is omitted when there's nothing to show.
// The catalog is small enough to fetch once and filter client-side on
// every keystroke (see data.js's ensureCatalogLoaded) — this is that
// filter, not a query. Brand/model/reference all get searched together so
// "submariner", "124060" and "rolex" all find the same entry.
function matchesCatalogQuery(entry, query){
  if(!query) return true;
  const q = query.trim().toLowerCase();
  if(!q) return true;
  return [entry.brand, entry.model, entry.reference]
    .filter(Boolean).join(' ').toLowerCase().includes(q);
}

// Case material has far more raw variety in the catalog than a fixed list
// of exact values can keep up with — brand-specific terms (Oystersteel,
// Rolesor, Everose) and descriptive phrasing (Satin-polished stainless
// steel) keep showing up that an exact-match table would just dump into
// "Other". This looks for a family keyword inside whatever the raw value
// actually says instead: any value mentioning two different families
// (Gold/Steel, "steel and rose gold", or a brand portmanteau like Rolesor
// that doesn't spell either one out) is Two-tone; one family on its own
// maps to its own group. The raw value on the watch itself is never
// touched by this — it's purely how the filter buckets and matches
// against it. "Silver" folds into Steel rather than getting its own group
// — modern watches essentially never use solid silver as a case, so in
// practice it's describing a steel case's finish, not a different
// material.
const CASE_MATERIAL_GROUP_ORDER = ['Steel', 'Two-tone', 'Gold', 'White gold / Platinum', 'Titanium', 'Ceramic', 'Carbon', 'Other'];
function caseMaterialGroupOf(raw){
  if(!raw) return null;
  const lower = raw.toLowerCase();
  // Rolex's own names for a steel+precious-metal case, neither of which
  // spells out "steel" or "gold"/"platinum" in the text at all — these
  // have to be caught explicitly rather than by family-counting below.
  if(/rolesor|rolesium/.test(lower)) return 'Two-tone';
  const families = {
    steel: /steel|silver/.test(lower),
    gold: /gold|everose/.test(lower),
    platinum: /platinum/.test(lower),
    titanium: /titanium/.test(lower),
    ceramic: /ceramic/.test(lower),
    carbon: /carbon/.test(lower)
  };
  const familyCount = Object.values(families).filter(Boolean).length;
  if(familyCount >= 2) return 'Two-tone';
  if(families.steel) return 'Steel';
  if(/white gold/.test(lower) || families.platinum) return 'White gold / Platinum';
  if(families.gold) return 'Gold';
  if(families.titanium) return 'Titanium';
  if(families.ceramic) return 'Ceramic';
  if(families.carbon) return 'Carbon';
  // A raw value nobody anticipated (aluminum, plastic, a typo, a material
  // added later) still needs to land somewhere findable rather than
  // silently matching no filter at all.
  return 'Other';
}

// Case diameter (case_size_mm) is numeric, not categorical — grouped into
// 2mm-wide bands through 36-45mm, where almost every watch actually falls,
// with wider catch-alls outside that range. Order matters: the first band
// whose upper bound the rounded size doesn't exceed wins, so this only
// needs an upper bound per step, not a min/max pair. Rounded to the
// nearest whole mm first, so a half-size (39.5mm, say) lands wherever it
// visually reads closest to rather than needing its own boundary case.
// Labels leave "mm" off each one — the column header (buildCaseFilterHtml)
// says "Size (mm)" once instead, freeing up the width every row was
// repeating it at.
const CASE_DIAMETER_GROUPS = [
  ['≤35', mm => mm <= 35],
  ['36–37', mm => mm <= 37],
  ['38–39', mm => mm <= 39],
  ['40–41', mm => mm <= 41],
  ['42–43', mm => mm <= 43],
  ['44–45', mm => mm <= 45],
  ['46+', () => true]
];
function caseDiameterGroupOf(raw){
  const mm = Number(raw);
  if(raw === null || raw === undefined || Number.isNaN(mm)) return null;
  const rounded = Math.round(mm);
  const hit = CASE_DIAMETER_GROUPS.find(([, fits]) => fits(rounded));
  return hit ? hit[0] : null;
}

// Dial colors have far more raw variety than case material — a finish
// (matte, sunburst, embossed, gradient, "fumé"...) is usually appended to
// a base color rather than the catalog sticking to a fixed word list — so
// rather than an exhaustive raw-value table like case material's, this
// looks for one of these main color words inside whatever the raw value
// actually says. "Black Matt" and "Black Embossed" both fold into "Black"
// this way without needing to list every finish anyone's ever typed in.
const DIAL_COLOR_GROUPS = [
  'Black', 'White', 'Blue', 'Green', 'Silver', 'Grey', 'Brown',
  'Champagne', 'Salmon', 'Gold', 'Red', 'Orange', 'Purple', 'Yellow',
  'Mother-of-pearl', 'Skeleton'
];
function dialColorGroupOf(raw){
  if(!raw) return null;
  const lower = raw.toLowerCase();
  const hit = DIAL_COLOR_GROUPS.find(color => lower.includes(color.toLowerCase()));
  return hit || 'Other';
}

function filteredWatchCatalog(){
  const list = watchCatalog || [];
  return list.filter(entry =>
    matchesCatalogQuery(entry, watchSearchQuery) &&
    (!watchSearchCaseMaterials.length || watchSearchCaseMaterials.includes(caseMaterialGroupOf(entry.case_material))) &&
    (!watchSearchCaseDiameters.length || watchSearchCaseDiameters.includes(caseDiameterGroupOf(entry.case_size_mm))) &&
    (!watchSearchMovementTypes.length || watchSearchMovementTypes.includes(entry.movement_type)) &&
    (!watchSearchDials.length || watchSearchDials.includes(dialColorGroupOf(entry.dial_color)))
  );
}

// Built from whatever's actually in the fetched catalog, not a fixed list —
// so it grows on its own as more watches get added to watch_catalog,
// rather than needing a code change every time a new case material shows
// up. (The name deliberately matches the helper the original, abandoned
// version of this feature called but never actually wrote — see the
// project handoff notes. This time it's real.)
function catalogFilterOptions(field){
  const list = watchCatalog || [];
  return Array.from(new Set(list.map(e => e[field]).filter(Boolean))).sort();
}

// Grouped counterpart to catalogFilterOptions, for case material/diameter/
// dial: still only offers a group if something in the currently fetched
// catalog actually falls into it (same "grows/shrinks with the real data"
// rule), but ordered by orderedGroups (a fixed, meaningful order — cheapest
// to widest, most to least common material) rather than alphabetically,
// since these labels don't sort into a sensible order on their own
// ("36–37mm" before "40–41mm" is only an accident of alphabetical sort,
// and it breaks entirely once a two-digit and "≤"/"+" label are compared).
function catalogFilterGroupOptions(rawField, groupFn, orderedGroups){
  const list = watchCatalog || [];
  const present = new Set(list.map(e => groupFn(e[rawField])).filter(Boolean));
  return orderedGroups.filter(g => present.has(g));
}

// The Case filter combines two independent facets (material, diameter)
// behind one trigger — Movement and Dial only ever hold one facet each, so
// buildMultiSelect (app.js) already fits those as-is, but Case needs its
// own two-hidden-input, two-column markup instead. Deliberately doesn't
// reuse buildMultiSelect's own data-action="multiselecttoggle": that
// handler (app.js) assumes every checkbox in a wrap's menu belongs to the
// SAME one hidden input, which would merge material and diameter picks
// together. casefiltertoggle (data-group tags which facet a box belongs
// to) plus its own dedicated change handling below keeps the two apart
// while still reusing the *shell* (the escape-to-<body>/positioning/
// outside-click-closes machinery in app.js, which only cares about
// .select-wrap/.select-menu/[data-action="toggleselect"] and never
// actually looks at what's inside the menu).
function buildCaseFilterHtml(materialGroups, diameterGroups){
  const materialSelected = new Set(watchSearchCaseMaterials);
  const diameterSelected = new Set(watchSearchCaseDiameters);
  const total = materialSelected.size + diameterSelected.size;
  const optionHtml = (value, group, selected) => `
    <label class="multi-select-option">
      <input type="checkbox" data-action="casefiltertoggle" data-group="${group}" value="${escapeHtml(value)}" ${selected.has(value) ? 'checked' : ''} />
      <span>${escapeHtml(value)}</span>
    </label>
  `;
  return `
    <div class="select-wrap multi-select-wrap case-filter-wrap" data-short-label="Case">
      <input type="hidden" id="catalogFilterCaseMaterial" value="${escapeHtml(Array.from(materialSelected).join(','))}" />
      <input type="hidden" id="catalogFilterCaseDiameter" value="${escapeHtml(Array.from(diameterSelected).join(','))}" />
      <button type="button" class="condition-select${total ? '' : ' placeholder'}" data-action="toggleselect" aria-expanded="false">
        <span class="select-value">Case${total ? ` (${total})` : ''}</span>
        <svg class="select-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
      </button>
      <div class="select-menu multi-select-menu case-filter-menu" data-for="catalogFilterCaseMaterial" hidden>
        <div class="case-filter-col">
          <div class="case-filter-col-label">Material</div>
          ${materialGroups.map(v => optionHtml(v, 'material', materialSelected)).join('')}
        </div>
        <div class="case-filter-col case-filter-col-size">
          <div class="case-filter-col-label">Size (mm)</div>
          ${diameterGroups.map(v => optionHtml(v, 'diameter', diameterSelected)).join('')}
        </div>
      </div>
    </div>
  `;
}

// Options come from whatever's actually in the fetched catalog (see
// catalogFilterOptions/catalogFilterGroupOptions), so this list — and
// therefore what shows up here — grows on its own as more watches are
// added to watch_catalog, with no code change needed on this end.
function buildCatalogFiltersHtml(){
  // While the catalog fetch is still in flight, watchCatalog is null and
  // every option list below would be empty — rendering nothing here until
  // it resolves is what used to make this row pop into existence (and
  // shove the results below it down) the instant the fetch finished.
  // Rendering the same row with empty option lists instead reserves its
  // real height from the very first paint, so refreshCatalogFilters()
  // just fills it in place once the data lands, with nothing to shift.
  if(watchCatalog === null){
    return `
      <div class="row3 watch-catalog-filters">
        ${buildCaseFilterHtml([], [])}
        ${buildMultiSelect('catalogFilterMovementType', 'Movement', [], watchSearchMovementTypes)}
        ${buildMultiSelect('catalogFilterDial', 'Dial', [], watchSearchDials)}
      </div>
    `;
  }
  const caseMaterialGroups = catalogFilterGroupOptions('case_material', caseMaterialGroupOf, CASE_MATERIAL_GROUP_ORDER);
  const caseDiameterGroups = catalogFilterGroupOptions('case_size_mm', caseDiameterGroupOf, CASE_DIAMETER_GROUPS.map(([g]) => g));
  const movementTypes = catalogFilterOptions('movement_type');
  const dialGroups = catalogFilterGroupOptions('dial_color', dialColorGroupOf, DIAL_COLOR_GROUPS.concat(['Other']));
  if(!caseMaterialGroups.length && !caseDiameterGroups.length && !movementTypes.length && !dialGroups.length) return '';
  const movementOptions = movementTypes.map(v => [v, v.charAt(0).toUpperCase() + v.slice(1)]);
  const dialOptions = dialGroups.map(v => [v, v]);
  return `
    <div class="row3 watch-catalog-filters">
      ${buildCaseFilterHtml(caseMaterialGroups, caseDiameterGroups)}
      ${buildMultiSelect('catalogFilterMovementType', 'Movement', movementOptions, watchSearchMovementTypes)}
      ${buildMultiSelect('catalogFilterDial', 'Dial', dialOptions, watchSearchDials)}
    </div>
  `;
}

const CATALOG_RESULTS_LIMIT = 25;

function buildCatalogResultsHtml(){
  // With nothing typed yet, there's nothing to show once loading finishes
  // regardless of how the fetch turns out — showing "Loading catalog…"
  // here would pop in and then collapse straight back to nothing the
  // moment it resolves with an empty query, the same jump the filters row
  // used to make. Query-typed loading still shows the hint below, since
  // that one settles into real results or a message rather than nothing.
  if(watchCatalogLoading && !watchSearchQuery.trim()) return '';
  if(watchCatalogLoading) return `<div class="watch-catalog-hint">Loading catalog…</div>`;
  if(!(watchCatalog || []).length){
    return `<div class="watch-catalog-hint">Catalog isn't available right now — add this watch manually instead.</div>`;
  }
  // Nothing shown until the user actually starts typing — with no query,
  // "matches" would just be the entire catalog, which reads as a random
  // dump rather than a search result.
  if(!watchSearchQuery.trim()) return '';
  const matches = filteredWatchCatalog();
  if(!matches.length){
    return `<div class="watch-catalog-hint">No matches — try a different search, or add it manually instead.</div>`;
  }
  const shown = matches.slice(0, CATALOG_RESULTS_LIMIT);
  const rowsHtml = shown.map(entry => {
    const meta = [entry.reference, entry.case_material,
      entry.movement_type ? entry.movement_type.charAt(0).toUpperCase() + entry.movement_type.slice(1) : ''
    ].filter(Boolean).join(' · ');
    return `
    <button type="button" class="watch-catalog-result" data-action="selectcatalogwatch" data-id="${escapeHtml(entry.id)}">
      <span class="watch-catalog-result-name">${escapeHtml(entry.brand)} ${escapeHtml(entry.model)}</span>
      ${meta ? `<span class="watch-catalog-result-meta">${escapeHtml(meta)}</span>` : ''}
    </button>`;
  }).join('');
  const moreHtml = matches.length > CATALOG_RESULTS_LIMIT
    ? `<div class="watch-catalog-hint">+${matches.length - CATALOG_RESULTS_LIMIT} more — narrow your search to see them</div>`
    : '';
  return rowsHtml + moreHtml;
}

// The "Add watch" card itself: a catalog search by default (with a plain
// name-only fallback one tap away), or the button that opens it. Separated
// out from buildCollectionTabHtml so re-render doesn't need touching there
// every time this card's own two modes change.
function buildAddWatchHtml(){
  if(!addingCollectionWatch){
    return `<button type="button" class="collection-add-btn" data-action="startaddcollectionwatch">+ Add watch</button>`;
  }
  if(addWatchMode === 'manual'){
    return `
    <div class="collection-card collection-card-edit">
      <div class="field">
        <div class="field-label-row">
          <button type="button" class="zoom-btn collection-addwatch-back-btn" data-action="canceladdcollectionwatch" aria-label="Back to collection">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <label for="newCollectionWatchName">Brand</label>
          <button type="button" class="manual-link manual-link-inline" data-action="switchtocatalogsearch">Search the catalog</button>
        </div>
        <input type="text" id="newCollectionWatchName" placeholder="e.g. Rolex, Omega, Seiko…" />
      </div>
      <button type="button" class="btn-primary" data-action="addcollectionwatch">Add watch</button>
    </div>
    `;
  }
  return `
  <div class="collection-card collection-card-edit">
    <div class="field">
      <div class="field-label-row">
        <button type="button" class="zoom-btn collection-addwatch-back-btn" data-action="canceladdcollectionwatch" aria-label="Back to collection">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <label for="watchCatalogSearch">Find your watch</label>
        <button type="button" class="manual-link manual-link-inline" data-action="switchtomanualadd">Add manually</button>
      </div>
      <input type="text" id="watchCatalogSearch" placeholder="Brand, model, or reference…" autocomplete="off" value="${escapeHtml(watchSearchQuery)}" />
    </div>
    <div id="watchCatalogFilters">${buildCatalogFiltersHtml()}</div>
    <div id="watchCatalogResults" class="watch-catalog-results">${buildCatalogResultsHtml()}</div>
  </div>
  `;
}

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
  // Whole hours only, no minutes and no "left" — keeps the row short on the
  // Data tab's cards, where it sits next to a name, a rate badge and now a
  // third action button. Rounded up rather than to nearest, so a sliver of
  // reserve still reads as "1h" instead of a misleading "0h".
  return `${Math.max(1, Math.ceil(hoursLeft))}h`;
}

// Nothing at all when no reserve has been set: a bar with a guessed capacity
// would be worse than no bar. Before the first wind it shows an empty track
// prompting the button rather than a full one, which would be a claim the
// app has no basis for.
function buildPowerReserveHtml(w){
  // The wind button is always there, so the row always says something —
  // otherwise the button looks like it does nothing.
  if(!w.powerReserveHours){
    return `<div class="reserve-row"><span class="reserve-label reserve-hint">set power reserve</span></div>`;
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

// Stands in for a watch's own photo wherever one hasn't been set yet — on
// a card in a list, never a spot that's itself clickable to add one (that's
// a proper "Add photo" button, in the edit form only — see
// buildCollectionEditForm). A "+" there read as "tap to add a photo" on a
// card that doesn't do that; a plain wristwatch face (a case with two
// hands, plus a short strap mark top and bottom so it doesn't read as a
// generic wall clock) just says "no photo" without implying a tap does
// anything. Deliberately its own icon rather than a reuse of an existing
// one elsewhere — the first attempt here borrowed the Snap tab's icon on
// the assumption it was a watch case, but that one's actually a camera
// (its whole point is "this tab takes a photo/reading"), and reused here
// it just read as a camera icon on a photo placeholder.
// The same watch glyph as the bottom-tabs bar's own Collection icon (see
// index.html) — reused exactly rather than redrawn, so "no photo yet"
// reads as the same watch shape already established elsewhere in the app
// instead of a second, slightly different one only this spot uses.
function watchPlaceholderIconSvg(){
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8.5 2.5h7l0.6 3.5h-8.2z" />
    <path d="M8.5 21.5h7l-0.6-3.5h-6.8z" />
    <circle cx="12" cy="12" r="6.2" />
    <path d="M12 9v3l2 1.3" />
  </svg>`;
}

// A plain pencil — the watch bar's own way into edit mode now (see
// buildCollectionWatchBarHtml), replacing the old full-width "Edit watch
// details" button that used to sit further down the detail page.
function editIconSvg(){
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>`;
}

function windIconSvg(){
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
   <g transform="rotate(180 12 12)">
    <path d="M12.0,10.1 L12.4,10.0 L12.7,10.0 L13.1,10.1 L13.5,10.2 L13.9,10.4 L14.3,10.7 L14.6,11.1 L14.8,11.5 L14.9,12.0 L15.0,12.6 L15.0,13.1 L14.8,13.7 L14.6,14.2 L14.2,14.7 L13.8,15.2 L13.2,15.5 L12.6,15.8 L11.9,16.0 L11.2,16.0 L10.5,15.9 L9.8,15.7 L9.1,15.3 L8.4,14.9 L7.9,14.2 L7.5,13.5 L7.2,12.7 L7.0,11.9 L7.0,11.0 L7.1,10.1 L7.4,9.2 L7.9,8.4 L8.5,7.6 L9.3,7.0 L10.2,6.5 L11.2,6.1 L12.2,5.9 L13.3,6.0 L14.4,6.2 L15.4,6.6 L16.4,7.2 L17.2,7.9 L18.0,8.9 L18.5,9.9 L18.9,11.1 L19.1,12.3 L19.0,13.6 L18.8,14.8 L18.3,16.0 L17.6,17.1 L16.6,18.1 L15.6,18.9 L14.3,19.6 L13.0,20.0 L11.6,20.1 L10.1,20.0 L8.7,19.7 L7.4,19.1 L6.1,18.3" />
    <path d="M6.1,18.3 L9.3,17.5" /><path d="M6.1,18.3 L7.2,21.4" />
   </g>
  </svg>`;
}

// A calendar with a checked-off day for the "worn today" toggle — reads as
// "today, marked" rather than a generic checkmark, and stays legible at the
// same small size as the wind icon beside it.
function wornIconSvg(){
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
    <path d="M3.5 9.5h17" />
    <path d="M8 3v3" /><path d="M16 3v3" />
    <path d="M8.5 14.7l2 2 4.5-4.5" />
  </svg>`;
}

// A forward chevron — the mirror image of the back arrows used elsewhere
// (collection-back-btn, profile-back-btn) — jumps straight to this watch's
// Collection detail page: full specs, charts, history, the wear calendar,
// everything the Data tab's trimmed-down card leaves out. Reads as "go into
// this" the same way the back arrow reads as "go out of this", where three
// dots (the previous icon here) read as "more options" and didn't match
// what tapping it actually does.
function menuIconSvg(){
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 18l6-6-6-6" />
  </svg>`;
}

// The exact camera glyph the Snap tab itself uses in the bottom nav bar
// (see index.html) — reused rather than redrawn, so a button that jumps to
// Snap reads as "go to Snap" on sight.
function cameraIconSvg(){
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 8a2 2 0 0 1 2-2h1.2l0.9-1.4a1.6 1.6 0 0 1 1.35-0.6h5.1a1.6 1.6 0 0 1 1.35 0.6L16.8 6H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.6" />
  </svg>`;
}

// --- swipe-to-delete ---------------------------------------------------
// How far the card slides to reveal the delete panel, and how recently a
// swipe has to have ended for the click it generates to be ignored.
const SWIPE_REVEAL = 84;
let swipeEndedAt = 0;
// Matches .collection-list{gap:12px} in styles.css exactly — the reorder
// drag's sibling-shift math (wireCollectionReorder, below) needs the real
// gap value, not just an approximation of it.
const COLLECTION_LIST_GAP = 12;

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
      // A long-press on this same card has claimed the gesture as a reorder
      // drag instead (wireCollectionReorder, below) — once that's happened,
      // this listener has to back off entirely rather than also interpret
      // the same movement as a swipe.
      if(row.dataset.reordering === '1') return;
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

// Collection tab's drag-to-reorder. The whole card is the drag target now,
// rather than a dedicated handle — a long press (REORDER_LONG_PRESS_MS)
// held still is what tells a reorder apart from the card's other two
// gestures (tap to open, horizontal drag to reveal delete —
// wireCollectionSwipe above) and from the browser's own vertical page
// scroll, the same way picking something up on a phone home screen works.
// Real movement before the hold completes cancels it outright and leaves
// the gesture to whichever of those it actually was — wireCollectionSwipe
// gets first refusal on it via its own, independent pointerdown/pointermove
// pair on the same card; this only ever steps in once the hold wins.
//
// Manual pointer tracking rather than the HTML5 drag-and-drop API, same
// reasoning as wireCollectionSwipe: this is a phone PWA, and native DnD's
// touch support is unreliable there. Only one render() happens, right at
// the end — every intermediate frame moves rows with a direct transform,
// same principle as the swipe gesture and the Add Watch search box's own
// lesson about not rebuilding the DOM out from under an in-progress
// gesture.
const REORDER_LONG_PRESS_MS = 400;
// Set the moment a long-press wins, checked by the viewcollection click
// handler the same way swipeEndedAt already is — releasing a drag (or even
// just a long-press that never moved anywhere) still ends in a pointerup,
// which would otherwise also open the watch that was just held down on.
let reorderEndedAt = 0;
function wireCollectionReorder(){
  const list = document.querySelector('.collection-list');
  if(!list) return;

  document.querySelectorAll('.collection-list > .swipe-row').forEach(row => {
    const card = row.querySelector('.collection-card');
    if(!card) return;

    // -webkit-touch-callout:none (styles.css) stops iOS Safari's own
    // long-press callout (Save Photo, Copy, etc.) from racing our long
    // press, but that property is WebKit-only — Android Chrome's native
    // long-press menu doesn't respect it. contextmenu is what every mobile
    // browser actually fires to open that menu, so preventing it directly
    // is the one thing that reliably heads it off everywhere.
    card.addEventListener('contextmenu', (e) => e.preventDefault());

    let longPressTimer = null;
    let dragging = false, startX = 0, startY = 0, startIndex = 0, targetIndex = 0;
    let rows = [], tops = [], heights = [];
    // Mouse-only: has this gesture's direction (vertical drag vs. anything
    // else) already been decided? Touch doesn't need this — the long press
    // itself is what commits to a reorder there.
    let mouseDecided = false;

    const shiftFor = (i) => {
      if(i === startIndex) return '';
      if(startIndex < targetIndex && i > startIndex && i <= targetIndex){
        return `translateY(${-(heights[startIndex] + COLLECTION_LIST_GAP)}px)`;
      }
      if(startIndex > targetIndex && i < startIndex && i >= targetIndex){
        return `translateY(${heights[startIndex] + COLLECTION_LIST_GAP}px)`;
      }
      return '';
    };

    const cancelLongPress = () => {
      if(longPressTimer){ clearTimeout(longPressTimer); longPressTimer = null; }
    };

    const beginDrag = (pointerId) => {
      rows = Array.from(list.querySelectorAll(':scope > .swipe-row'));
      startIndex = rows.indexOf(row);
      if(startIndex === -1 || rows.length < 2) return;
      closeSwipeRows(null);
      dragging = true;
      targetIndex = startIndex;
      tops = rows.map(r => r.offsetTop);
      heights = rows.map(r => r.offsetHeight);
      // The class does two jobs: the lift/scale feedback that confirms the
      // hold actually won (see styles.css), and — same rule — switches this
      // card's touch-action to none. pan-y (its normal value) hands vertical
      // movement straight to the browser as a page scroll; changing that
      // only once a drag really starts, rather than from the first touch,
      // is what lets an ordinary scroll that happens to begin on this card
      // keep working right up until a long-press actually wins.
      row.classList.add('dragging');
      // Marks this row as claimed for wireCollectionSwipe's own listener on
      // the same card — see the check at the top of its pointermove.
      row.dataset.reordering = '1';
      row.style.transition = 'none';
      try{ card.setPointerCapture(pointerId); }catch(e){}
    };

    const applyDragFrame = (clientY) => {
      const dy = clientY - startY;
      row.style.transform = `translateY(${dy}px)`;

      // Every top/height here is from the pre-drag layout, since nothing
      // else actually moves in the DOM until drop — only the dragged
      // row's own translateY changes live, so its neighbors' positions
      // stay a stable yardstick for "has it been dragged past this one
      // yet".
      const draggedCenter = tops[startIndex] + heights[startIndex] / 2 + dy;
      let newIndex = startIndex;
      rows.forEach((r, i) => {
        if(i === startIndex) return;
        const center = tops[i] + heights[i] / 2;
        if(i < startIndex && draggedCenter < center) newIndex = Math.min(newIndex, i);
        if(i > startIndex && draggedCenter > center) newIndex = Math.max(newIndex, i);
      });
      targetIndex = newIndex;

      rows.forEach((r, i) => {
        if(i === startIndex) return;
        r.style.transition = 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)';
        r.style.transform = shiftFor(i);
      });
    };

    card.addEventListener('pointerdown', (e) => {
      if(e.pointerType === 'mouse' && e.button !== 0) return;
      startX = e.clientX; startY = e.clientY;
      dragging = false;
      mouseDecided = false;
      cancelLongPress();
      // A mouse has no page-scroll gesture to disambiguate against — that's
      // what the long press below exists for on touch — and no on-screen
      // affordance hints at "hold to pick up" the way a phone home screen
      // does. Desktop users expect an ordinary click-and-drag to just work,
      // so mouse skips the wait entirely; pointermove below decides by
      // direction instead, the same way wireCollectionSwipe already does.
      if(e.pointerType === 'mouse'){
        // Captured immediately, before any movement — touch gets this for
        // free as implicit capture (every browser routes a touch's moves
        // back to wherever it started), but a mouse doesn't, so without
        // this the moment the cursor crosses into the row below, the
        // browser starts hit-testing pointermove events onto THAT row's
        // card instead of this one, and the direction decision below
        // never sees its own gesture past the first ~row height.
        try{ card.setPointerCapture(e.pointerId); }catch(err){}
        return;
      }
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        beginDrag(e.pointerId);
      }, REORDER_LONG_PRESS_MS);
    });

    card.addEventListener('pointermove', (e) => {
      if(dragging){
        applyDragFrame(e.clientY);
        return;
      }
      if(e.pointerType === 'mouse'){
        if(mouseDecided) return;
        const mx = e.clientX - startX, my = e.clientY - startY;
        if(Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        mouseDecided = true;
        // Horizontal movement is wireCollectionSwipe's own gesture (reveal
        // delete) — leave it alone rather than also claiming it here.
        if(Math.abs(my) <= Math.abs(mx)) return;
        beginDrag(e.pointerId);
        // Apply this same move as the drag's first frame instead of
        // waiting for the next pointermove, so the row doesn't lag a step
        // behind the cursor the moment the drag starts.
        if(dragging) applyDragFrame(e.clientY);
        return;
      }
      // Still waiting out the hold — real movement this early means it's a
      // tap, a scroll or a swipe instead, so the long-press never fires.
      if(longPressTimer){
        const mx = e.clientX - startX, my = e.clientY - startY;
        if(Math.abs(mx) > 8 || Math.abs(my) > 8) cancelLongPress();
      }
    });

    const finish = () => {
      cancelLongPress();
      if(!dragging) return;
      dragging = false;
      delete row.dataset.reordering;
      rows.forEach(r => {
        r.style.transition = '';
        r.style.transform = '';
        r.classList.remove('dragging');
      });
      reorderEndedAt = Date.now();
      if(targetIndex !== startIndex){
        const [moved] = state.watches.splice(startIndex, 1);
        state.watches.splice(targetIndex, 0, moved);
        persistWatchOrder();
        render();
      }
    };
    card.addEventListener('pointerup', finish);
    card.addEventListener('pointercancel', finish);

    // touch-action:none only takes effect once the 'dragging' class lands
    // (styles.css) — after the long press has already won — but at least
    // WebKit doesn't reliably re-evaluate touch-action for a touch sequence
    // that's already under way: it can stay committed to pan-y (the value
    // in effect back at the original touchstart) and hand the very next
    // real vertical move to the page as a native scroll instead of to this
    // gesture, cancelling the pointer out from under it. That reads as
    // exactly what it looks like on screen — the card lifts (dragging's
    // CSS fires fine, no JS needed for that part), then the instant a
    // finger actually moves it snaps back to place, because finish() below
    // just cleaned up after a pointercancel it never expected. touch-action
    // can't be fought with more CSS; the one thing that reliably stops a
    // scroll already in flight is preventDefault() on the raw touchmove
    // event itself, which pointermove (an abstraction on top of touch
    // events) can't do — so this listens for that directly, registered
    // non-passive up front (passivity can't be changed after the fact) and
    // only actually acts once a drag is underway.
    card.addEventListener('touchmove', (e) => {
      if(dragging) e.preventDefault();
    }, { passive: false });
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
  // draggable="false" — without it, Chrome and Safari treat this <img> as a
  // native HTML5 drag source. Pressing down on the photo and moving even a
  // couple pixels fires the browser's own dragstart, which immediately
  // cancels the pointer sequence (pointercancel) our own long-press reorder
  // (wireCollectionReorder, below) depends on — confirmed by logging the
  // event order: pointerdown, pointermove, dragstart, pointercancel, all
  // within a few ms, well before the 400ms long-press ever gets a chance to
  // fire. Brave (and touch browsers generally) don't hijack the gesture this
  // way, which is why the bug only showed up in Chrome/Safari on desktop.
  const photoHtml = w.photoUrl
    ? `<img class="collection-photo" src="${w.photoUrl}" alt="${escapeHtml(w.name)}" draggable="false" />`
    : `<div class="collection-photo collection-photo-empty">${watchPlaceholderIconSvg()}</div>`;
  const subtitle = [w.model, w.reference].filter(Boolean).join(' · ');
  // Condition notes were free text the owner typed once, on a card meant
  // for a quick scan of the whole collection — this is what actually
  // answers "am I wearing this one" at a glance instead. Same null-means-
  // not-enough-history behavior as the detail page's own wear stats (see
  // computeWearStats, data.js): nothing shown until there's at least one
  // completed month of wear activity to average.
  const wearStats = computeWearStats(w);
  const sparkHtml = buildCardCharts(w);
  const statsHtml = buildCollectionCardStats(w);

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
        <div class="collection-card-name"><span class="card-name-text">${escapeHtml(w.name)}</span></div>
        ${statsHtml ? `<div class="collection-card-stats">${statsHtml}</div>` : ''}
        <div class="collection-card-value">${subtitle ? escapeHtml(subtitle) : 'no model/reference set'}</div>
        ${wearStats ? `<div class="collection-card-wear">${Math.round(wearStats.avgPerMonth)} days/mo worn</div>` : ''}
      </div>
      ${sparkHtml ? `<div class="collection-card-spark" data-action="viewcollectionchart" data-id="${w.id}" role="button" aria-label="View ${escapeHtml(w.name)}'s charts">${sparkHtml}</div>` : ''}
      <div class="collection-card-actions">
        <span class="zoom-btn collection-card-chevron" aria-hidden="true">${menuIconSvg()}</span>
      </div>
    </div>
  </div>
  `;
}

// A long enough list always ends with some card only partly visible above
// the fixed bottom tab bar — ordinarily fine (that's just a scrollable list
// under a floating bar), but at each card's own natural height that cut
// lands at a different, arbitrary point on different screens, which read
// as sloppy rather than intentional. Stretching every card by the same
// small amount — never shrinking, and never touching an individual card's
// own height differently from the rest — so that however many cards
// naturally fit in the space above the bar do so exactly, with the next
// one's top edge landing right on the bar instead of a few px into it,
// makes that cut look deliberate on any screen instead of just wherever it
// happened to fall. Left alone entirely when the whole list already fits
// without scrolling — there's no next card peeking through to align in
// that case, and stretching a short list to fill the rest of the screen
// would look like a bug, not a fix.
function syncCollectionCardHeights(){
  if(activeTab !== 'collection' || addingCollectionWatch || viewingCollectionId) return;
  const listEl = document.querySelector('.collection-list');
  const bar = document.getElementById('bottomTabs');
  if(!listEl || !bar || bar.style.display === 'none') return;
  const cards = listEl.querySelectorAll(':scope > .swipe-row .collection-card');
  if(!cards.length) return;

  // Reset before measuring, every time — otherwise a second call (a
  // resize, a watch added or removed) would measure against the previous
  // call's already-stretched height instead of the card's real, natural
  // one, and compound taller with each call.
  cards.forEach(c => { c.style.height = ''; });

  const gapStr = getComputedStyle(listEl).rowGap;
  const gap = parseFloat(gapStr && gapStr !== 'normal' ? gapStr : getComputedStyle(listEl).gap) || 0;
  const naturalHeight = cards[0].getBoundingClientRect().height;
  const available = bar.getBoundingClientRect().top - listEl.getBoundingClientRect().top;
  if(available <= 0 || naturalHeight <= 0) return;

  // Each fitted card claims one gap along with it, the one right after it
  // — including the last: what should land on the bar is the *next* card's
  // top edge, not the last fitted card's bottom, and those are gap px
  // apart. Folding the trailing gap into the space every card (including
  // the last) gets to stretch into is what actually lands that edge on the
  // bar instead of gap px short of it.
  const nFit = Math.floor(available / (naturalHeight + gap));
  if(nFit < 1 || cards.length <= nFit) return; // everything already fits — leave natural

  const stretched = (available - nFit * gap) / nFit;
  cards.forEach(c => { c.style.height = stretched + 'px'; });
}
// Only ever recomputed at the very top of the list, on purpose, not on
// every resize regardless of scroll position (the first version here did
// exactly that). The reference clock at the top of the page collapses as
// it scrolls, so the list's own position relative to the page genuinely
// isn't fixed — it really is closer to the bar once scrolled, not just a
// stale measurement — which meant a resize firing mid-scroll (the address
// bar showing or hiding does this on iOS, constantly, on ordinary scrolling)
// restretched every card to a different height than the one this opened
// with, in the middle of a scroll gesture. There's also nothing to fix at
// the bar for a scroll position where the list's top isn't even in view —
// the whole point is lining up where the list *starts* with the bar, which
// only means anything while that's what's on screen. Skipping entirely
// once scrolled means this can only ever change at the one moment it's
// actually meant to.
function syncCollectionCardHeightsIfAtTop(){
  if(window.scrollY < 2) syncCollectionCardHeights();
}
window.addEventListener('resize', syncCollectionCardHeightsIfAtTop);
window.addEventListener('orientationchange', syncCollectionCardHeightsIfAtTop);
if(document.fonts && document.fonts.ready) document.fonts.ready.then(syncCollectionCardHeightsIfAtTop);

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
        <h2 class="section-title">Accuracy Insights</h2>
        <p class="empty-note">Log a few readings with different positions, wear states, or times of day to see whether they affect this watch's rate.</p>
      </div>
    `;
  }

  return `
    <div class="section">
      <h2 class="section-title">Accuracy Insights</h2>
      ${pointers.length > 0 ? `<p class="hint" style="margin-bottom:16px;">${pointers.map(escapeHtml).join(' ')}</p>` : ''}
      ${blocks.join('')}
    </div>
  `;
}

const WEAR_CALENDAR_MONTH_LABELS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEAR_CALENDAR_WEEKDAY_LABELS = ['S','M','T','W','T','F','S'];

// Which month/year the wear calendar is currently showing — module-level
// state, not per-render, so it survives a re-render caused by something
// unrelated (toggling a day, a scroll-driven clock collapse) without
// snapping back to the current month underneath the user. Reset to the
// real current month/year only when a watch's detail page is freshly
// opened (see goToWatchDetail's set site).
let wearCalendarYear = new Date().getFullYear();
let wearCalendarMonth = new Date().getMonth();

// One real calendar month — weekday-aligned with leading blanks.
function buildWearMonthPageHtml(w, year, m, todayStr){
  const daysInMonth = new Date(year, m + 1, 0).getDate();
  const firstWeekday = new Date(year, m, 1).getDay();
  let cells = '';
  for(let i = 0; i < firstWeekday; i++) cells += `<div class="wear-day-blank"></div>`;
  for(let d = 1; d <= daysInMonth; d++){
    const dateStr = `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const isFuture = dateStr > todayStr;
    const filled = !isFuture && isDayWorn(w, dateStr);
    cells += `<button type="button" class="wear-day${filled ? ' filled' : ''}${isFuture ? ' future' : ''}" data-action="togglewearday" data-id="${w.id}" data-date="${dateStr}" ${isFuture ? 'disabled' : ''} aria-label="${dateStr}${filled ? ', worn' : ''}">${d}</button>`;
  }
  return `
    <div class="wear-month-page">
      <div class="wear-weekday-row">${WEAR_CALENDAR_WEEKDAY_LABELS.map(x => `<span>${x}</span>`).join('')}</div>
      <div class="wear-days-grid">${cells}</div>
    </div>
  `;
}

// Four quick numbers, as tiles rather than spec-sheet rows since these are
// meant to be read at a glance, not looked up: the average worn days per
// month since this watch's first tracked wear day, the most recently
// completed month's own count next to how it compares to the month before
// it, how long it's been since the watch was last worn at all, and — with
// more than one watch being tracked — its share of all the wear logged
// across the whole collection last month. The monthly figures only ever
// look at whole, completed calendar months (see computeWearStats and
// wearShareOfCollection in data.js) — the one in progress right now is
// left out of all of them, or it would always read as artificially low
// next to a full month — while "last worn" is naturally as current as
// today.
//
// Below the tiles, a 6-month sparkline of the same monthly counts (see
// wearMonthlySeries) — the tiles are a snapshot, the sparkline is the
// trend behind them. Bar height is relative to a 31-day month, not to
// whichever of these six months happens to be the busiest, so the same
// watch's bars stay comparable release to release rather than rescaling
// themselves every time the busiest month ages out of the window.
//
// Last, a single plain-language pattern statement (see wearPatternInsight
// in data.js) when the wear history actually supports one — the most
// statistically obvious day-of-week skew in how this watch gets worn,
// rather than every dimension that could theoretically be sliced.
function buildWearStatsHtml(w){
  const stats = computeWearStats(w);
  const lastWornDays = daysSinceLastWorn(w);
  const sharePct = wearShareOfCollection(w);

  const fmtLastWorn = (days) => {
    if(days === null) return '—';
    if(days === 0) return 'Today';
    if(days === 1) return '1d ago';
    return `${days}d ago`;
  };

  let deltaHtml = '';
  if(stats && stats.deltaPct !== null){
    const cls = stats.deltaPct > 0 ? 'up' : (stats.deltaPct < 0 ? 'down' : 'flat');
    const sign = stats.deltaPct > 0 ? '+' : '';
    deltaHtml = `<div class="wear-stat-delta ${cls}">${sign}${stats.deltaPct}%</div>`;
  }

  // Only shown once there's more than one watch to actually share wear
  // with — with a single watch this would always read ~100%, which is
  // true but tells you nothing.
  const shareTileHtml = state.watches.length < 2 ? '' : `
    <div class="wear-stat-tile">
      <div class="wear-stat-value">${sharePct === null ? '—' : sharePct + '%'}</div>
      <div class="wear-stat-label">share of wear</div>
    </div>
  `;

  const tilesHtml = `
    <div class="wear-stats-tiles">
      <div class="wear-stat-tile">
        <div class="wear-stat-value">${stats ? Math.round(stats.avgPerMonth) : '—'}</div>
        <div class="wear-stat-label">avg days/mo</div>
      </div>
      <div class="wear-stat-tile">
        <div class="wear-stat-value">${stats ? stats.lastMonthDays : '—'}</div>
        <div class="wear-stat-label">last month</div>
        ${deltaHtml}
      </div>
      <div class="wear-stat-tile">
        <div class="wear-stat-value">${fmtLastWorn(lastWornDays)}</div>
        <div class="wear-stat-label">last worn</div>
      </div>
      ${shareTileHtml}
    </div>
  `;

  const series = wearMonthlySeries(w, 6);
  const hasAnySeriesData = series.some(s => s.days > 0);
  const monthAbbr = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const sparklineHtml = !hasAnySeriesData ? '' : `
    <div class="wear-sparkline">
      ${series.map(s => {
        const pct = Math.max(6, Math.round((s.days / 31) * 100));
        const monthName = WEAR_CALENDAR_MONTH_LABELS[s.month];
        return `
          <div class="wear-sparkline-col" title="${monthName} ${s.year}: ${s.days} day${s.days===1?'':'s'} worn">
            <div class="wear-sparkline-bar${s.days>0?' has-wear':''}" style="height:${pct}%"></div>
            <div class="wear-sparkline-label">${monthAbbr[s.month]}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Always rendered, even when there's nothing notable to report — a
  // blank space where a pattern might have shown up reads as broken, not
  // as "nothing to say" (see wearPatternInsight's own comment in data.js).
  const patternHtml = `<p class="hint" style="margin-bottom:14px;">${escapeHtml(wearPatternInsight(w))}</p>`;

  return tilesHtml + sparklineHtml + patternHtml;
}

// A wear tracker for one real month at a time, with unbounded month/year
// navigation — arrows step by one month and roll over into the next or
// previous year rather than stopping at Dec/Jan, and the two dropdowns
// jump straight to any month or year without stepping through everything
// in between. A square is filled when the day was tapped on directly or a
// reading that day was logged "Worn on wrist" (see isDayWorn in data.js);
// future days are dimmed and not tappable.
function buildWearCalendarHtml(w){
  const year = wearCalendarYear;
  const m = wearCalendarMonth;
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthHtml = buildWearMonthPageHtml(w, year, m, todayStr);
  const chevron = (d) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}" /></svg>`;

  // A generous but bounded range rather than a truly infinite picker — far
  // enough back to cover a watch's whole ownership history, far enough
  // forward that a slightly-wrong system clock doesn't clip the year you
  // actually want.
  const nowYear = new Date().getFullYear();
  const yearOptions = [];
  for(let y = nowYear - 15; y <= nowYear + 3; y++) yearOptions.push([String(y), String(y)]);
  const monthOptions = WEAR_CALENDAR_MONTH_LABELS.map((label, i) => [String(i), label]);

  return `
    <div class="section" style="margin-top:20px;padding-top:16px;">
      <h2 class="section-title">Worn calendar</h2>
      <p class="hint" style="margin-bottom:12px;">Pick any month and year, or tap a day to mark or unmark it as worn.</p>
      ${buildWearStatsHtml(w)}
      <div class="wear-calendar-controls">
        <button type="button" class="zoom-btn wear-nav-btn" data-action="wearcalnav" data-dir="-1" aria-label="Previous month">${chevron('M15 18l-6-6 6-6')}</button>
        <div class="wear-calendar-select-slot">${buildSelect('wearCalMonthSelect', monthOptions, String(m))}</div>
        <div class="wear-calendar-select-slot">${buildSelect('wearCalYearSelect', yearOptions, String(year))}</div>
        <button type="button" class="zoom-btn wear-nav-btn" data-action="wearcalnav" data-dir="1" aria-label="Next month">${chevron('M9 6l6 6-6 6')}</button>
      </div>
      <div class="wear-calendar-wrap">
        ${monthHtml}
      </div>
    </div>
  `;
}

// Wires the two direct-jump dropdowns and the prev/next arrows. Arrows roll
// over into the neighbouring year at Jan/Dec rather than stopping there —
// that rollover is the actual fix for the old "locked to one year" issue.
function attachWearCalendarHandlers(){
  // These two need to apply the instant an option is tapped, unlike every
  // other buildSelect() field in the app, which only gets read later when
  // its form's own Save button is clicked — the calendar has no save step,
  // so waiting would just mean the tap visibly did nothing.
  const monthInput = document.getElementById('wearCalMonthSelect');
  const monthWrap = monthInput && monthInput.closest('.select-wrap');
  if(monthWrap){
    monthWrap.querySelectorAll('.select-option').forEach(opt => {
      opt.addEventListener('click', () => { wearCalendarMonth = Number(opt.dataset.value); render(); });
    });
  }
  const yearInput = document.getElementById('wearCalYearSelect');
  const yearWrap = yearInput && yearInput.closest('.select-wrap');
  if(yearWrap){
    yearWrap.querySelectorAll('.select-option').forEach(opt => {
      opt.addEventListener('click', () => { wearCalendarYear = Number(opt.dataset.value); render(); });
    });
  }
  document.querySelectorAll('[data-action="wearcalnav"]').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      let m = wearCalendarMonth + Number(btn.dataset.dir);
      let y = wearCalendarYear;
      if(m < 0){ m = 11; y -= 1; }
      else if(m > 11){ m = 0; y += 1; }
      wearCalendarMonth = m;
      wearCalendarYear = y;
      render();
    };
  });
}

function buildCollectionDetailHtml(w){
  if(editingCollectionId === w.id){
    // Deliberately data-action="cancelcollection", not backtocollectionlist
    // — this used to jump straight past the detail view to the list (or
    // even the Data tab, if that's where the watch bar's own back button
    // would have gone), the same overshoot Cancel below already didn't
    // have. Reusing that exact action means this and Cancel are now one
    // button in two places rather than two subtly different ones — see
    // buildCollectionEditForm, which drops its own copy in favor of this.
    return `
      <button type="button" class="zoom-btn collection-back-btn" data-action="cancelcollection" aria-label="Cancel and go back" style="margin-bottom:14px;">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      ${buildCollectionEditForm(w)}
    `;
  }

  const bundle = buildWatchStatsBundle(w);
  // A brand-new watch has no rate to show yet — rather than a "log two
  // readings" placeholder sitting up top, the dial is left out entirely and
  // the details below simply move up to fill the gap.
  const hasStats = !!overallStats(w);

  // The accuracy dial gets two quiet companions alongside it rather than
  // sitting alone — the same average-wear and share-of-wear figures the
  // calendar section works out further down (see computeWearStats and
  // wearShareOfCollection in data.js), so the very first thing you see on
  // a watch's page is "how accurate" next to "how much you actually wear
  // it", not just the one. Both fall back to a plain — when there isn't
  // enough history yet, same as their tile counterparts below.
  const dialWearStats = computeWearStats(w);
  const avgWearForDial = dialWearStats ? String(Math.round(dialWearStats.avgPerMonth)) : '—';
  const shareForDial = wearShareOfCollection(w);
  const shareForDialLabel = shareForDial === null ? '—' : shareForDial + '%';
  const dialSectionHtml = `
    <div class="dial-wrap dial-wrap-row">
      <div class="dial-quick-col">
        ${bundle.dialHtml}
      </div>
      <div class="dial-quick-col">
        <div class="dial-figure" style="font-size:20px;">${avgWearForDial}</div>
        <div class="dial-meta">avg days/mo</div>
      </div>
      <div class="dial-quick-col">
        <div class="dial-figure" style="font-size:20px;">${shareForDialLabel}</div>
        <div class="dial-meta">share of wear</div>
      </div>
    </div>
  `;

  return `
    <div class="collection-detail-body">
      ${hasStats ? dialSectionHtml : ''}

      ${buildConditionInsightsHtml(w)}

      ${bundle.chartsHtml}

      ${buildWearCalendarHtml(w)}

      ${bundle.historySectionHtml}
    </div>
  `;
}

// The sticky bar shown under the clock while viewing one watch's detail
// page — the watch's own card (photo, name, model/reference), with a
// circular back button beside it — replacing the row of watch-name tabs
// the Data tab puts there, so the card stays pinned under the clock as the
// rest of the detail page scrolls up underneath it.
function buildCollectionWatchBarHtml(w){
  const photoHtml = w.photoUrl
    ? `<img class="collection-photo" src="${w.photoUrl}" alt="${escapeHtml(w.name)}" draggable="false" />`
    : `<div class="collection-photo collection-photo-empty">${watchPlaceholderIconSvg()}</div>`;
  const subtitle = [w.model, w.reference].filter(Boolean).join(' · ');
  return `
    <div class="tabs collection-watch-bar">
      <div class="collection-card" style="cursor:default;">
        ${photoHtml}
        <div class="collection-card-body">
          <div class="collection-card-name"><span class="card-name-text">${escapeHtml(w.name)}</span></div>
          <div class="collection-card-value">${subtitle ? escapeHtml(subtitle) : 'no model/reference set'}</div>
          ${buildPowerReserveHtml(w)}
        </div>
        <div class="collection-card-actions">
          <button type="button" class="zoom-btn collection-edit-btn" data-action="startcollectionedit" data-id="${w.id}" aria-label="Edit ${escapeHtml(w.name)}'s details" title="Edit details">
            ${editIconSvg()}
          </button>
          <button type="button" class="zoom-btn collection-wind-btn" data-action="markwound" data-id="${w.id}" aria-label="Mark ${escapeHtml(w.name)} as fully wound" title="Fully wound now">
            ${windIconSvg()}
          </button>
          <button type="button" class="zoom-btn collection-snap-btn" data-action="snapthiswatch" data-id="${w.id}" aria-label="Take a snap with ${escapeHtml(w.name)}" title="Take a snap">
            ${cameraIconSvg()}
          </button>
          <button type="button" class="zoom-btn collection-back-btn" data-action="backtocollectionlist" aria-label="Back to collection">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
        </div>
      </div>
    </div>
  `;
}

// --- Edit form field registry --------------------------------------------
// The watches table now mirrors watch_catalog's own spec columns (see the
// expand_watches.sql migration), so a manually-added watch can carry the
// same depth of data a catalog-sourced one has on its linked watch_catalog
// row. These lists are what drive the Movement and Functions sections'
// boolean checklists — grouped the same way watch_catalog's own comments
// group them (timekeeping/power + movement architecture/finishing under
// Movement; complications, plus the handful of timekeeping display
// functions like jumping hours, under Functions, matching "chronograph,
// GMT, jumping hour" as the example given for that section).
//
// The lists themselves hold the columns' own snake_case db names (reads
// naturally next to the SQL, and is what a checkbox's data-field carries),
// but every local watch object property here follows the rest of this
// codebase's own camelCase convention (purchasePrice, photoUrl, ...) — this
// converts between the two wherever a boolean's *value* is actually read
// off `w`, e.g. w[snakeToCamel('co_axial_escapement')] rather than the raw
// w['co_axial_escapement'].
function snakeToCamel(s){
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
const MOVEMENT_BOOL_FIELDS = [
  'automatic_winding', 'manual_winding', 'bidirectional_winding', 'unidirectional_winding',
  'hand_winding_capability', 'hacking_seconds', 'central_seconds', 'small_seconds', 'deadbeat_seconds',
  'swiss_lever_escapement', 'co_axial_escapement', 'constant_force_mechanism', 'remontoire', 'fusee_and_chain',
  'free_sprung_balance', 'variable_inertia_balance', 'micro_adjustment_regulation', 'multi_position_regulation',
  'breguet_overcoil', 'silicon_hairspring', 'anti_magnetic_construction', 'shock_protection', 'ceramic_bearings',
  'jewelled_bearings', 'full_balance_bridge', 'three_quarter_plate', 'twin_mainspring_barrels', 'multiple_barrels',
  'screwed_balance', 'swan_neck_regulator', 'geneva_stripes', 'perlage', 'anglage', 'black_polishing',
  'hand_engraving', 'skeletonization', 'openworked_bridges', 'gold_chatons'
];
const FUNCTIONS_BOOL_FIELDS = [
  'display_24h', 'jumping_hours', 'jumping_minutes', 'retrograde_time_display', 'regulator_display', 'wandering_hours',
  'has_date', 'day_date', 'big_date', 'triple_calendar', 'complete_calendar', 'annual_calendar', 'perpetual_calendar',
  'moonphase', 'gmt_dual_time', 'world_time', 'equation_of_time', 'chronograph', 'flyback_chronograph',
  'split_seconds_chronograph', 'chronograph_counters', 'alarm', 'minute_repeater', 'petite_sonnerie', 'grande_sonnerie',
  'tourbillon', 'double_tourbillon', 'multi_axis_tourbillon', 'carrousel', 'automaton'
];
// Only the handful where turning a snake_case column into Title Case word
// by word doesn't already read right on its own.
const BOOL_FIELD_LABEL_OVERRIDES = {
  has_date: 'Date', display_24h: '24-hour display', gmt_dual_time: 'GMT / dual time',
  world_time: 'World time', hand_winding_capability: 'Hand-winding capability',
  co_axial_escapement: 'Co-Axial escapement', swiss_lever_escapement: 'Swiss lever escapement',
  anti_magnetic_construction: 'Anti-magnetic construction', three_quarter_plate: 'Three-quarter plate',
  multi_axis_tourbillon: 'Multi-axis tourbillon'
};
function boolFieldLabel(key){
  if(BOOL_FIELD_LABEL_OVERRIDES[key]) return BOOL_FIELD_LABEL_OVERRIDES[key];
  return key.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

// Non-boolean spec fields, grouped by section — everything else on the form
// (Brand/Model/Reference/Photo/case summary/Dial in Basic info; Purchase
// details; Notes) keeps its own hand-written markup below, either because
// it predates this registry or because its layout (the photo picker, the
// price+currency row, the slow/fast accuracy steppers) doesn't fit this
// shared one. camelCase key is the local watch object's own property name;
// db is the watches/watch_catalog column both read from and save to.
const EDIT_FIELD_SECTIONS = {
  movement: [
    { key: 'movementType', db: 'movement_type', label: 'Movement', placeholder: 'e.g. automatic, manual, quartz' },
    { key: 'movement', db: 'movement', label: 'Caliber', placeholder: 'e.g. Caliber 8800' },
    { key: 'beatRateVph', db: 'beat_rate_vph', label: 'Beat rate (vph)', type: 'number', placeholder: 'e.g. 28800' }
  ],
  case: [
    { key: 'crystal', db: 'crystal', label: 'Crystal', placeholder: 'e.g. Sapphire' },
    { key: 'waterResistanceM', db: 'water_resistance_m', label: 'Water resistance (m)', type: 'number', placeholder: 'e.g. 300' }
  ],
  other: [
    { key: 'productionYears', db: 'production_years', label: 'Production years', placeholder: 'e.g. 2018–current' }
  ]
};

// Whether the "+ Add more data" toggle for a given section (buildAddMoreRow
// below) has been clicked already this edit session — reset wherever
// editingCollectionId is set (starting a fresh edit) so it doesn't carry
// over from a previous watch, but otherwise survives that section's own
// targeted refresh (refreshEditSection) so revealing the rest of a
// section's fields doesn't collapse it back the next time this same watch
// re-renders.
let collectionEditExpandedSections = new Set();

// One field's row: for a locked (catalog) watch, read-only and only shown
// at all if it actually has a value — an empty catalog field just isn't
// rendered, there's nothing to "fill in" on a watch whose spec comes from
// elsewhere. For an unlocked (manual) watch, an editable input — but only
// shown up front if it already has a value; an empty one waits behind that
// section's "+ Add more data" until expanded, per the "don't show a form
// full of empty fields for a two-minute-old watch" rule this whole
// redesign is built around.
function buildEditFieldRow(w, locked, field, expanded){
  const value = w[field.key];
  const hasValue = value !== null && value !== undefined && value !== '';
  if(locked){
    if(!hasValue) return '';
    return `
      <div class="field">
        <label>${escapeHtml(field.label)} <span class="field-locked-hint">from catalog</span></label>
        <div class="field-readonly">${escapeHtml(String(value))}</div>
      </div>`;
  }
  if(!hasValue && !expanded) return '';
  const id = 'col' + field.key.charAt(0).toUpperCase() + field.key.slice(1) + '_' + w.id;
  const type = field.type || 'text';
  return `
    <div class="field">
      <label for="${id}">${escapeHtml(field.label)}</label>
      <input type="${type}" id="${id}" ${type==='number' ? 'step="1"' : ''} value="${escapeHtml(hasValue ? String(value) : '')}" placeholder="${escapeHtml(field.placeholder || '')}" />
    </div>`;
}

// A section's whole boolean checklist. Locked (catalog): a single
// comma-joined summary line of whichever of these are true — the same
// "features" text watch_catalog_display computes server-side, just done
// here client-side so a manually-added watch (nothing on the server to
// compute it from) gets the identical treatment. Nothing shown at all if
// none are true (a locked section has no "add more" to fall back on — see
// buildEditBoolSection below for how that reads instead). Unlocked
// (manual): real checkboxes, editable — only the already-checked ones up
// front, the rest behind "+ Add more data" same as buildEditFieldRow.
function buildEditBoolChecklist(w, locked, fields, expanded){
  if(locked){
    const trueLabels = fields.filter(f => !!w[snakeToCamel(f)]).map(f => boolFieldLabel(f));
    if(!trueLabels.length) return '';
    return `<p class="edit-feature-summary">${escapeHtml(trueLabels.join(', '))}</p>`;
  }
  const shown = expanded ? fields : fields.filter(f => !!w[snakeToCamel(f)]);
  if(!shown.length) return '';
  return `
    <div class="cert-checkbox-list edit-bool-checklist">
      ${shown.map(f => `
        <label class="cert-checkbox">
          <input type="checkbox" class="colFeat_${w.id}" data-field="${escapeHtml(f)}" ${w[snakeToCamel(f)] ? 'checked' : ''} />
          <span>${escapeHtml(boolFieldLabel(f))}</span>
        </label>
      `).join('')}
    </div>`;
}

// The "+ Add more data" link itself — only for an unlocked watch (a locked
// section already shows everything the catalog has, there's nothing more
// to reveal) and only when there's actually something left hidden (every
// field already showing, or already expanded, means there's nothing more
// this could add).
function buildAddMoreRow(w, locked, sectionKey, fields, expanded){
  if(locked || expanded) return '';
  const stillHidden = fields.some(f => {
    const isBool = typeof f === 'string';
    if(isBool) return !w[snakeToCamel(f)];
    const value = w[f.key];
    if(Array.isArray(value)) return value.length === 0;
    return value === null || value === undefined || value === '';
  });
  if(!stillHidden) return '';
  return `<button type="button" class="manual-link" data-action="expandeditsection" data-section="${sectionKey}" data-id="${w.id}">+ Add more data</button>`;
}

// One full section: heading, whatever fields/checklist actually render,
// and (unlocked only) the add-more link — wrapped in an id'd container so
// refreshEditSection can rebuild just this one in place when that link is
// clicked, without touching (and losing whatever's been typed into) any
// other section still on screen. Nothing rendered at all — not even the
// heading — when a *locked* section has nothing to show: that's a real
// "the catalog has no data for this yet" state worth being visible as
// such elsewhere (see the collection-detail-body's own empty states), but
// here, on an editing form, an empty locked section is just noise.
function buildEditSection(w, locked, sectionKey, title, fieldsHtml, addMoreHtml){
  if(locked && !fieldsHtml) return '';
  return `
    <div class="edit-section" id="editSection_${sectionKey}_${w.id}">
      <div class="edit-section-title">${escapeHtml(title)}</div>
      ${fieldsHtml || (locked ? '' : '<p class="hint">Nothing added yet.</p>')}
      ${addMoreHtml}
    </div>
  `;
}

// Basic info is the one section with bespoke, always-shown fields (Photo,
// Brand — a watch always has at least a brand, per the minimum a manually-
// added one starts with) alongside the same conditionally-shown ones every
// other section uses. The case-size/material line duplicates the Case
// section further down on purpose (confirmed) — but only as a quick-glance
// readout here, never its own separate editable copy, so there's exactly
// one place (Case) that actually writes case_size_mm/case_material.
function buildEditSectionBasic(w, locked){
  const expanded = collectionEditExpandedSections.has('basic');
  const modelRefFields = [
    { key: 'model', db: 'model', label: 'Model', placeholder: 'e.g. Speedmaster, Submariner…' },
    { key: 'reference', db: 'reference', label: 'Reference number', placeholder: 'e.g. 311.30.42.30.01.005' }
  ];
  const dialField = { key: 'dialColor', db: 'dial_color', label: 'Dial', placeholder: 'e.g. Black' };
  const modelRefHtml = `<div class="row2">${modelRefFields.map(f => buildEditFieldRow(w, locked, f, expanded)).join('')}</div>`;
  const caseSummary = [
    w.caseSizeMm !== null && w.caseSizeMm !== undefined && w.caseSizeMm !== '' ? `${w.caseSizeMm}mm` : '',
    w.caseMaterial || ''
  ].filter(Boolean).join(' · ');
  const caseSummaryHtml = caseSummary ? `
    <div class="field">
      <label>Case</label>
      <div class="field-readonly">${escapeHtml(caseSummary)}</div>
    </div>` : '';
  const dialHtml = buildEditFieldRow(w, locked, dialField, expanded);
  const addMoreHtml = buildAddMoreRow(w, locked, 'basic', modelRefFields.concat([dialField]), expanded);
  const nameFieldHtml = locked ? `
    <div class="field">
      <label>Brand <span class="field-locked-hint">from catalog</span></label>
      <div class="field-readonly">${escapeHtml(w.name || '—')}</div>
    </div>` : `
    <div class="field">
      <label for="colName_${w.id}">Brand</label>
      <input type="text" id="colName_${w.id}" value="${escapeHtml(w.name || '')}" placeholder="e.g. Rolex, Omega, Seiko…" />
    </div>`;
  return `
    <div class="edit-section" id="editSection_basic_${w.id}">
      <div class="edit-section-title">Basic info</div>
      ${nameFieldHtml}
      <div class="field">
        <label for="colPhoto_${w.id}">Photo</label>
        <label class="btn-secondary" style="text-align:center;cursor:pointer;">
          ${collectionPhotoFile ? 'New photo selected' : (w.photoUrl ? 'Change photo' : 'Add photo')}
          <input type="file" id="colPhoto_${w.id}" accept="image/*" style="display:none;" />
        </label>
      </div>
      ${modelRefHtml}
      ${caseSummaryHtml}
      ${dialHtml}
      ${addMoreHtml}
    </div>
  `;
}

function buildEditSectionMovement(w, locked){
  const expanded = collectionEditExpandedSections.has('movement');
  const accuracyRange = parseAccuracySpec(w.accuracySpec);
  const hasAccuracy = !!w.accuracySpec;
  const hasReserve = w.powerReserveHours !== null && w.powerReserveHours !== undefined && w.powerReserveHours !== '';
  // Accuracy's slow/fast stepper pair and reserve's plain number input keep
  // their own hand-written markup — bespoke widgets the generic
  // buildEditFieldRow (built for a single plain input) doesn't cover —
  // but still follow the same locked/has-value/expanded rule as every
  // other field here.
  const accuracyHtml = locked ? (hasAccuracy ? `
    <div class="field">
      <label>Factory accuracy spec (s/day) <span class="field-locked-hint">from catalog</span></label>
      <div class="field-readonly">${escapeHtml(w.accuracySpec)}</div>
    </div>` : '') : (hasAccuracy || expanded ? `
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
    </div>` : '');
  const reserveHtml = locked ? (hasReserve ? `
    <div class="field">
      <label>Power reserve (hours) <span class="field-locked-hint">from catalog</span></label>
      <div class="field-readonly">${escapeHtml(String(w.powerReserveHours))}</div>
    </div>` : '') : (hasReserve || expanded ? `
    <div class="field">
      <label for="colReserve_${w.id}">Power reserve (hours)</label>
      <input type="number" id="colReserve_${w.id}" step="1" min="0" placeholder="e.g. 70" value="${w.powerReserveHours ?? ''}" />
    </div>` : '');
  const textFields = EDIT_FIELD_SECTIONS.movement;
  const textHtml = textFields.map(f => buildEditFieldRow(w, locked, f, expanded)).join('');
  const boolHtml = buildEditBoolChecklist(w, locked, MOVEMENT_BOOL_FIELDS, expanded);
  const fieldsHtml = [textHtml, reserveHtml, accuracyHtml, boolHtml].filter(Boolean).join('');
  // accuracySpec/powerReserveHours aren't in EDIT_FIELD_SECTIONS.movement
  // (their bespoke widgets are built by hand just above), so buildAddMoreRow
  // needs them named explicitly here to know there's still more to reveal.
  const hideableFields = textFields.concat(MOVEMENT_BOOL_FIELDS).concat([
    { key: 'accuracySpec' }, { key: 'powerReserveHours' }
  ]);
  const addMoreHtml = buildAddMoreRow(w, locked, 'movement', hideableFields, expanded);
  return buildEditSection(w, locked, 'movement', 'Movement', fieldsHtml, addMoreHtml);
}

function buildEditSectionFunctions(w, locked){
  const expanded = collectionEditExpandedSections.has('functions');
  const boolHtml = buildEditBoolChecklist(w, locked, FUNCTIONS_BOOL_FIELDS, expanded);
  const addMoreHtml = buildAddMoreRow(w, locked, 'functions', FUNCTIONS_BOOL_FIELDS, expanded);
  return buildEditSection(w, locked, 'functions', 'Functions', boolHtml, addMoreHtml);
}

function buildEditSectionCase(w, locked){
  const expanded = collectionEditExpandedSections.has('case');
  // Size/material are already up in Basic info (a quick-glance summary —
  // see buildCollectionEditForm) but belong here too for the full spec,
  // per your own call that the duplication is intentional.
  const sizeMaterialFields = [
    { key: 'caseSizeMm', db: 'case_size_mm', label: 'Case size (mm)', type: 'number', placeholder: 'e.g. 41' },
    { key: 'caseMaterial', db: 'case_material', label: 'Case material', placeholder: 'e.g. Steel' }
  ];
  const allFields = sizeMaterialFields.concat(EDIT_FIELD_SECTIONS.case);
  const fieldsHtml = allFields.map(f => buildEditFieldRow(w, locked, f, expanded)).join('');
  const addMoreHtml = buildAddMoreRow(w, locked, 'case', allFields, expanded);
  return buildEditSection(w, locked, 'case', 'Case', fieldsHtml, addMoreHtml);
}

function buildEditSectionOther(w, locked){
  const expanded = collectionEditExpandedSections.has('other');
  const hasCerts = !!(w.certifications && w.certifications.length);
  // Certificates keeps its own hand-written checkbox-list markup (a fixed
  // option set — COSC, METAS, etc. — not a boolean column, so it doesn't
  // fit buildEditFieldRow or buildEditBoolChecklist either), but follows
  // the same locked/has-value/expanded rule as everything else here.
  const certsHtml = locked ? (hasCerts ? `
    <div class="field">
      <label>Certificates <span class="field-locked-hint">from catalog</span></label>
      <div class="field-readonly">${escapeHtml(w.certifications.join(', '))}</div>
    </div>` : '') : (hasCerts || expanded ? `
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
    </div>` : '');
  const fields = EDIT_FIELD_SECTIONS.other;
  const fieldsHtml = fields.map(f => buildEditFieldRow(w, locked, f, expanded)).join('') + certsHtml;
  const addMoreHtml = buildAddMoreRow(w, locked, 'other', fields.concat([{ key: 'certifications' }]), expanded);
  return buildEditSection(w, locked, 'other', 'Other', fieldsHtml, addMoreHtml);
}

// Rebuilds one section in place after its "+ Add more data" is clicked —
// deliberately not a full render(): the other sections on this same form
// can easily have text sitting in their own inputs that hasn't been saved
// yet, and a full render() would wipe every one of them back to whatever
// `w` still says, the same lesson the Add Watch search box's own targeted
// refreshCatalogResults() (above) is built around. Nothing needs rewiring
// afterward — the section that was just replaced has no "+ Add more data"
// button left inside it (buildAddMoreRow drops it the moment a section is
// expanded), and every other section's own button was never touched, so
// it's still wired from attachCollectionHandlers' own delegated listener.
function refreshEditSection(watchId, sectionKey){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  collectionEditExpandedSections.add(sectionKey);
  const el = document.getElementById('editSection_' + sectionKey + '_' + watchId);
  if(!el) return;
  const locked = !!w.catalogId;
  const builders = { movement: buildEditSectionMovement, functions: buildEditSectionFunctions, case: buildEditSectionCase, other: buildEditSectionOther };
  const builder = builders[sectionKey];
  if(!builder) return;
  el.outerHTML = builder(w, locked);
}

// Purchase details and Notes are the two sections that were never
// catalog data to begin with — every watch, locked or not, always owns
// its own price/date/condition regardless of where the rest of its spec
// comes from, so these two skip the locked/has-value/expanded machinery
// entirely and just always show, same as they always have.
function buildEditSectionPurchase(w){
  return `
    <div class="edit-section">
      <div class="edit-section-title">Purchase details</div>
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
    </div>
  `;
}

function buildEditSectionNotes(w){
  return `
    <div class="edit-section">
      <div class="edit-section-title">Notes</div>
      <div class="field">
        <label for="colNotes_${w.id}">Notes / condition</label>
        <input type="text" id="colNotes_${w.id}" value="${escapeHtml(w.conditionNotes || '')}" placeholder="full set, box & papers…" />
      </div>
    </div>
  `;
}

function buildCollectionEditForm(w){
  // A catalog-sourced watch keeps its identifying details and factory specs
  // locked to whatever the catalog actually says, so an edit here can never
  // quietly drift it out of sync with the real spec — only the personal
  // fields (photo, price, date, condition) stay editable, same split the
  // catalog draws when the watch is first created (addWatchFromCatalog,
  // data.js). A manually-added watch has no catalog entry behind it, so
  // nothing here is locked; every field works exactly as it always has.
  const locked = !!w.catalogId;
  return `
    <div class="collection-card collection-card-edit">
      ${buildEditSectionBasic(w, locked)}
      ${buildEditSectionMovement(w, locked)}
      ${buildEditSectionFunctions(w, locked)}
      ${buildEditSectionCase(w, locked)}
      ${buildEditSectionOther(w, locked)}
      ${buildEditSectionPurchase(w)}
      ${buildEditSectionNotes(w)}
      ${saveStatus === 'error' ? '<p class="hint" style="color:var(--bad);">Save failed — check your connection, or the database may be missing the collection columns (see the setup SQL).</p>' : ''}
      <button type="button" class="btn-primary" data-action="savecollection" data-id="${w.id}" style="width:100%;margin-top:6px;">${saveStatus==='saving' ? 'Saving…' : 'Save'}</button>
      <button type="button" class="manual-link manual-link-inline" data-action="deletecollectionwatch" data-id="${w.id}" style="margin:14px auto 0;"><span style="color:var(--bad);">Delete</span>&nbsp;"${escapeHtml(w.name)}"</button>
    </div>
  `;
}

// Every EDIT_FIELD_SECTIONS.* entry plus the hand-built ones outside that
// registry (case size/material, dial) — matches buildEditFieldRow's own
// id scheme (col<PascalKey>_<watchId>) so saveCollectionEdit can look each
// one up the same way regardless of which section built it.
const ALL_EDIT_TEXT_FIELDS = [].concat(
  EDIT_FIELD_SECTIONS.movement, EDIT_FIELD_SECTIONS.case, EDIT_FIELD_SECTIONS.other,
  [
    { key: 'model', db: 'model' }, { key: 'reference', db: 'reference' }, { key: 'dialColor', db: 'dial_color' },
    { key: 'caseSizeMm', db: 'case_size_mm', type: 'number' }, { key: 'caseMaterial', db: 'case_material' }
  ]
);

async function saveCollectionEdit(watchId){
  const w = state.watches.find(x => x.id === watchId);
  if(!w) return;
  // Mirrors buildCollectionEditForm's own locked check exactly — a
  // catalog-backed watch never rendered the identity/spec inputs in the
  // first place, so there's nothing here to read for them either.
  const locked = !!w.catalogId;

  const priceEl = document.getElementById('colPrice_'+watchId);
  const currencyEl = document.getElementById('colCurrency_'+watchId);
  const dateEl = document.getElementById('colDate_'+watchId);
  const notesEl = document.getElementById('colNotes_'+watchId);
  // Every one of these has to be looked up before the render() below —
  // once that rebuilds the form from `w` (still holding its old values at
  // this point), it replaces these exact input elements with fresh ones
  // that have reverted back to those old values, and whatever the user had
  // actually typed into them is gone. name/model/reference/reserve/
  // accuracy/certifications used to be looked up further down, after that
  // render() — which is exactly why they never saved: this function was
  // reading its own just-reset form back, not what was on screen a moment
  // earlier.
  const nameEl = locked ? null : document.getElementById('colName_'+watchId);
  const reserveEl = locked ? null : document.getElementById('colReserve_'+watchId);
  const accuracySlowEl = locked ? null : document.getElementById('colAccuracySlow_'+watchId);
  const accuracyFastEl = locked ? null : document.getElementById('colAccuracyFast_'+watchId);
  const certifications = locked ? [] : Array.from(document.querySelectorAll('.colCert_'+watchId+':checked')).map(el => el.value);
  // Not every one of these exists in the DOM — a field that was never
  // "+ Add more data"-expanded, and had nothing in it to begin with, was
  // never rendered at all (see buildEditFieldRow). null here just means
  // "this field wasn't on screen to change" — handled below by omitting it
  // from the update entirely rather than writing null over an existing
  // value the user never had a chance to see or touch.
  const textEls = locked ? {} : Object.fromEntries(
    ALL_EDIT_TEXT_FIELDS.map(f => [f.key, document.getElementById('col' + f.key.charAt(0).toUpperCase() + f.key.slice(1) + '_' + watchId)])
  );
  // Same story for booleans, read as a whole rendered set rather than only
  // :checked — an unchecked-but-rendered box is a real "no" the user could
  // have toggled, and needs writing just as much as a checked one; a box
  // that was never rendered at all still needs to be left alone.
  const boolEls = locked ? [] : Array.from(document.querySelectorAll('.colFeat_'+watchId));

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
    purchase_currency: (currencyEl && currencyEl.value) || 'EUR',
    purchase_date: dateEl.value || null,
    condition_notes: (notesEl.value || '').trim() || null,
    photo_url: photoUrl || null
  };

  if(!locked){
    // a watch always needs a name, so an emptied field keeps the old one
    updates.name = (nameEl.value || '').trim() || w.name;

    // accuracySlowEl/accuracyFastEl, same as every textEls lookup below:
    // null means the accuracy field was never rendered (nothing in it, and
    // never expanded), so there's nothing to write — leave accuracy_spec
    // out of updates entirely rather than overwriting it with null.
    if(accuracySlowEl || accuracyFastEl){
      const slowVal = (accuracySlowEl && accuracySlowEl.value !== '') ? Number(accuracySlowEl.value) : null;
      const fastVal = (accuracyFastEl && accuracyFastEl.value !== '') ? Number(accuracyFastEl.value) : null;
      updates.accuracy_spec = (slowVal !== null || fastVal !== null)
        ? `${slowVal !== null ? (slowVal>0?'-':'')+slowVal : '—'}/${fastVal !== null ? (fastVal>0?'+':'')+fastVal : '—'} s/day`
        : null;
    }
    if(reserveEl) updates.power_reserve_hours = reserveEl.value !== '' ? Number(reserveEl.value) : null;
    // Certificates has the same "was this section ever rendered/expanded"
    // question as the other bespoke widgets, but unlike a single hidden
    // input there's no one element whose presence answers it — check for
    // any of its own checkboxes instead.
    if(document.querySelector('.colCert_'+watchId)) updates.certifications = certifications.length ? certifications.join(',') : null;

    ALL_EDIT_TEXT_FIELDS.forEach(f => {
      const el = textEls[f.key];
      if(!el) return; // never rendered — leave this column untouched
      if(f.type === 'number'){
        updates[f.db] = el.value !== '' ? Number(el.value) : null;
      } else {
        updates[f.db] = (el.value || '').trim() || null;
      }
    });
    // Same "only touch what was actually on screen" rule for booleans —
    // boolEls is every *rendered* checkbox (checked or not), so this
    // covers a deliberate uncheck as much as a fresh check; anything not
    // rendered this session is left exactly as it already was in the db.
    boolEls.forEach(el => { updates[el.dataset.field] = el.checked; });
  }

  const { error } = await sb.from('watches').update(updates).eq('id', watchId);
  if(error){
    saveStatus = 'error';
    showToast(error.message || "Couldn't save — the write was rejected.", 'error');
    render();
    return;
  }

  if(!locked){
    w.name = updates.name;
    if('accuracy_spec' in updates) w.accuracySpec = updates.accuracy_spec || '';
    if('power_reserve_hours' in updates) w.powerReserveHours = updates.power_reserve_hours;
    if('certifications' in updates) w.certifications = updates.certifications ? updates.certifications.split(',').filter(Boolean) : [];
    // model/reference/dialColor/caseSizeMm/caseMaterial and every Movement/
    // Case/Other text field all go through here too — ALL_EDIT_TEXT_FIELDS
    // covers every one of them, number fields kept as null rather than ''
    // (matching how they're read from the db everywhere else), text
    // fields falling back to '' the same way the rest of this object
    // already does (w.model, w.reference, ...).
    ALL_EDIT_TEXT_FIELDS.forEach(f => {
      if(!(f.db in updates)) return;
      w[f.key] = f.type === 'number' ? updates[f.db] : (updates[f.db] || '');
    });
    boolEls.forEach(el => { w[snakeToCamel(el.dataset.field)] = el.checked; });
  }
  w.purchasePrice = updates.purchase_price;
  w.purchaseCurrency = updates.purchase_currency;
  w.purchaseDate = updates.purchase_date;
  w.conditionNotes = updates.condition_notes || '';
  w.photoUrl = updates.photo_url || '';

  editingCollectionId = null;
  collectionPhotoFile = null;
  saveState();
  // The edit form can be scrolled well down by the time Save is tapped
  // (certificates and notes sit near its bottom) — saveState()'s render()
  // above swaps back to the plain detail view in place, at that same
  // scroll offset, landing it partway down a page that now starts with the
  // watch bar and dial again instead. startcollectionedit and
  // cancelcollection (attachCollectionHandlers, below) already scroll back
  // to the top the same way on their own way into/out of this form — Save
  // was the one way out of it that didn't. Only added here, not to
  // anything shared, so it can't touch the mini-chart-preview's own
  // scroll-to-the-charts behavior (viewcollectionchart, same file).
  scrollToPageTop(300);
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
  // where it actually was, with no need to fake a starting value. Found via
  // the wind button rather than a swipe-row wrapper, since the same card
  // markup now also appears unwrapped in the Data tab's watch list.
  const findCard = () => {
    const btn = document.querySelector(`[data-action="markwound"][data-id="${watchId}"]`);
    return btn ? btn.closest('.collection-card') : null;
  };
  const card = findCard();
  if(card && card.querySelector('.reserve-fill')){
    updatePowerReserveBars();
    playWoundFlash(card);
  } else {
    // First wind on this watch: there's no bar in the DOM yet to update.
    render();
    playWoundFlash(findCard());
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
      // A swipe, or a reorder long-press (even one that never actually
      // moved anywhere), both end in a click same as an ordinary tap does
      // — ignore that one. Treat a tap on an already-open card as "put it
      // back" rather than "open me".
      if(Date.now() - swipeEndedAt < 300 || Date.now() - reorderEndedAt < 300) return;
      const row = el.closest('.swipe-row');
      if(row && row.classList.contains('open')){ closeSwipeRows(null); return; }
      viewingCollectionId = el.dataset.id; editingCollectionId = null; collectionPhotoFile = null;
      collectionDetailJustOpened = true;
      collectionDetailReturnTab = 'collection';
      wearCalendarYear = new Date().getFullYear();
      wearCalendarMonth = new Date().getMonth();
      render();
      // Opening a watch straight off a scrolled-down list otherwise leaves
      // the detail page landed wherever the list happened to be scrolled
      // to, rather than at its own top — scrollToPageTop (app.js) is the
      // same eased scroll-to-top already written for exactly this.
      scrollToPageTop(300);
    };
  });
  // The mini chart preview (buildCardCharts, charts.js) sits inside the
  // same card as the handler just above, which would otherwise still catch
  // this click once it bubbles and send it down the plain "open the watch,
  // scroll to top" path instead — stopPropagation keeps this its own
  // gesture. Opens the same detail view, but lands scrolled to the full
  // charts there rather than at the top of the page, since that chart is
  // presumably what was actually tapped for.
  document.querySelectorAll('[data-action="viewcollectionchart"]').forEach(el => {
    el.onclick = (e) => {
      e.stopPropagation();
      if(Date.now() - swipeEndedAt < 300 || Date.now() - reorderEndedAt < 300) return;
      const row = el.closest('.swipe-row');
      if(row && row.classList.contains('open')){ closeSwipeRows(null); return; }
      viewingCollectionId = el.dataset.id; editingCollectionId = null; collectionPhotoFile = null;
      collectionDetailJustOpened = true;
      collectionDetailReturnTab = 'collection';
      wearCalendarYear = new Date().getFullYear();
      wearCalendarMonth = new Date().getMonth();
      render();
      // scrollPanelIntoView (app.js) is the same "land this exactly where
      // it reads best against the sticky header/dock" scroll the Snap tab's
      // own snap-to-card behavior uses. Pinned flush to the header
      // (pinTop:true) rather than merely "somewhere on screen" — a tall
      // desktop viewport can easily already have the chart in view with no
      // scrolling at all, which reads as the tap having done nothing; this
      // way tapping the chart always visibly jumps to it, on any screen.
      const chartEl = document.querySelector('.collection-detail-body .chart-box');
      if(chartEl && typeof scrollPanelIntoView === 'function') scrollPanelIntoView(chartEl, true);
    };
  });
  wireCollectionSwipe();
  wireCollectionReorder();
  const backBtn = document.querySelector('[data-action="backtocollectionlist"]');
  if(backBtn) backBtn.onclick = () => {
    viewingCollectionId = null; editingCollectionId = null; collectionPhotoFile = null;
    if(collectionDetailReturnTab === 'data'){
      activeTab = 'data';
      collectionDetailReturnTab = 'collection';
      syncBottomTabs();
    }
    render();
    // The detail page can be scrolled well down — most obviously after
    // following the mini-chart preview straight to its charts
    // (viewcollectionchart) — and render() swaps back to the list in
    // place, at that same offset. Same fix as every other exit from the
    // detail page (startcollectionedit, cancelcollection, saveCollectionEdit
    // all already do this on their own way in/out); this was the one that
    // didn't.
    scrollToPageTop(300);
  };
  const snapBtn = document.querySelector('[data-action="snapthiswatch"]');
  if(snapBtn) snapBtn.onclick = () => {
    // Same resets the Snap tab's own card-tap handler applies when the
    // active watch changes (see the "select" handler, app.js) — otherwise
    // a chart dot left selected on a *different* watch's detail page would
    // still show selected the next time this one's is opened.
    state.activeId = snapBtn.dataset.id;
    selectedOffsetIdx = null; selectedDriftIdx = null; offsetScrollLeft = null; driftScrollLeft = null; editingReadingId = null;
    viewingCollectionId = null; editingCollectionId = null; collectionPhotoFile = null;
    activeTab = 'data';
    syncBottomTabs();
    render();
  };
  const startEditBtn = document.querySelector('[data-action="startcollectionedit"]');
  if(startEditBtn) startEditBtn.onclick = () => {
    editingCollectionId = startEditBtn.dataset.id; collectionPhotoFile = null; saveStatus = '';
    // A fresh edit session starts with every section collapsed to just its
    // already-filled fields, regardless of what an earlier edit (this watch
    // or another one) left expanded.
    collectionEditExpandedSections = new Set();
    render();
    // Same fix as opening a watch from a scrolled-down list, and cancelling
    // back out of this same form (see viewcollection and cancelcollection
    // below) — entering edit from partway down the detail page otherwise
    // left the edit form landed wherever that scroll position happened to
    // be, rather than at its own top.
    scrollToPageTop(300);
  };
  document.querySelectorAll('[data-action="expandeditsection"]').forEach(btn => {
    btn.onclick = () => refreshEditSection(btn.dataset.id, btn.dataset.section);
  });
  const cancelBtn = document.querySelector('[data-action="cancelcollection"]');
  if(cancelBtn) cancelBtn.onclick = () => {
    editingCollectionId = null; collectionPhotoFile = null; render();
    // Same fix as opening a watch from a scrolled-down list (see
    // viewcollection above) — cancelling out of the edit form drops back
    // to the detail page, which should land at its own top too, not
    // wherever the edit form happened to be scrolled to.
    scrollToPageTop(300);
  };
  const saveBtn = document.querySelector('[data-action="savecollection"]');
  if(saveBtn) saveBtn.onclick = () => saveCollectionEdit(saveBtn.dataset.id);
  // The Collection list's own card dropped its wind button in favor of the
  // same plain forward chevron the Data tab's card uses (see
  // buildCollectionCard above) — this only ever needs to catch the one on
  // the detail page's watch bar (buildCollectionWatchBarHtml). The Data
  // tab's own copy is wired separately, in app.js's attachHandlers, since
  // that view never runs this function.
  document.querySelectorAll('[data-action="markwound"]').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); markFullyWound(btn.dataset.id); };
  });
  document.querySelectorAll('[data-action="togglewearday"]').forEach(btn => {
    if(btn.disabled) return;
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleWearDay(btn.dataset.id, btn.dataset.date);
    };
  });
  attachWearCalendarHandlers();
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
    addWatchMode = 'search';
    watchSearchQuery = '';
    watchSearchCaseMaterials = [];
    watchSearchCaseDiameters = [];
    watchSearchMovementTypes = [];
    watchSearchDials = [];
    // Called before render(), not after: ensureCatalogLoaded() sets its
    // "loading" flag synchronously (an async function body runs up to its
    // first await immediately, not on a later tick), so the render() right
    // below already paints the correct "Loading catalog…" state on the
    // very first open instead of a wrong "catalog unavailable" flash that
    // only corrects itself once the fetch finishes. A no-op, loading
    // nothing, if the catalog is already cached from earlier this session.
    ensureCatalogLoaded().then(() => {
      if(addingCollectionWatch && addWatchMode === 'search'){
        refreshCatalogFilters();
        refreshCatalogResults();
      }
    });
    render();
    resetAddWatchScroll();
  };
  const cancelAddBtn = document.querySelector('[data-action="canceladdcollectionwatch"]');
  if(cancelAddBtn) cancelAddBtn.onclick = () => { addingCollectionWatch = false; render(); };

  // Whichever field the switch happens from, ending on its counterpart
  // focused in the other mode — or on neither field focused, if neither
  // was to begin with — is what stops the bottom bar and clock (see
  // updateKeyboardHideState in app.js, which reacts to focus) from
  // flashing back on and off across a mode switch and shoving the page
  // around.
  //
  // Two rounds of this still weren't enough: checking document.activeElement
  // inside the button's click handler always read as unfocused, even when
  // the field visibly had the cursor a moment before the tap. On a touch
  // device, tapping a button that isn't the focused field blurs that field
  // as part of the tap gesture itself — on touchend/pointerup, well before
  // the click handler that follows ever runs — so by the time this code
  // checked, the browser had already blurred it natively. The fix has to
  // read (and act on) focus earlier than that: on pointerdown, the very
  // first event in the gesture, before any native blur has happened yet.
  // Hopping onto #focusRelay (a real, invisible text input living outside
  // #root, so no render() ever removes it — see index.html) right there
  // pre-empts that native blur entirely — the transfer is a direct
  // field-to-relay one, not a field-to-nothing one, which is what actually
  // keeps the keyboard open through the tap. The click handler then just
  // reads the flag this set and, after render() rebuilds the card, hops
  // from the relay onto whichever field belongs to the new mode.
  function wireAddWatchModeSwitch(btn, onPointerDown){
    if(!btn) return;
    btn.addEventListener('pointerdown', onPointerDown);
    // Separate from the pointerdown capture above on purpose: without
    // this, the browser's own default mousedown behavior focuses this
    // button a moment later (mousedown always follows pointerdown) —
    // after the relay hop above, undoing it — and since a plain button
    // isn't a text field, that transient focus read as "keyboard just
    // closed" to updateKeyboardHideState (app.js), un-hiding the
    // reference clock and shoving the card up between mousedown and
    // mouseup. Desktop and Android both require mousedown and mouseup to
    // land on the same element for click to fire at all, so that shift
    // silently killed the click there — iOS's touch-to-click synthesis
    // happened to be forgiving of it, which is the only reason this ever
    // looked fixed on that one platform. preventDefault specifically on
    // mousedown (never on pointerdown/touchstart) is the standard way to
    // stop an element from taking focus on click without also cancelling
    // the click itself — touchstart's preventDefault would suppress the
    // touch-synthesized click entirely, which mousedown's does not.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
  }
  function captureAddWatchFocusForSwitch(){
    addWatchSwitchHadFocus = typeof isKeyboardTextInput === 'function' && isKeyboardTextInput(document.activeElement);
    if(addWatchSwitchHadFocus){
      const relay = document.getElementById('focusRelay');
      if(relay) relay.focus();
    }
  }
  const switchToManualBtn = document.querySelector('[data-action="switchtomanualadd"]');
  wireAddWatchModeSwitch(switchToManualBtn, captureAddWatchFocusForSwitch);
  if(switchToManualBtn) switchToManualBtn.onclick = () => {
    const hadFocus = addWatchSwitchHadFocus;
    addWatchMode = 'manual';
    render();
    resetAddWatchScroll();
    if(hadFocus){
      const field = document.getElementById('newCollectionWatchName');
      if(field) field.focus();
    }
  };
  const switchToSearchBtn = document.querySelector('[data-action="switchtocatalogsearch"]');
  wireAddWatchModeSwitch(switchToSearchBtn, captureAddWatchFocusForSwitch);
  if(switchToSearchBtn) switchToSearchBtn.onclick = () => {
    const hadFocus = addWatchSwitchHadFocus;
    addWatchMode = 'search';
    render();
    resetAddWatchScroll();
    if(hadFocus){
      const field = document.getElementById('watchCatalogSearch');
      if(field) field.focus();
    }
  };

  const addBtn = document.querySelector('[data-action="addcollectionwatch"]');
  if(addBtn) addBtn.onclick = () => {
    const inp = document.getElementById('newCollectionWatchName');
    if(inp) addCollectionWatch(inp.value);
  };
  const nameInput = document.getElementById('newCollectionWatchName');
  if(nameInput) nameInput.addEventListener('keydown', (e) => {
    if(e.key === 'Enter'){ e.preventDefault(); addCollectionWatch(nameInput.value); }
  });

  // Deliberately 'input', not 'keydown' — this also has to catch a pasted
  // reference number or an autofill, neither of which fires a keydown.
  const catalogSearchInput = document.getElementById('watchCatalogSearch');
  if(catalogSearchInput){
    catalogSearchInput.addEventListener('input', () => {
      watchSearchQuery = catalogSearchInput.value;
      refreshCatalogResults();
    });
    catalogSearchInput.addEventListener('keydown', (e) => {
      if(e.key !== 'Enter') return;
      e.preventDefault();
      if(!watchSearchQuery.trim()) return;
      const first = filteredWatchCatalog()[0];
      if(first) selectCatalogWatch(first.id);
    });
  }
  wireCatalogFilterHandlers();
  wireCatalogResultButtons();
}

// Only fires because app.js's multi-select/select-option handlers dispatch
// 'change' on the hidden input when a value is picked (see app.js) — a real
// <select> does this on its own, these custom ones didn't used to need to.
// Pulled out on its own (rather than left inline in attachCollectionHandlers
// above) so refreshCatalogFilters() below can rewire the exact same
// listeners after it rebuilds #watchCatalogFilters from scratch, instead of
// a second, easily-drifting copy of this.
function wireCatalogFilterHandlers(){
  // The Case combo (buildCaseFilterHtml) doesn't dispatch a plain 'change'
  // on one hidden input the way the others do — see the comment there for
  // why casefiltertoggle needs its own handling instead of app.js's shared
  // multiselecttoggle one. Delegated on the menu itself (survives this
  // function re-running after every refreshCatalogFilters() rebuild,
  // without needing to re-find and re-bind each individual checkbox).
  const caseFilterMenu = document.querySelector('.case-filter-menu');
  if(caseFilterMenu) caseFilterMenu.addEventListener('change', (e) => {
    if(!e.target.closest('[data-action="casefiltertoggle"]')) return;
    watchSearchCaseMaterials = Array.from(caseFilterMenu.querySelectorAll('[data-group="material"]:checked')).map(el => el.value);
    watchSearchCaseDiameters = Array.from(caseFilterMenu.querySelectorAll('[data-group="diameter"]:checked')).map(el => el.value);
    const materialHidden = document.getElementById('catalogFilterCaseMaterial');
    if(materialHidden) materialHidden.value = watchSearchCaseMaterials.join(',');
    const diameterHidden = document.getElementById('catalogFilterCaseDiameter');
    if(diameterHidden) diameterHidden.value = watchSearchCaseDiameters.join(',');
    // Not .closest('.case-filter-wrap') — opening the menu escapes it to
    // <body> (the toggleselect handler, app.js, for any filter menu wide
    // enough to need the whole row), which detaches it from the wrap
    // entirely. findSelectWrap looks the wrap up by the hidden input's id
    // instead, unaffected by where the menu itself currently lives — the
    // exact fix already used for the same "escaped menu" issue in app.js's
    // own multiselecttoggle handler.
    const wrap = findSelectWrap(caseFilterMenu);
    const total = watchSearchCaseMaterials.length + watchSearchCaseDiameters.length;
    const valueEl = wrap && wrap.querySelector('.select-value');
    if(valueEl) valueEl.textContent = 'Case' + (total ? ` (${total})` : '');
    const toggleBtn = wrap && wrap.querySelector('[data-action="toggleselect"]');
    if(toggleBtn) toggleBtn.classList.toggle('placeholder', total === 0);
    refreshCatalogResults();
  });
  const movementTypeFilter = document.getElementById('catalogFilterMovementType');
  if(movementTypeFilter) movementTypeFilter.addEventListener('change', () => {
    watchSearchMovementTypes = movementTypeFilter.value ? movementTypeFilter.value.split(',') : [];
    refreshCatalogResults();
  });
  const dialFilter = document.getElementById('catalogFilterDial');
  if(dialFilter) dialFilter.addEventListener('change', () => {
    watchSearchDials = dialFilter.value ? dialFilter.value.split(',') : [];
    refreshCatalogResults();
  });
}

// Used to also auto-focus the field (the name says as much) so the
// keyboard was ready the instant the form opened — but on iOS that
// programmatic focus reliably left the field looking focused (cursor,
// highlight) with the keyboard never actually appearing, no matter how
// the focus() call was timed or invoked, and no fix found for that in a
// few rounds of trying was worth chasing further. Dropping the
// auto-focus entirely sidesteps it: the field just sits there unfocused
// until the user taps it themselves, which is an ordinary direct tap on
// a text input and opens the keyboard the normal way. What's left here is
// only the part that still matters without it — putting the page back at
// the top, since the freshly-opened form landing mid-scroll (behind the
// clock) was its own separate bug.
function resetAddWatchScroll(){
  window.scrollTo(0, 0);
  requestAnimationFrame(() => window.scrollTo(0, 0));
}

// Rebuilds only the results list, never the whole card — see the "Add
// watch" search input's own comment above for why that distinction is the
// whole point. Called after every keystroke and every filter change.
function refreshCatalogResults(){
  const results = document.getElementById('watchCatalogResults');
  if(!results) return;
  results.innerHTML = buildCatalogResultsHtml();
  wireCatalogResultButtons();
}

function refreshCatalogFilters(){
  const filters = document.getElementById('watchCatalogFilters');
  if(!filters) return;
  filters.innerHTML = buildCatalogFiltersHtml();
  wireCatalogFilterHandlers();
}

function wireCatalogResultButtons(){
  document.querySelectorAll('[data-action="selectcatalogwatch"]').forEach(btn => {
    btn.onclick = () => selectCatalogWatch(btn.dataset.id);
    // Stops this button from taking focus on click — without this, focus
    // moving off the search input onto this (non-text) button fires
    // 'focusin', which updateKeyboardHideState (app.js) reads as "the
    // keyboard just closed" and reacts to by un-hiding the bottom tab
    // bar, growing the page and shifting this whole results list out
    // from under the cursor between mousedown and mouseup. A desktop
    // mouse requires both to land on the same element for click to fire
    // at all, so on a mouse that shift silently killed the very click
    // that was supposed to select this result — the first tap looked
    // like it did nothing, and only a second one (now that the layout
    // had already settled) actually landed on anything. Touch's own
    // click synthesis is forgiving of exactly this, which is why it
    // never showed up on mobile. Same fix already used for the
    // manual/catalog switch buttons (wireAddWatchModeSwitch) for the
    // identical reason.
    btn.onmousedown = (e) => e.preventDefault();
  });
}

async function selectCatalogWatch(entryId){
  const entry = (watchCatalog || []).find(e => String(e.id) === String(entryId));
  if(!entry) return;
  addingCollectionWatch = false;
  await addWatchFromCatalog(entry);
  viewingCollectionId = state.activeId;
  editingCollectionId = state.activeId;
  render();
}
