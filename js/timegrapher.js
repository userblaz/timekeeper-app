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
let tgNoiseFloor = 0.0002;
let tgLastBufferPeak = 0;
let tgSensitivity = 2.5; // higher = more sensitive (lower detection threshold)
let tgEnv = 0;       // running envelope of the band-passed signal
let tgPrevEnv = 0;   // previous sample's envelope, to catch the rising edge
let tgAttackCoef = 0;
let tgReleaseCoef = 0;

// Detector tuning, collected here so the whole thing can be re-tuned in one
// place. The numbers come from what an escapement actually sounds like: the
// click is a broadband impulse whose useful energy sits well above the band
// where room rumble, HVAC, handling noise and voices live, so the band-pass
// is deliberately narrow and high. Everything downstream works on the
// envelope of that band rather than raw samples — a tick is a 1–3 ms
// transient, and raw per-sample thresholding mostly finds noise spikes.
const TG_HIGHPASS_HZ = 1800;
const TG_LOWPASS_HZ = 12000;
const TG_PREAMP = 40;        // the band-passed tick is tiny; give it headroom
const TG_ATTACK_MS = 0.2;    // envelope rise — fast enough to keep the onset sharp
const TG_RELEASE_MS = 4;     // envelope fall — slow enough to ride over one click
const TG_REFRACTORY_MS = 22; // shortest gap between two ticks we'll accept

// Threshold is a multiple of the tracked noise floor. The slider picks the
// multiple: gentle at the low end, nearly floor-level at the high end.
function tgThresholdFor(noiseFloor){
  const k = 1.2 + 7 / tgSensitivity;
  return noiseFloor * k + 0.0004 / tgSensitivity;
}
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
  // getUserMedia's await spends the user-gesture token, so the context can
  // come back suspended — and a suspended context never fires onaudioprocess
  // at all, which looks exactly like a mic that hears nothing.
  if(tgAudioCtx.state === 'suspended'){
    try{ await tgAudioCtx.resume(); }catch(e){}
  }
  tgSampleRate = tgAudioCtx.sampleRate;
  const source = tgAudioCtx.createMediaStreamSource(stream);
  // Two cascaded high-passes: one biquad rolls off at 12 dB/octave, which
  // still lets plenty of low-frequency room noise through right below the
  // corner. Doubling it up gets the band genuinely clean.
  const hp1 = tgAudioCtx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = TG_HIGHPASS_HZ;
  const hp2 = tgAudioCtx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = TG_HIGHPASS_HZ;
  const lp = tgAudioCtx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = Math.min(TG_LOWPASS_HZ, tgSampleRate / 2 - 1000);
  const preamp = tgAudioCtx.createGain(); preamp.gain.value = TG_PREAMP;
  const processor = tgAudioCtx.createScriptProcessor(1024, 1, 1);
  const silentGain = tgAudioCtx.createGain(); silentGain.gain.value = 0;
  source.connect(hp1); hp1.connect(hp2); hp2.connect(lp); lp.connect(preamp); preamp.connect(processor);
  processor.connect(silentGain); silentGain.connect(tgAudioCtx.destination);
  tgProcessor = processor;
  tgTotalSamples = 0;
  tgRefractorySample = -Infinity;
  tgNoiseFloor = 0.0002;
  tgEnv = 0;
  tgPrevEnv = 0;
  tgAttackCoef = Math.exp(-1 / (TG_ATTACK_MS / 1000 * tgSampleRate));
  tgReleaseCoef = Math.exp(-1 / (TG_RELEASE_MS / 1000 * tgSampleRate));
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
  const refractory = Math.floor(TG_REFRACTORY_MS / 1000 * tgSampleRate);
  let bufferPeak = 0;
  let anyTick = false;

  for(let i=0;i<input.length;i++){
    const a = Math.abs(input[i]);
    // Fast attack, slow release: the envelope jumps onto the click within a
    // fraction of a millisecond and then coasts down, so one tick reads as a
    // single bump instead of a burst of individual sample crossings.
    const coef = a > tgEnv ? tgAttackCoef : tgReleaseCoef;
    tgEnv = coef * tgEnv + (1 - coef) * a;
    if(tgEnv > bufferPeak) bufferPeak = tgEnv;

    const gIdx = tgTotalSamples + i;
    const threshold = tgThresholdFor(tgNoiseFloor);

    // Fire on the rising edge only. Thresholding the level instead would
    // re-trigger on every sample the envelope stays high for, and the
    // refractory window would then be doing all the work.
    if(gIdx >= tgRefractorySample && tgEnv > threshold && tgPrevEnv <= threshold){
      tgTickTimes.push(gIdx / tgSampleRate);
      tgTickPeaks.push(tgEnv);
      tgRefractorySample = gIdx + refractory;
      anyTick = true;
    } else if(gIdx >= tgRefractorySample){
      // Track the quiet baseline between ticks: creep up slowly, settle down
      // faster. Following the envelope's low side is what makes this the
      // noise floor rather than (as before) an average of the peaks, which
      // climbed until the ticks themselves could no longer clear it.
      const rate = tgEnv > tgNoiseFloor ? 0.00005 : 0.0005;
      tgNoiseFloor += (tgEnv - tgNoiseFloor) * rate;
    }
    tgPrevEnv = tgEnv;
  }

  tgLastBufferPeak = bufferPeak;
  if(anyTick) tgFlashDot();
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
  // Silently dropping back to the start screen left no clue as to whether
  // the mic heard nothing or heard only noise — say which.
  if(!tgResults){
    tgError = tgTickTimes.length < 10
      ? "Didn't hear enough ticks. Press the phone's mic right against the caseback, somewhere quiet, and raise the sensitivity."
      : "Picked up sound, but nothing steady enough to be an escapement. Try somewhere quieter, or move the mic closer.";
  }
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
  // A real escapement is metronomic, so most gaps should land on the median.
  // Room noise also produces gaps in the 60–400 ms window, and without this
  // check a handful of random thumps would be reported as a confident bph.
  const onBeat = filtered.filter(x => Math.abs(x - median) <= median * 0.15).length;
  if(onBeat / filtered.length < 0.6) return null;
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


// Maps an envelope level onto the meter: 0% at -60 dB, 100% at full scale.
function tgLevelPct(v){
  const db = 20 * Math.log10(Math.max(v, 1e-6));
  return Math.max(0, Math.min(100, Math.round((db + 60) / 60 * 100)));
}


function tgRefreshLiveDisplay(){
  const elCount = document.getElementById('tgTickCount');
  if(!elCount) return;
  elCount.textContent = tgTickTimes.length;
  const elElapsed = document.getElementById('tgElapsed');
  if(elElapsed && tgStartWallClock){
    elElapsed.textContent = Math.floor((Date.now()-tgStartWallClock)/1000) + 's';
  }

  // Live mic level meter, on a decibel scale. A linear one was the reason
  // the meter looked dead: a perfectly usable tick 40 dB down from full
  // scale is 1% of the bar's width and invisible, while the noise floor and
  // the threshold marker both sat pinned at zero on top of each other.
  const elLevelFill = document.getElementById('tgLevelFill');
  const elLevelPct = document.getElementById('tgLevelPct');
  if(elLevelFill){
    const pct = tgLevelPct(tgLastBufferPeak);
    elLevelFill.style.width = pct + '%';
    elLevelFill.style.background = pct > 70 ? 'var(--good)' : pct > 25 ? 'var(--accent)' : 'var(--grey)';
    if(elLevelPct) elLevelPct.textContent = pct + '%';
  }
  const elThreshold = document.getElementById('tgLevelThreshold');
  if(elThreshold){
    elThreshold.style.left = tgLevelPct(tgThresholdFor(tgNoiseFloor)) + '%';
  }

  if(tgTickTimes.length >= 10){
    const stats = tgComputeStats();
    const elLive = document.getElementById('tgLiveStats');
    if(stats && elLive){
      elLive.innerHTML = tgFormatStatsHtml(stats, true);
    }
  }
}

