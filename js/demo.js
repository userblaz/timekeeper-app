// TEMPORARY testing helper — adds a fully populated demo watch.
//
// To remove it completely, three deletions:
//   1. this file
//   2. its <script> tag in index.html
//   3. the one line in js/collection.js calling buildDemoWatchButtonHtml()
//
// Everything here is self-contained: the button markup, its styling (inline,
// so nothing to clean out of styles.css) and its own delegated click handler.
// The call site in collection.js is guarded with a typeof check, so deleting
// just this file makes the button disappear rather than break the page.

const DEMO_WATCH = {
  name: 'Submariner Date',
  model: 'Rolex Submariner Date',
  reference: '126610LN',
  purchase_price: 10500,
  purchase_date: '2023-06-15',
  condition_notes: 'Full set — box & papers',
  accuracy_spec: '-2/+2 s/day',
  certifications: 'COSC,Rolex Superlative Chronometer'
};

// Cumulative offset over the last 30 days. Positions are deliberately
// correlated with rate (crown up runs faster than dial up) so the Collection
// tab's condition insights have a real pattern to report.
const DEMO_READINGS = [
  { daysAgo: 30, offset: 0,  position: 'DU', wear: 'rest',   time: 'overnight', note: 'set against atomic clock' },
  { daysAgo: 27, offset: 3,  position: 'DU', wear: 'rest',   time: 'overnight', note: '' },
  { daysAgo: 24, offset: 11, position: 'CU', wear: 'worn',   time: 'day',       note: 'worn all week' },
  { daysAgo: 21, offset: 14, position: 'DU', wear: 'rest',   time: 'overnight', note: '' },
  { daysAgo: 18, offset: 21, position: 'CU', wear: 'worn',   time: 'day',       note: '' },
  { daysAgo: 15, offset: 24, position: 'DU', wear: 'rest',   time: 'overnight', note: '' },
  { daysAgo: 12, offset: 32, position: 'CU', wear: 'worn',   time: 'day',       note: '' },
  { daysAgo: 9,  offset: 36, position: 'DD', wear: 'rest',   time: 'mixed',     note: '' },
  { daysAgo: 6,  offset: 43, position: 'CD', wear: 'worn',   time: 'day',       note: 'travel week' },
  { daysAgo: 4,  offset: 45, position: 'DU', wear: 'rest',   time: 'overnight', note: '' },
  { daysAgo: 2,  offset: 50, position: 'CU', wear: 'worn',   time: 'day',       note: '' },
  { daysAgo: 0,  offset: 53, position: 'DD', wear: 'winder', time: 'mixed',     note: '' }
];

function buildDemoWatchButtonHtml(){
  return `
    <button type="button" data-action="adddemowatch" style="
      font-family:'Inter',sans-serif;font-size:12.5px;font-weight:500;
      color:var(--grey);background:transparent;
      border:1px dashed var(--line);border-radius:14px;
      padding:11px;width:100%;">+ Demo watch (Submariner 126610LN)</button>
  `;
}

function demoDateString(daysAgo){
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

async function addDemoWatch(){
  saveStatus = 'saving'; render();

  const { data: watchRow, error: watchErr } = await sb.from('watches')
    .insert({ user_id: currentUser.id, ...DEMO_WATCH })
    .select().single();
  if(watchErr){
    saveStatus = 'error'; render();
    alert(`Couldn't add the demo watch:\n\n${watchErr.message}\n\nIf this mentions a missing column, the Supabase migrations haven't been run yet.`);
    return;
  }

  const { error: readingsErr } = await sb.from('readings').insert(
    DEMO_READINGS.map(r => ({
      watch_id: watchRow.id,
      date: demoDateString(r.daysAgo),
      offset_seconds: r.offset,
      note: r.note || null,
      position: r.position,
      wear_state: r.wear,
      time_of_day: r.time
    }))
  );
  if(readingsErr){
    saveStatus = 'error'; render();
    alert(`The demo watch was added, but its readings failed:\n\n${readingsErr.message}\n\nIf this mentions a missing column, the reading-conditions migration hasn't been run yet.`);
    return;
  }

  await loadState();
  state.activeId = watchRow.id;
  viewingCollectionId = watchRow.id;
  saveStatus = 'saved';
  render();
}

document.addEventListener('click', (e) => {
  if(e.target.closest('[data-action="adddemowatch"]')) addDemoWatch();
});
