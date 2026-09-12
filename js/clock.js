// Clock tab: analog/digital reference clock, tick sound, time-server sync,
// and the scroll-collapse header animation.

function buildAnalogClockFace(){
  const cx = 200, cy = 200, R = 180;
  let ticks = '';
  for(let i=0;i<60;i++){
    const angle = i * 6;
    const isHour = i % 5 === 0;
    const outer = R - 8;
    const inner = isHour ? outer - 18 : outer - 8;
    const rad = (angle - 90) * Math.PI / 180;
    const x1 = cx + outer*Math.cos(rad), y1 = cy + outer*Math.sin(rad);
    const x2 = cx + inner*Math.cos(rad), y2 = cy + inner*Math.sin(rad);
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#18181B" stroke-width="${isHour?3:1}" stroke-opacity="${isHour?1:0.35}" />`;
  }
  let numerals = '';
  for(let n=1;n<=12;n++){
    const angle = n * 30;
    const rad = (angle - 90) * Math.PI / 180;
    const nr = R - 8 - 40;
    const x = cx + nr*Math.cos(rad), y = cy + nr*Math.sin(rad);
    numerals += `<text x="${x.toFixed(1)}" y="${(y+7).toFixed(1)}" text-anchor="middle" font-size="22" font-family="'Inter',sans-serif" font-weight="600" fill="#18181B">${n}</text>`;
  }
  return `
    <svg viewBox="0 0 400 400" width="400" height="400" class="analog-clock">
      <circle cx="${cx}" cy="${cy}" r="${R}" fill="#FFFFFF" stroke="#E0E0DE" stroke-width="2" />
      ${ticks}
      ${numerals}
      <line id="analogHourHand" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy-90}" stroke="#18181B" stroke-width="8" stroke-linecap="round" />
      <line id="analogMinuteHand" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy-130}" stroke="#18181B" stroke-width="5" stroke-linecap="round" />
      <line id="analogSecondHand" x1="${cx}" y1="${cy+20}" x2="${cx}" y2="${cy-150}" stroke="#B4432F" stroke-width="2" stroke-linecap="round" />
      <circle cx="${cx}" cy="${cy}" r="7" fill="#18181B" />
      <circle cx="${cx}" cy="${cy}" r="3" fill="#B4432F" />
    </svg>
  `;
}


const CLOCK_TICK_BPH = 28000; // beats per hour the analog second hand steps at


function updateAnalogClock(){
  const hourEl = document.getElementById('analogHourHand');
  if(!hourEl) return;
  const minuteEl = document.getElementById('analogMinuteHand');
  const secondEl = document.getElementById('analogSecondHand');
  const now = trueNow();
  const h = now.getHours() % 12, m = now.getMinutes(), s = now.getSeconds(), ms = now.getMilliseconds();

  const tickIntervalSec = 3600 / CLOCK_TICK_BPH;
  const rawSec = s + ms/1000;
  const steppedSec = Math.floor(rawSec / tickIntervalSec) * tickIntervalSec;

  const secAngle = steppedSec / 60 * 360;
  const minAngle = (m + s/60) / 60 * 360;
  const hourAngle = (h + m/60) / 12 * 360;
  hourEl.setAttribute('transform', `rotate(${hourAngle.toFixed(2)} 200 200)`);
  if(minuteEl) minuteEl.setAttribute('transform', `rotate(${minAngle.toFixed(2)} 200 200)`);
  if(secondEl) secondEl.setAttribute('transform', `rotate(${secAngle.toFixed(2)} 200 200)`);
}


function buildClockTabHtml(){
  return `
    <div class="section" style="margin-top:0;padding-top:0;border-top:none;">
      <h2 class="section-title">Set your watch</h2>
      <p class="hint" style="text-align:center;margin-bottom:10px;">Match your watch's hands to this dial — synced to true time.</p>
      <div class="analog-clock-wrap">
        ${buildAnalogClockFace()}
      </div>
    </div>
  `;
}


let timeOffsetMs = 0;
let timeSyncStatus = 'pending'; // 'pending' | 'synced' | 'failed'

function trueNow(){
  return new Date(Date.now() + timeOffsetMs);
}

async function syncTrueTime(){
  const labelEl = document.getElementById('masterClockLabel');
  if(labelEl) labelEl.textContent = 'reference time · syncing…';
  try{
    const t0 = Date.now();
    const res = await fetch('https://timeapi.io/api/Time/current/zone?timeZone=Etc/UTC', { cache: 'no-store' });
    const t1 = Date.now();
    if(!res.ok) throw new Error('bad response');
    const data = await res.json();
    // Build the timestamp from individual UTC fields rather than parsing
    // the dateTime string directly — timeapi.io's dateTime has no 'Z' or
    // offset suffix, so Date.parse() would misinterpret it as local time.
    const serverMs = Date.UTC(
      data.year, data.month - 1, data.day,
      data.hour, data.minute, data.seconds, data.milliSeconds || 0
    );
    if(isNaN(serverMs)) throw new Error('bad datetime');
    const roundTrip = t1 - t0;
    const estimatedServerAtT1 = serverMs + roundTrip/2;
    timeOffsetMs = estimatedServerAtT1 - t1;
    timeSyncStatus = 'synced';
  }catch(e){
    timeOffsetMs = 0;
    timeSyncStatus = 'failed';
  }
  if(labelEl){
    labelEl.textContent = timeSyncStatus === 'synced'
      ? 'reference time · synced to atomic clock'
      : 'reference time · this phone (sync failed, tap to retry)';
  }
}

let clockTickEnabled = false;
let clockAudioCtx = null;
let clockTickTimeout = null;
let tickTockToggle = true;

function playTickSound(){
  if(!clockAudioCtx) clockAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = clockAudioCtx;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = tickTockToggle ? 1800 : 1400;
  tickTockToggle = !tickTockToggle;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.22, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.05);
}

// A camera shutter for the capture tap: two short band-passed noise bursts
// 55ms apart — mirror, then shutter — which is what makes a click read as a
// camera rather than a generic beep. Synthesised rather than loaded, so
// there's no asset to fetch and nothing to preload. Deliberately quiet; it
// sits under the flash rather than announcing itself.
function playShutterSound(){
  if(!clockAudioCtx) clockAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = clockAudioCtx;
  // Safe to call: the tap that triggers this is itself the user gesture iOS
  // requires before a page is allowed to make any sound at all.
  if(ctx.state === 'suspended') ctx.resume();

  const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.08), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for(let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const click = (at, level, freq) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = 1.2;
    const gain = ctx.createGain();
    // Exponential ramps, not linear: a linear decay on a click reads as a
    // soft thud, and exponentialRampToValueAtTime can never touch zero, hence
    // the 0.0001 floor at both ends.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    src.connect(band);
    band.connect(gain);
    gain.connect(ctx.destination);
    src.start(at);
    src.stop(at + 0.08);
  };

  const t = ctx.currentTime + 0.01;
  click(t, 0.07, 3000);            // mirror up: brighter, the louder of the two
  click(t + 0.055, 0.05, 2200);    // shutter closing: softer and lower
}

function scheduleNextTick(){
  if(!clockTickEnabled) return;
  const now = trueNow();
  const msToNextSecond = 1000 - now.getMilliseconds();
  clockTickTimeout = setTimeout(() => {
    playTickSound();
    scheduleNextTick();
  }, msToNextSecond);
}

const clockBoxEl = document.getElementById('masterClockBox');
if(clockBoxEl){
  clockBoxEl.onclick = () => {
    clockTickEnabled = !clockTickEnabled;
    clockBoxEl.classList.toggle('ticking', clockTickEnabled);
    if(clockTickEnabled){
      if(!clockAudioCtx) clockAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if(clockAudioCtx.state === 'suspended') clockAudioCtx.resume();
      scheduleNextTick();
    } else if(clockTickTimeout){
      clearTimeout(clockTickTimeout);
      clockTickTimeout = null;
    }
  };
  clockBoxEl.ondblclick = (e) => {
    e.preventDefault();
    syncTrueTime();
  };
}

const masterClockLabelEl = document.getElementById('masterClockLabel');
if(masterClockLabelEl){
  masterClockLabelEl.onclick = (e) => {
    e.stopPropagation();
    syncTrueTime();
  };
}

setInterval(() => {
  const el = document.getElementById('masterClock');
  if(el){
    const n = trueNow();
    const str = pad2(n.getHours()) + ':' + pad2(n.getMinutes()) + ':' + pad2(n.getSeconds());
    // Each digit sits in its own fixed-width box instead of using the font's
    // own tabular-nums figures — those carry a different "1" glyph (a flat
    // base serif) than the rest of the app uses. This keeps the same width
    // stability tabular-nums gives (the "1" is naturally narrower than every
    // other digit, so ticking through one would otherwise nudge the whole
    // string sideways) while keeping the plain "1" everywhere else uses.
    el.innerHTML = str.split('').map(ch => /\d/.test(ch) ? `<span class="clock-digit">${ch}</span>` : ch).join('');
  }
  updateAnalogClock();
}, 60);

function updateClockCollapse(){
  // kept as a no-op shim so existing render() calls to it don't error;
  // also used to keep the header-height spacer correct immediately after
  // a re-render (e.g. switching watches, or switching to a tab that
  // hides/shows the watch-tabs row), rather than waiting for the next
  // scroll-driven animation frame.
  if(typeof syncHeaderSpacer === 'function') syncHeaderSpacer();
}

const clockSentinelEl = document.getElementById('clockSentinel');
const masterClockBoxEl = document.getElementById('masterClockBox');
const CLOCK_COLLAPSE_RANGE = 70; // px of scroll over which it fully collapses
// Toggle for the scroll-shrink effect specifically — set to true to bring
// it back. Doesn't affect clockForceCollapsed below, which is a separate,
// functional behavior (holding the header collapsed while the capture
// panel is open) rather than a decorative scroll animation.
const CLOCK_SCROLL_COLLAPSE_ENABLED = true;

// Discrete toggle at a single threshold, checked once per animation frame
// but only WRITING to the DOM when the state actually changes — so the
// (unavoidable, one-time) layout recalculation happens once per crossing,
// not continuously. The label's opacity fade is the only continuously-
// animated part, and that's compositor-only so it stays smooth.
// (Note: the watch-tabs bar no longer needs its own position tracking —
// it's now a normal flow child of the same #stickyHeader wrapper as the
// clock, so there's no seam between them for content to show through.)
let clockLastT = -1; // -1 forces the first frame to always write

// Holds the header collapsed regardless of scroll position. Used while the
// capture panel is open: that panel has to sit entirely below the header,
// and scrolling far enough to collapse the clock the normal way would drag
// the panel's own top up underneath it. Nothing is lost — the big reference
// clock has already done its job by the time the reading is captured.
//
// Toggle for this specific behavior — set to true to bring it back. app.js
// still calls setClockCollapsed() on every capture as before; this just
// makes the call a no-op while off, so nothing else needs to change.
const CLOCK_FORCE_COLLAPSE_ENABLED = false;
let clockForceCollapsed = false;
function setClockCollapsed(on){
  if(!CLOCK_FORCE_COLLAPSE_ENABLED) return;
  if(clockForceCollapsed === on) return;
  clockForceCollapsed = on;
  // Applied now, not on the next animation frame: the caller scrolls the
  // page to sit under this header immediately afterwards, and measuring it
  // at its old size would land short and then need a second correction —
  // which is what turned the jump into a visible scroll.
  if(clockSentinelEl && masterClockBoxEl){
    applyClockCollapse(on ? 1 : scrollCollapseT());
  }
}
const clockLabelEl = document.getElementById('masterClockLabel');
const clockDigitsEl = document.getElementById('masterClock');
const stickyHeaderEl = document.getElementById('stickyHeader');

function syncHeaderSpacer(){
  // no-op now that the header is position:sticky again (it reserves its
  // own flow space automatically) — kept as a stub so existing calls
  // don't error.
}

// Writes the collapse state for a given t (0 = full, 1 = collapsed). Split
// out of the loop so it can also be applied synchronously — a caller that
// then measures the header needs the new geometry in the same task, not one
// animation frame later.
function applyClockCollapse(t){
  if(t === clockLastT) return;
  clockLastT = t;
  const padTop = (20 - t*18).toFixed(1);
  const padSide = (22 - t*4).toFixed(1);
  const padBottom = (6 - t*2).toFixed(1);
  masterClockBoxEl.style.padding = `${padTop}px ${padSide}px ${padBottom}px`;
  if(clockDigitsEl) clockDigitsEl.style.fontSize = (56 - t*34).toFixed(1) + 'px';
  if(clockLabelEl){
    const labelOpacity = Math.max(0, 1 - t*1.4);
    clockLabelEl.style.opacity = labelOpacity.toFixed(2);
    // once it's faded out, let clicks pass through to the pill's own
    // sound-toggle handler instead of the (now invisible) label
    // intercepting them for a resync tap.
    clockLabelEl.style.pointerEvents = labelOpacity < 0.3 ? 'none' : 'auto';
  }
  syncHeaderSpacer();
}

function scrollCollapseT(){
  if(!CLOCK_SCROLL_COLLAPSE_ENABLED) return 0;
  const rect = clockSentinelEl.getBoundingClientRect();
  const distancePast = Math.max(0, -rect.bottom);
  return Math.round(Math.min(1, distancePast / CLOCK_COLLAPSE_RANGE) * 100) / 100; // 2dp: skips imperceptible sub-1% writes
}

function clockCollapseLoop(){
  if(clockSentinelEl && masterClockBoxEl){
    applyClockCollapse(clockForceCollapsed ? 1 : scrollCollapseT());
  }
  requestAnimationFrame(clockCollapseLoop);
}
requestAnimationFrame(clockCollapseLoop);
