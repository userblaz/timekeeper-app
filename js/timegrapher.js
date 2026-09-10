// Timegrapher tab: mic-based tick detection (experimental).
// Known limitation: iOS Safari applies mic gain compression (AGC) that
// can't be disabled from JS, which limits accuracy on iPhone specifically.
// This whole file is the boundary to swap for a native audio module later.

let tgFlashTimeout = null;
let tgListening = false;
let tgAudioCtx = null;
let tgStream = null;
let tgProcessor = null;
let tgSampleRate = 44100;
let tgTotalSamples = 0;
let tgRefractorySample = -Infinity;
let tgNoiseFloor = 0.001;
let tgLastBufferPeak = 0;
let tgSensitivity = 2.5; // higher = more sensitive (lower detection threshold)
let tgTickTimes = [];
let tgTickPeaks = [];
let tgStartWallClock = null;
let tgError = null;
let tgUpdateInterval = null;
let tgResults = null;

function tgSensitivityControlHtml(){
  return `<div style="margin-bottom:12px;">
    <div class="chart-header" style="margin:0 0 6px;">
      <div class="chart-label" style="margin:0;">sensitivity</div>
      <div class="chart-label" id="tgSensValue" style="margin:0;">${tgSensitivity.toFixed(1)}×</div>
    </div>
    <input type="range" id="tgSensSlider" class="tg-sens-slider" min="0.5" max="10" step="0.5" value="${tgSensitivity}" />
  </div>`;
}


function buildTimegrapherTabHtml(){
  return `
    <div class="section" style="margin-top:8px;padding-top:0;border-top:none;">
      <h2 class="section-title">Timegrapher <span style="font-weight:400;color:var(--grey);font-size:11px;">(experimental, mic-based)</span></h2>
      ${buildTimegrapherPanel()}
    </div>
  `;
}


function buildTimegrapherPanel(){
  if(tgError){
    return `<div class="quick-log-box">
      <p class="hint" style="text-align:center;color:var(--accent);">${escapeHtml(tgError)}</p>
      <button type="button" class="btn-primary" data-action="tgstart" style="width:100%;margin-top:8px;">Try again</button>
    </div>`;
  }
  if(tgListening){
    return `<div class="quick-log-box">
      <p class="hint" style="text-align:center;margin-bottom:10px;">Hold the mic close to the watch caseback, away from other noise.</p>
      ${tgSensitivityControlHtml()}
      <div class="tg-level-label">mic level <span id="tgLevelPct">0%</span></div>
      <div class="tg-level-track"><div class="tg-level-fill" id="tgLevelFill"></div><div class="tg-level-threshold" id="tgLevelThreshold"></div></div>
      <div class="tg-live-grid">
        <div><div class="tg-live-num" id="tgTickCount">0</div><div class="dial-unit">ticks</div></div>
        <div><div class="tg-live-num" id="tgElapsed">0s</div><div class="dial-unit">elapsed</div></div>
        <div><div class="tg-tick-dot" id="tgTickDot"></div><div class="dial-unit">tick</div></div>
      </div>
      <div id="tgLiveStats"></div>
      <button type="button" class="btn-secondary" data-action="tgstop" style="width:100%;margin-top:10px;">Stop</button>
    </div>`;
  }
  if(tgResults){
    return `<div class="quick-log-box">
      ${tgFormatStatsHtml(tgResults, false)}
      <button type="button" class="btn-primary" data-action="tgstart" style="width:100%;margin-top:10px;">Measure again</button>
    </div>`;
  }
  return `<div class="quick-log-box">
    <p class="hint" style="text-align:center;">Listens through the mic to estimate beat rate and timing from the tick sound. Rate detection is fairly reliable; beat error is approximate; true amplitude in degrees needs a calibrated contact mic, so it isn't shown as a precise number — only a rough signal-strength indicator.</p>
    ${tgSensitivityControlHtml()}
    <button type="button" class="btn-primary" data-action="tgstart" style="width:100%;margin-top:10px;">Start listening</button>
  </div>`;
}


function tgFormatStatsHtml(stats, isLive){
  const sign = stats.secPerDay >= 0 ? '+' : '';
  const snrLabel = stats.snrDb < 10 ? '(weak — get closer)' : stats.snrDb < 20 ? '(ok)' : '(good)';
  return `
    <div class="tg-stat-row"><span>Detected beat rate</span><b>${stats.bph} bph</b></div>
    <div class="tg-stat-row"><span>Rate</span><b style="color:${stats.secPerDay>=0?'#22C55E':'#F87171'}">${sign}${stats.secPerDay.toFixed(1)} s/day</b></div>
    <div class="tg-stat-row"><span>Beat error</span><b>${stats.beatErrorMs.toFixed(1)} ms</b></div>
    <div class="tg-stat-row"><span>Signal strength</span><b>${stats.snrDb.toFixed(0)} dB ${snrLabel}</b></div>
    <p class="hint" style="margin-top:8px;">${isLive ? 'Still listening — this will stabilize as more ticks come in.' : "Amplitude in degrees isn't shown — that needs a calibrated contact mic. Signal strength above is a rough proxy only, not a true reading."}</p>
  `;
}


async function tgStart(){
  tgError = null;
  tgResults = null;
  let stream;
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1 }
    });
  }catch(e){
    tgError = "Couldn't access the microphone — check that this page has mic permission.";
    render();
    return;
  }
  tgStream = stream;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  tgAudioCtx = new Ctx();
  tgSampleRate = tgAudioCtx.sampleRate;
  const source = tgAudioCtx.createMediaStreamSource(stream);
  const hp = tgAudioCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300;
  const lp = tgAudioCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 10000;
  const processor = tgAudioCtx.createScriptProcessor(1024, 1, 1);
  const silentGain = tgAudioCtx.createGain(); silentGain.gain.value = 0;
  source.connect(hp); hp.connect(lp); lp.connect(processor); processor.connect(silentGain); silentGain.connect(tgAudioCtx.destination);
  tgProcessor = processor;
  tgTotalSamples = 0;
  tgRefractorySample = -Infinity;
  tgNoiseFloor = 0.001;
  tgTickTimes = [];
  tgTickPeaks = [];
  tgStartWallClock = Date.now();
  processor.onaudioprocess = tgProcessAudio;
  tgListening = true;
  render();
  tgUpdateInterval = setInterval(tgRefreshLiveDisplay, 100);
}


function tgFlashDot(){
  const dot = document.getElementById('tgTickDot');
  if(!dot) return;
  dot.style.background = '#22C55E';
  clearTimeout(tgFlashTimeout);
  tgFlashTimeout = setTimeout(()=>{ dot.style.background = ''; }, 90);
}


function tgProcessAudio(e){
  const input = e.inputBuffer.getChannelData(0);
  let bufferPeak = 0;
  let anyTick = false;
  const factor = 1.8 / tgSensitivity;
  const absFloor = 0.0018 / tgSensitivity;
  const threshold = Math.max(tgNoiseFloor * factor, absFloor);
  for(let i=0;i<input.length;i++){
    const a = Math.abs(input[i]);
    if(a > bufferPeak) bufferPeak = a;
    const gIdx = tgTotalSamples + i;
    if(gIdx >= tgRefractorySample && a > threshold){
      tgTickTimes.push(gIdx / tgSampleRate);
      tgTickPeaks.push(a);
      tgRefractorySample = gIdx + Math.floor(0.025 * tgSampleRate);
      anyTick = true;
      tgFlashDot();
    }
  }
  tgLastBufferPeak = bufferPeak;
  if(!anyTick){
    tgNoiseFloor = tgNoiseFloor * 0.98 + bufferPeak * 0.02;
  }
  tgTotalSamples += input.length;
}


function tgTeardownAudio(){
  if(tgUpdateInterval){ clearInterval(tgUpdateInterval); tgUpdateInterval = null; }
  if(tgProcessor){ tgProcessor.onaudioprocess = null; try{ tgProcessor.disconnect(); }catch(e){} tgProcessor = null; }
  if(tgAudioCtx){ try{ tgAudioCtx.close(); }catch(e){} tgAudioCtx = null; }
  if(tgStream){ tgStream.getTracks().forEach(t => t.stop()); tgStream = null; }
}


function tgStop(){
  tgTeardownAudio();
  tgListening = false;
  tgResults = tgComputeStats();
  render();
}


function tgAbort(){
  tgTeardownAudio();
  tgListening = false;
  tgResults = null;
}


function tgComputeStats(){
  if(tgTickTimes.length < 4) return null;
  const intervalsMs = [];
  for(let i=1;i<tgTickTimes.length;i++){ intervalsMs.push((tgTickTimes[i]-tgTickTimes[i-1]) * 1000); }
  const filtered = intervalsMs.filter(x => x >= 60 && x <= 400);
  if(filtered.length < 3) return null;
  const sorted = [...filtered].sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length/2)];
  const standardBph = [14400, 18000, 19800, 21600, 25200, 28800, 36000];
  let bestBph = standardBph[0], bestDiff = Infinity;
  standardBph.forEach(b => {
    const nominal = 3600000 / b;
    const diff = Math.abs(nominal - median);
    if(diff < bestDiff){ bestDiff = diff; bestBph = b; }
  });
  const nominalMs = 3600000 / bestBph;
  const mean = filtered.reduce((s,x)=>s+x,0) / filtered.length;
  const ratePpm = (nominalMs - mean) / nominalMs;
  const secPerDay = ratePpm * 86400;
  const groupA = [], groupB = [];
  filtered.forEach((v,i) => (i%2===0 ? groupA : groupB).push(v));
  const avgA = groupA.reduce((s,x)=>s+x,0) / (groupA.length || 1);
  const avgB = groupB.reduce((s,x)=>s+x,0) / (groupB.length || 1);
  const beatErrorMs = Math.abs(avgA - avgB);
  const avgPeak = tgTickPeaks.reduce((s,x)=>s+x,0) / (tgTickPeaks.length || 1);
  const snrDb = 20 * Math.log10(Math.max(avgPeak,1e-6) / Math.max(tgNoiseFloor,1e-6));
  return { bph: bestBph, secPerDay, beatErrorMs, snrDb, tickCount: tgTickTimes.length };
}


function tgRefreshLiveDisplay(){
  const elCount = document.getElementById('tgTickCount');
  if(!elCount) return;
  elCount.textContent = tgTickTimes.length;
  const elElapsed = document.getElementById('tgElapsed');
  if(elElapsed && tgStartWallClock){
    elElapsed.textContent = Math.floor((Date.now()-tgStartWallClock)/1000) + 's';
  }

  // live mic level meter — scaled against a fixed reference (0.3) so a
  // moderate real-world tick shows as a clearly visible spike, not a
  // barely-there sliver
  const elLevelFill = document.getElementById('tgLevelFill');
  const elLevelPct = document.getElementById('tgLevelPct');
  if(elLevelFill){
    const pct = Math.min(100, Math.round((tgLastBufferPeak / 0.3) * 100));
    elLevelFill.style.width = pct + '%';
    elLevelFill.style.background = pct > 70 ? 'var(--good)' : pct > 15 ? 'var(--accent)' : 'var(--grey)';
    if(elLevelPct) elLevelPct.textContent = pct + '%';
  }
  const elThreshold = document.getElementById('tgLevelThreshold');
  if(elThreshold){
    const factor = 1.8 / tgSensitivity;
    const absFloor = 0.0018 / tgSensitivity;
    const threshold = Math.max(tgNoiseFloor * factor, absFloor);
    const thresholdPct = Math.min(100, Math.round((threshold / 0.3) * 100));
    elThreshold.style.left = thresholdPct + '%';
  }

  if(tgTickTimes.length >= 10){
    const stats = tgComputeStats();
    const elLive = document.getElementById('tgLiveStats');
    if(stats && elLive){
      elLive.innerHTML = tgFormatStatsHtml(stats, true);
    }
  }
}

