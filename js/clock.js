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
    <div class="section" style="margin-top:8px;padding-top:0;border-top:none;">
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
    const res = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', { cache: 'no-store' });
    const t1 = Date.now();
    if(!res.ok) throw new Error('bad response');
    const data = await res.json();
    const serverMs = Date.parse(data.datetime);
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
}

setInterval(() => {
  const el = document.getElementById('masterClock');
  if(el){
    const n = trueNow();
    el.textContent = pad2(n.getHours()) + ':' + pad2(n.getMinutes()) + ':' + pad2(n.getSeconds());
  }
  updateAnalogClock();
}, 60);

function updateClockCollapse(){
  // kept as a no-op shim so existing render() calls to it don't error
}

const clockSentinelEl = document.getElementById('clockSentinel');
const masterClockBoxEl = document.getElementById('masterClockBox');
const CLOCK_COLLAPSE_RANGE = 70; // px of scroll over which it fully collapses

// Continuous scroll-linked collapse: every animation frame, measure exactly
// how far past the sentinel we've scrolled and set that as a 0–1 progress
// value via a CSS custom property, which calc() uses to size the box.
// This tracks the finger 1:1 (like iOS/Android collapsing headers) instead
// of snapping between two fixed states, so there's nothing to look jumpy.
function clockCollapseLoop(){
  if(clockSentinelEl && masterClockBoxEl){
    const rect = clockSentinelEl.getBoundingClientRect();
    const distancePast = Math.max(0, -rect.bottom);
    const t = Math.min(1, distancePast / CLOCK_COLLAPSE_RANGE);
    masterClockBoxEl.style.setProperty('--t', t.toFixed(3));
  }
  requestAnimationFrame(clockCollapseLoop);
}
requestAnimationFrame(clockCollapseLoop);
