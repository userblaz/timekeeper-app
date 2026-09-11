// Timegrapher tab: mic-based tick detection (experimental).
// Known limitation: iOS Safari applies mic gain compression (AGC) that
// can't be disabled from JS, which limits accuracy on iPhone specifically.
// This whole file is the boundary to swap for a native audio module later.
//
// How this measures, and why it isn't a threshold:
//
// An escapement heard through a phone mic is often quieter than the room it
// is in. Detecting ticks by loudness — "is this sample louder than the noise
// floor times k?" — cannot work there: any threshold low enough to catch the
// tick also catches noise, and the slider only trades one failure for the
// other. That is what the earlier detector did, and why turning sensitivity
// to maximum still found almost nothing.
//
// What a watch has that noise does not is *periodicity*. So nothing here
// looks for an individual tick. The envelope of the band-passed mic signal
// is autocorrelated to find the beat period, and then folded at that period
// so that every beat in the recording is stacked on top of every other. N
// stacked beats raise the tick above the noise by roughly sqrt(N) — a minute
// of a 28800 bph watch stacks 480 beats, about 27 dB of gain — which is why
// this finds a watch that no per-sample threshold can see.
//
// Rate then comes from watching the stacked tick *drift* within the fold: if
// the true period differs from the period we folded at, the tick walks
// steadily across the window, and the slope of that walk is the error.

let tgFlashTimeout = null;
let tgListening = false;
let tgAudioCtx = null;
let tgStream = null;
let tgProcessor = null;
let tgSampleRate = 44100;
let tgTotalSamples = 0;
let tgNoiseFloor = 0.0002;
let tgLastBufferPeak = 0;
// Highest raw, unfiltered input level seen since listening started. Unlike
// the live meter (which follows the current block and falls back down
// between sounds), this only ever climbs — so tapping near the mic once is
// enough to see whether it picked up anything at all, without having to
// catch the bar mid-jump.
let tgRawPeakHold = 0;
// A raw transient detector, independent of any lock. The dot below only
// blinked once a full correlation lock existed, which meant "no lock yet"
// and "the dot never lights" were the same fact stated twice — exactly the
// wrong signal while trying to tell "the mic hears nothing" apart from "it
// hears clicks, they just aren't locking yet". This flashes on any transient
// in the raw signal, well before — and independent of — any lock. Here it
// only drives a light; it feeds nothing downstream.
//
// This compares each callback's own peak sample against a floor that tracks
// the *peak*, not the mean or RMS — deliberately. An attack/release envelope
// (the first version of this) smooths the signal before comparing it, and a
// tick is only 1-3 ms: smoothing it away before the comparison can lose more
// of its true height than the threshold ever gave back, which silently
// undersells a real but brief click. Comparing raw peaks sidesteps that
// entirely. And a mean- or RMS-tracked floor badly understates how loud
// ordinary noise alone gets moment to moment — Gaussian noise routinely
// peaks several times its own RMS within a buffer — so a floor tracked that
// way lets ordinary room noise cross a "here's a click" threshold on its
// own. Tracking the floor as a peak already absorbs that swing, which is
// what keeps this from false-flashing on the room by itself.
let tgRawFloorPeak = 0.0005;
let tgRawLastFlashAt = 0;
let tgRawFlashTimeout = null;
let tgSensitivity = 2.5; // higher = more sensitive (accepts a weaker lock)
let tgStartWallClock = null;
let tgError = null;
let tgUpdateInterval = null;
let tgResults = null;

// Three band-passes, listened to at once, rather than one fixed band.
//
// Where a tick's energy lands at the microphone is not something we can know
// in advance: it depends on the movement, the case, whether the mic is
// pressed against the caseback or across a desk, and how much high end the
// air between them ate. A single hard-coded band is a bet, and when it is
// wrong it filters out the watch and keeps the room — which looks exactly
// like a mic that is not sensitive enough, and cannot be fixed by turning
// anything up. So the signal is split three ways, each band gets its own
// envelope, and the analysis uses whichever one actually contains the watch.
const TG_BANDS = [
  { lo: 400,  hi: 2000,  label: '0.4–2 kHz' },
  { lo: 2000, hi: 6000,  label: '2–6 kHz' },
  { lo: 6000, hi: 14000, label: '6–14 kHz' }
];
const TG_PREAMP = 40;        // headroom only — gain cannot change the ratio

// The envelope the whole analysis runs on. 4 kHz — 0.25 ms per sample — is
// far finer than any timing we report, and coarse enough that a two-minute
// recording is a couple of megabytes.
const TG_ENV_RATE = 4000;
const TG_MAX_SEC = 120;
// The period search runs on a 1 kHz view of the envelope. Autocorrelation is
// quadratic in the window length, and 1 ms resolution is plenty to find a
// beat that is somewhere between 55 and 420 ms; the precision comes later,
// from the drift fit, not from this.
// 500 Hz — 2 ms per bin, about the width of the tick itself, which is where
// power averaging stops helping and starts smearing. It also keeps the
// autocorrelation (quadratic in window length) cheap enough to re-run over
// the whole recording twice a second.
const TG_CORR_RATE = 500;
const TG_CORR_DECIM = Math.round(TG_ENV_RATE / TG_CORR_RATE);
const TG_MIN_BEAT_MS = 55;
const TG_MAX_BEAT_MS = 420;
// A periodic impulse train correlates at its period and at every multiple of
// it. Whenever half the winning lag correlates nearly as well, that half is
// the real beat and the winner was a harmonic.
const TG_SUBHARMONIC_FRAC = 0.55;
// Minimum audio before any of this means anything.
const TG_MIN_SEC = 4;
// One drift sample is taken per chunk. Long enough to stack a useful number
// of beats, short enough that several fit in a short recording.
const TG_CHUNK_SEC = 5;
// How far the per-chunk phase may scatter off the drift line, as a fraction
// of one beat, before the rate is called unreliable and nothing is reported.
const TG_MAX_PHASE_SCATTER = 0.12;
// Seconds of audio used to decide which band holds the watch.
const TG_BAND_SELECT_SEC = 30;
const TG_STANDARD_BPH = [14400, 18000, 19800, 21600, 25200, 28800, 36000];
// Plausibility gates. Both catch a real periodic signal that isn't a watch —
// hand tremor, footsteps, HVAC — which passes the significance test because
// it genuinely is periodic; these check whether the *answer* looks like a
// watch, which the significance test alone doesn't ask.
const TG_MAX_PLAUSIBLE_SPD = 300;   // s/day; even a badly damaged watch rarely exceeds this
const TG_MAX_BEAT_ERROR_FRAC = 0.3; // of one beat interval
const TG_MIN_SNR_DB = 3;            // stacked tick above the folded floor

// Envelope ring buffer, plus the peak-hold decimator that fills it.
let tgEnvBufs = [];      // one envelope ring per band
let tgEnvWrite = 0;      // total envelope samples ever written, per band
let tgDecim = 1;         // audio samples per envelope sample
// The envelope rate we actually got, which is not the one we asked for: the
// decimation factor has to be a whole number of audio samples, so at 44.1 kHz
// the nearest factor to 4 kHz is 11, giving 4009.09 Hz. Converting envelope
// samples to seconds with the nominal 4000 instead put a 0.23% error — nearly
// 200 s/day — straight into the rate. Every time conversion uses this.
let tgEnvRate = TG_ENV_RATE;
let tgDecimPeak = 0;
let tgDecimSumSq = [];
let tgDecimCount = 0;
let tgBestBand = null;   // which band the current lock came from

// Current lock, used to blink the tick dot in time with the watch.
let tgDotRaf = null;
let tgLockPeriodMs = 0;
let tgLockAnchorMs = 0;
let tgLastDotFlash = 0;

// How strong a correlation counts as a watch. This cannot be a fixed number:
// for pure noise the correlation at any one lag scatters around zero with a
// spread of about 1/sqrt(N), so what matters is how many of those spreads the
// peak stands above zero — and N grows every second we keep listening. A
// correlation of 0.02 is meaningless after four seconds and overwhelming
// after ninety. Expressing the gate in sigmas is what lets a long recording
// find a tick that a short one cannot, which is the whole point of the
// rewrite. The slider sets how many sigmas we insist on.
function tgSigmaFactor(){
  return 3 + 5 / tgSensitivity;
}
function tgMinCorrelation(n){
  return tgSigmaFactor() / Math.sqrt(Math.max(n, 1));
}

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
      <p class="hint" style="text-align:center;margin-bottom:10px;">Hold the mic against the watch caseback, away from other noise. Give it 20–30 seconds — the longer it listens, the further it can dig the tick out of the noise.</p>
      ${tgSensitivityControlHtml()}
      <div class="tg-level-label">mic level <span id="tgLevelPct">0%</span> <span class="dial-unit" style="margin-left:6px;">loudest so far: <span id="tgPeakHold">—</span></span></div>
      <div class="tg-level-track"><div class="tg-level-fill" id="tgLevelFill"></div><div class="tg-level-threshold" id="tgLevelThreshold"></div></div>
      <p class="hint" id="tgRawHint" style="text-align:center;margin:6px 0 0;"></p>
      <div class="tg-live-grid">
        <div><div class="tg-live-num" id="tgTickCount">—</div><div class="dial-unit">lock</div></div>
        <div><div class="tg-live-num" id="tgElapsed">0s</div><div class="dial-unit">elapsed</div></div>
        <div><div class="tg-tick-dot" id="tgTickDot"></div><div class="dial-unit">tick</div></div>
      </div>
      <p class="hint" style="text-align:center;margin-top:2px;">grey = a click was heard · green = locked to the beat</p>
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
    <p class="hint" style="text-align:center;">Listens through the mic and locks onto the beat to estimate rate. It works by stacking every beat it hears on top of the others, so it can find a tick that is quieter than the room — but it needs time to do that. Rate is fairly reliable; beat error is approximate; true amplitude in degrees needs a calibrated contact mic, so it isn't shown.</p>
    ${tgSensitivityControlHtml()}
    <button type="button" class="btn-primary" data-action="tgstart" style="width:100%;margin-top:10px;">Start listening</button>
  </div>`;
}


function tgFormatStatsHtml(stats, isLive){
  const sign = stats.secPerDay >= 0 ? '+' : '';
  const lockPct = Math.round(stats.lock * 100);
  const lockLabel = stats.lock < 0.15 ? '(faint — get closer)' : stats.lock < 0.35 ? '(ok)' : '(solid)';
  return `
    <div class="tg-stat-row"><span>Detected beat rate</span><b>${stats.bph} bph</b></div>
    <div class="tg-stat-row"><span>Rate</span><b style="color:${stats.secPerDay>=0?'#22C55E':'#F87171'}">${sign}${stats.secPerDay.toFixed(1)} s/day</b></div>
    <div class="tg-stat-row"><span>Beat error</span><b>${stats.beatErrorMs.toFixed(1)} ms</b></div>
    <div class="tg-stat-row"><span>Beats stacked</span><b>${stats.beats}</b></div>
    <div class="tg-stat-row"><span>Heard in</span><b>${stats.band}</b></div>
    <div class="tg-stat-row"><span>Lock strength</span><b>${lockPct}% ${lockLabel}</b></div>
    <p class="hint" style="margin-top:8px;">${isLive ? 'Still listening — rate tightens the longer this runs.' : "Amplitude in degrees isn't shown — that needs a calibrated contact mic."}</p>
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
  // The three bands are merged into one multi-channel stream and read by a
  // single processor, rather than given a processor each — ScriptProcessors
  // are expensive and run on the main thread, and three of them competing
  // would cost more than the analysis they feed.
  // Channel count is bands + 1: the extra channel is a straight,
  // unfiltered tap off the source — no band-pass, no preamp. It answers a
  // different question than the bands do. The bands ask "which slice of
  // spectrum has the watch in it"; this asks "is the mic delivering
  // anything at all", which the bands can't answer on their own, since a
  // dead mic and a mic whose tick got filtered into the wrong band look
  // identical downstream.
  const RAW_CH = TG_BANDS.length;
  const merger = tgAudioCtx.createChannelMerger(TG_BANDS.length + 1);
  const nyquist = tgSampleRate / 2 - 500;
  TG_BANDS.forEach((band, i) => {
    // Two cascaded high-passes: one biquad rolls off at 12 dB/octave, which
    // still lets plenty of noise through right below the corner. Doubling it
    // up gets the band genuinely clean.
    const hp1 = tgAudioCtx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = band.lo;
    const hp2 = tgAudioCtx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = band.lo;
    const lp = tgAudioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(band.hi, nyquist);
    const preamp = tgAudioCtx.createGain(); preamp.gain.value = TG_PREAMP;
    source.connect(hp1); hp1.connect(hp2); hp2.connect(lp); lp.connect(preamp);
    preamp.connect(merger, 0, i);
  });
  const rawTap = tgAudioCtx.createGain(); rawTap.gain.value = 1;
  source.connect(rawTap);
  rawTap.connect(merger, 0, RAW_CH);
  const processor = tgAudioCtx.createScriptProcessor(1024, TG_BANDS.length + 1, 1);
  const silentGain = tgAudioCtx.createGain(); silentGain.gain.value = 0;
  merger.connect(processor);
  processor.connect(silentGain); silentGain.connect(tgAudioCtx.destination);
  tgProcessor = processor;
  tgResetCapture();
  processor.onaudioprocess = tgProcessAudio;
  tgListening = true;
  render();
  tgScheduleRefresh(0);
  tgDotRaf = requestAnimationFrame(tgDotLoop);
}


// Each live update is a fresh autocorrelation over the entire recording, so
// it gets slower the longer you listen — around 200 ms at two minutes on a
// laptop, and several times that on a phone. A fixed interval would therefore
// eventually spend the whole main thread on analysis and leave none for the
// animation. Instead each refresh schedules the next one to leave at least
// three times its own cost idle, so the display updates often early on and
// backs off gracefully as the recording grows.
function tgScheduleRefresh(delay){
  if(!tgListening) return;
  tgUpdateInterval = setTimeout(() => {
    const t0 = Date.now();
    tgRefreshLiveDisplay();
    const cost = Date.now() - t0;
    tgScheduleRefresh(Math.max(500, cost * 4));
  }, delay);
}


function tgResetCapture(){
  tgSampleRate = tgAudioCtx ? tgAudioCtx.sampleRate : tgSampleRate;
  tgDecim = Math.max(1, Math.round(tgSampleRate / TG_ENV_RATE));
  tgEnvRate = tgSampleRate / tgDecim;
  tgEnvBufs = TG_BANDS.map(() => new Float32Array(Math.ceil(TG_MAX_SEC * tgEnvRate)));
  tgEnvWrite = 0;
  tgDecimPeak = 0;
  tgDecimSumSq = TG_BANDS.map(() => 0);
  tgDecimCount = 0;
  tgBestBand = null;
  tgTotalSamples = 0;
  tgNoiseFloor = 0.0002;
  tgLastBufferPeak = 0;
  tgRawPeakHold = 0;
  tgLockPeriodMs = 0;
  tgLockAnchorMs = 0;
  tgLastDotFlash = 0;
  tgRawFloorPeak = 0.0005;
  tgRawLastFlashAt = 0;
  tgStartWallClock = Date.now();
}


function tgFlashDot(){
  const dot = document.getElementById('tgTickDot');
  if(!dot) return;
  dot.style.background = '#22C55E';
  clearTimeout(tgFlashTimeout);
  tgFlashTimeout = setTimeout(()=>{ dot.style.background = ''; }, 90);
}


// A dimmer, neutral flash for a raw transient — deliberately not green, so
// it reads as "heard a click" rather than "found the watch". Only runs
// before a lock exists; once locked, tgDotLoop's green, beat-synced flash is
// the more meaningful signal and this steps aside for it.
function tgFlashRawActivity(){
  if(tgLockPeriodMs) return;
  const dot = document.getElementById('tgTickDot');
  if(!dot) return;
  dot.style.background = '#9C9AB5';
  clearTimeout(tgRawFlashTimeout);
  tgRawFlashTimeout = setTimeout(()=>{ if(!tgLockPeriodMs) dot.style.background = ''; }, 90);
}


// Blinks the dot in time with the locked beat rather than on whatever the
// mic happened to hear. Before the old detector had a lock the dot sat dead,
// which read as "the mic isn't working" when the real answer was "not yet".
function tgDotLoop(){
  if(!tgListening){ tgDotRaf = null; return; }
  tgDotRaf = requestAnimationFrame(tgDotLoop);
  if(!tgLockPeriodMs) return;
  const now = Date.now();
  const k = Math.floor((now - tgLockAnchorMs) / tgLockPeriodMs);
  const tickAt = tgLockAnchorMs + k * tgLockPeriodMs;
  if(tickAt > tgLastDotFlash){
    tgLastDotFlash = tickAt;
    tgFlashDot();
  }
}


// Decimates down to the envelope rate as mean square — short-term power.
// Power, not peak and not rectified amplitude: for an impulse buried in
// Gaussian noise it is the matched statistic, and it squares the contrast
// between the tick and the floor. Peak-hold is the opposite of what is
// wanted here, since it reports the loudest noise sample in every window and
// so raises the floor to meet the tick.
function tgProcessAudio(e){
  const nb = TG_BANDS.length;
  const rawCh = nb; // the extra, unfiltered channel added in tgStart
  const chans = [];
  for(let b=0;b<nb;b++) chans.push(e.inputBuffer.getChannelData(b));
  const raw = e.inputBuffer.getChannelData(rawCh);
  const len = chans[0].length;
  let bufferPeak = 0;
  let rawPeak = 0;
  let bufferSum = 0;
  for(let i=0;i<len;i++){
    for(let b=0;b<nb;b++){
      const v = chans[b][i];
      tgDecimSumSq[b] += v * v;
    }
    // The meter, the noise-floor marker and the "is the mic alive at all"
    // readout all follow this raw, unfiltered, un-preamped tap — not any of
    // the analysis bands. That distinction matters: a filtered band reading
    // zero could mean a dead mic, or could just mean the tick fell in a
    // different band, and those look identical unless something bypasses the
    // filters entirely.
    const a = Math.abs(raw[i]);
    bufferSum += a;
    if(a > tgDecimPeak) tgDecimPeak = a;
    if(a > rawPeak) rawPeak = a;

    if(++tgDecimCount >= tgDecim){
      if(tgDecimPeak > bufferPeak) bufferPeak = tgDecimPeak;
      const slot = tgEnvWrite % tgEnvBufs[0].length;
      for(let b=0;b<nb;b++){
        tgEnvBufs[b][slot] = tgDecimSumSq[b] / tgDecim;
        tgDecimSumSq[b] = 0;
      }
      tgEnvWrite++;
      tgDecimPeak = 0;
      tgDecimCount = 0;
    }
  }
  tgLastBufferPeak = bufferPeak;
  if(rawPeak > tgRawPeakHold) tgRawPeakHold = rawPeak;

  // Live transient flash — see tgFlashRawActivity and tgRawFloorPeak above.
  // Checked once per callback (~23 ms at 44.1 kHz) against this callback's
  // own raw peak, which is already computed above. A refractory window in
  // wall-clock time (not sample count — there is nothing left here counting
  // samples) keeps one click from re-triggering the flash's own visual
  // duration.
  const transientMult = 2.2 + 4 / tgSensitivity;
  const now = tgAudioCtx ? tgAudioCtx.currentTime * 1000 : Date.now();
  if(rawPeak > tgRawFloorPeak * transientMult && now - tgRawLastFlashAt > 90){
    tgRawLastFlashAt = now;
    tgFlashRawActivity();
  }
  // Tracks the *peak*, not the mean — see the comment on tgRawFloorPeak.
  // Unconditional: adapting only on blocks that don't cross the threshold
  // was the first version of this, and it can deadlock. If the floor starts
  // below the room's real level, most blocks cross immediately, which is
  // exactly the condition that was supposed to gate the update — so the
  // floor never gets the chance to catch up, and the room false-flashes
  // indefinitely. The climb is kept slow so a real tick's own peak — rare
  // relative to how many blocks it isn't in — only nudges the floor a
  // little; the room settling down after a loud moment is allowed to happen
  // much faster.
  tgRawFloorPeak += (rawPeak - tgRawFloorPeak) * (rawPeak > tgRawFloorPeak ? 0.01 : 0.2);

  // Display only — the analysis has no use for a noise floor any more.
  const bufferMean = bufferSum / len;
  tgNoiseFloor += (bufferMean - tgNoiseFloor) * 0.05;
  tgTotalSamples += len;
}


function tgTeardownAudio(){
  if(tgUpdateInterval){ clearTimeout(tgUpdateInterval); tgUpdateInterval = null; }
  if(tgDotRaf){ cancelAnimationFrame(tgDotRaf); tgDotRaf = null; }
  clearTimeout(tgFlashTimeout);
  clearTimeout(tgRawFlashTimeout);
  if(tgProcessor){ tgProcessor.onaudioprocess = null; try{ tgProcessor.disconnect(); }catch(e){} tgProcessor = null; }
  if(tgAudioCtx){ try{ tgAudioCtx.close(); }catch(e){} tgAudioCtx = null; }
  if(tgStream){ tgStream.getTracks().forEach(t => t.stop()); tgStream = null; }
}


function tgStop(){
  const seconds = tgEnvWrite / tgEnvRate;
  tgTeardownAudio();
  tgListening = false;
  tgResults = tgComputeStats();
  // Silently dropping back to the start screen left no clue as to whether
  // the mic heard nothing or heard only noise — say which.
  if(!tgResults){
    tgError = seconds < 10
      ? "Not enough audio to lock onto a beat. Press the phone's mic right against the caseback and let it listen for 20–30 seconds."
      : "Couldn't find a steady beat in that. Try somewhere quieter, press the mic harder against the caseback, or raise the sensitivity.";
  }
  render();
}


function tgAbort(){
  tgTeardownAudio();
  tgListening = false;
  tgResults = null;
  tgEnvBufs = [];
  tgEnvWrite = 0;
}


// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

// The most recent `n` envelope samples of one band, oldest first.
function tgEnvSlice(band, n){
  const buf = tgEnvBufs[band];
  if(!buf) return new Float32Array(0);
  const len = buf.length;
  const count = Math.min(n, tgEnvWrite, len);
  const out = new Float32Array(count);
  const start = tgEnvWrite - count;
  for(let i=0;i<count;i++) out[i] = buf[(start + i) % len];
  return out;
}


// Averages the power envelope down to the search rate. Averaging power is
// matched filtering by another name: as long as the bin stays near the width
// of a tick, every extra sample folded in cuts the noise without touching the
// signal.
function tgDecimateMean(x, factor){
  const out = new Float32Array(Math.floor(x.length / factor));
  for(let j=0;j<out.length;j++){
    let m = 0;
    const base = j * factor;
    for(let i=0;i<factor;i++) m += x[base+i];
    out[j] = m / factor;
  }
  return out;
}


function tgMedian(x){
  const s = Array.prototype.slice.call(x).sort((a,b)=>a-b);
  if(!s.length) return 0;
  return s[Math.floor(s.length/2)];
}


function tgLsqSlope(xs, ys){
  const n = xs.length;
  let sx=0, sy=0, sxx=0, sxy=0;
  for(let i=0;i<n;i++){ sx+=xs[i]; sy+=ys[i]; sxx+=xs[i]*xs[i]; sxy+=xs[i]*ys[i]; }
  const den = n*sxx - sx*sx;
  if(den === 0) return 0;
  return (n*sxy - sx*sy) / den;
}


// Finds the beat period by autocorrelating the envelope. Correlation is what
// beats the noise here: a tick buried under the floor still correlates with
// every other tick in the recording, while noise correlates with nothing.
function tgEstimatePeriod(x, rate){
  const n = x.length;
  const minLag = Math.floor(TG_MIN_BEAT_MS / 1000 * rate);
  const maxLag = Math.ceil(TG_MAX_BEAT_MS / 1000 * rate);
  // Needs several periods of the longest candidate beat to mean anything.
  if(n < maxLag * 3) return null;

  // Mean removal first. The envelope is all-positive, so without this the
  // correlation is dominated by its DC level and every lag looks alike.
  let mean = 0;
  for(let i=0;i<n;i++) mean += x[i];
  mean /= n;
  const d = new Float32Array(n);
  for(let i=0;i<n;i++) d[i] = x[i] - mean;
  let e0 = 0;
  for(let i=0;i<n;i++) e0 += d[i]*d[i];
  if(e0 <= 0) return null;
  const norm = e0 / n;

  const r = new Float32Array(maxLag + 2);
  for(let lag=minLag; lag<=maxLag; lag++){
    let s = 0;
    const m = n - lag;
    for(let i=0;i<m;i++) s += d[i] * d[i+lag];
    r[lag] = (s / m) / norm;
  }

  // Peak-pick on a lightly smoothed copy. The correlation peak of an impulse
  // train is barely wider than one bin, so a period that falls between two
  // bins — 62.5 bins, say — splits its peak across both and reads low in
  // each, while its own second harmonic can land squarely on a bin and read
  // full. That is enough to make the harmonic win and the beat rate come back
  // doubled; it did exactly that at 48 kHz. Smoothing puts a between-bins
  // peak on equal footing with one that happens to land dead on.
  const rs = new Float32Array(maxLag + 2);
  for(let lag=minLag; lag<=maxLag; lag++){
    const a = lag > minLag ? r[lag-1] : r[lag];
    const c = lag < maxLag ? r[lag+1] : r[lag];
    rs[lag] = (a + 2*r[lag] + c) / 4;
  }

  let bi = minLag, bv = -Infinity;
  for(let lag=minLag; lag<=maxLag; lag++){ if(rs[lag] > bv){ bv = rs[lag]; bi = lag; } }
  if(bv <= 0) return null;
  const gate = tgMinCorrelation(n);

  // Walk down to the fundamental. A tick train correlates at its own period
  // and at every multiple of it — a 28800 bph watch beating every 125 ms also
  // correlates at 250, 375, 500 — and any of those can win outright. So try
  // every integer sub-multiple and take the smallest one that still
  // correlates nearly as well; halving alone would miss the 375 ms case
  // entirely, since 187.5 ms is not a beat of anything.
  for(let div=8; div>=2; div--){
    const centre = bi / div;
    if(centre < minLag) continue;
    // The correlation peak of an impulse train is only a bin or two wide, so
    // look either side of the exact sub-multiple rather than at one bin.
    let ci = Math.round(centre), cv = -Infinity;
    const lo = Math.max(minLag, Math.round(centre) - 2);
    const hi = Math.min(maxLag, Math.round(centre) + 2);
    for(let j=lo; j<=hi; j++){ if(rs[j] > cv){ cv = rs[j]; ci = j; } }
    // The candidate has to be a real peak in its own right, not merely a
    // fraction of the winner. Without that second test a faint watch gets
    // halved: the true peak is weak, so any noise bump near half its lag
    // clears 0.55x it and gets mistaken for the fundamental.
    if(cv > bv * TG_SUBHARMONIC_FRAC && cv > gate){ bi = ci; bv = cv; break; }
  }

  // Sub-bin precision from the shape of the correlation peak.
  let lag = bi;
  if(bi > minLag && bi < maxLag){
    const y0 = rs[bi-1], y1 = rs[bi], y2 = rs[bi+1];
    const den = y0 - 2*y1 + y2;
    if(den !== 0){
      const off = 0.5 * (y0 - y2) / den;
      if(Math.abs(off) <= 1) lag = bi + off;
    }
  }
  return { lag, r: bv, n };
}


// Folds one span of the envelope at `period` and returns where the tick sits
// within the fold window, in envelope samples. This is the stacking step:
// every beat in the span lands on top of every other, so the tick climbs out
// of the noise by roughly sqrt(number of beats).
//
// The phase is measured from envelope index 0, never from the start of the
// span. Folding each span against its own start looks equivalent and is not:
// consecutive spans begin at multiples of the chunk length, which is not a
// multiple of the period, so every chunk boundary injects a phase jump of
// (chunkLength mod period). That artefact is far larger than the drift this
// exists to measure, and it sent the refinement marching away from the
// answer instead of towards it.
function tgFoldPhase(env, s, e, period){
  const P = Math.ceil(period);
  if(P < 4 || e - s < period * 4) return null;
  const sum = new Float32Array(P);
  const cnt = new Float32Array(P);
  for(let i=s;i<e;i++){
    const j = Math.floor(i % period);
    sum[j] += env[i];
    cnt[j]++;
  }
  const prof = new Float32Array(P);
  for(let j=0;j<P;j++) prof[j] = cnt[j] ? sum[j] / cnt[j] : 0;
  // A light 3-bin smooth. The tick is a couple of bins wide and the profile
  // is still noisy; smoothing stops a single loud bin from winning.
  const sm = new Float32Array(P);
  for(let j=0;j<P;j++) sm[j] = (prof[(j-1+P)%P] + prof[j] + prof[(j+1)%P]) / 3;

  let bi = 0, bv = -Infinity;
  for(let j=0;j<P;j++){ if(sm[j] > bv){ bv = sm[j]; bi = j; } }
  const med = tgMedian(sm);
  if(!(bv > med)) return null;

  // Centroid of the peak above the profile's own baseline, for sub-bin
  // resolution — the drift fit downstream is only as good as this.
  let num = 0, den = 0;
  for(let dj=-2; dj<=2; dj++){
    const j = (bi + dj + P) % P;
    const w = Math.max(0, sm[j] - med);
    num += w * (bi + dj);
    den += w;
  }
  if(den <= 0) return null;
  let ph = num / den;
  ph = ((ph % P) + P) % P;
  return { phase: ph, peak: bv, floor: med };
}


// Refines the period by measuring how far the stacked tick walks across the
// fold window over the course of the recording. Fold at a period that is a
// hair too short and the tick creeps forward every cycle; the slope of that
// creep *is* the error, and it is measured over the whole recording rather
// than over one beat, which is where the precision comes from.
function tgRefinePeriod(env, period, chunkSec){
  const chunkLen = Math.max(Math.round(chunkSec * tgEnvRate), Math.round(period * 24));
  const chunks = Math.floor(env.length / chunkLen);
  // Four points is the fewest that can show whether the phase is walking in a
  // straight line or just wandering. With three, noise fits a line perfectly
  // and the rate comes back confident and wrong.
  if(chunks < 4) return null;
  const xs = [], ys = [];
  let prev = null, offset = 0;
  for(let c=0;c<chunks;c++){
    const s = c * chunkLen;
    const f = tgFoldPhase(env, s, s + chunkLen, period);
    if(!f) continue;
    let v = f.phase + offset;
    // Unwrap: the tick can walk off one edge of the fold window and reappear
    // at the other. Keep each step within half a period of the last one.
    if(prev !== null){
      while(v - prev > period/2){ offset -= period; v -= period; }
      while(v - prev < -period/2){ offset += period; v += period; }
    }
    xs.push((s + chunkLen/2) / tgEnvRate);
    ys.push(v / tgEnvRate);
    prev = v;
  }
  if(xs.length < 4) return null;
  const slope = tgLsqSlope(xs, ys);
  // Guard against a wild fit: anything past a few percent is not a watch
  // drifting, it is the unwrap having gone wrong.
  if(!isFinite(slope) || Math.abs(slope) > 0.03) return null;

  // How well the phase points actually lie on that line. This is the honest
  // measure of whether the rate means anything: a watch walks the fold window
  // steadily, so its points are nearly collinear, while a signal too faint to
  // locate within each chunk scatters. Without this check a marginal
  // recording still produced a rate — a wrong one, stated to a tenth of a
  // second a day.
  let mx=0, my=0;
  for(let i=0;i<xs.length;i++){ mx += xs[i]; my += ys[i]; }
  mx /= xs.length; my /= ys.length;
  const intercept = my - slope * mx;
  let ss = 0;
  for(let i=0;i<xs.length;i++){
    const e = ys[i] - (slope * xs[i] + intercept);
    ss += e * e;
  }
  const residual = Math.sqrt(ss / xs.length);   // seconds of phase scatter

  const refined = period / (1 - slope);
  const last = tgFoldPhase(env, (chunks-1) * chunkLen, chunks * chunkLen, refined);
  return { period: refined, phase: last ? last.phase : 0, residual, points: xs.length };
}


function tgAnalyze(){
  if(!tgEnvBufs.length) return null;
  const total = Math.min(tgEnvWrite, tgEnvBufs[0].length);
  if(total < tgEnvRate * TG_MIN_SEC) return null;

  // 1. Pick the band. Each band is scored on a capped window — the point here
  // is only to choose, and correlating every band over the full recording
  // would triple the cost of the step that is already the expensive one.
  // Bands are compared on significance rather than raw correlation, so the
  // comparison stays fair as the recording grows.
  const selLen = Math.min(total, Math.round(TG_BAND_SELECT_SEC * tgEnvRate));
  let best = null;
  for(let b=0; b<TG_BANDS.length; b++){
    const selEnv = tgEnvSlice(b, selLen);
    const e = tgEstimatePeriod(tgDecimateMean(selEnv, TG_CORR_DECIM), tgEnvRate / TG_CORR_DECIM);
    if(!e) continue;
    const sigma = e.r * Math.sqrt(e.n);
    if(!best || sigma > best.sigma) best = { band: b, sigma };
  }
  if(!best) return null;
  tgBestBand = best.band;

  // 2. Coarse period, by autocorrelating the whole recording of the winning
  // band. Correlating only the tail would throw away exactly the thing that
  // makes a faint watch findable: the noise floor of the correlation falls as
  // 1/sqrt(length), so every second kept is signal recovered.
  const env = tgEnvSlice(best.band, total);
  const envStartAbs = tgEnvWrite - env.length;
  const corrEnv = tgDecimateMean(env, TG_CORR_DECIM);
  const est = tgEstimatePeriod(corrEnv, tgEnvRate / TG_CORR_DECIM);
  if(!est) return null;
  if(est.r < tgMinCorrelation(est.n)) return null;

  let period = est.lag * TG_CORR_DECIM;
  let phase = 0;
  let fit = null;

  // 3. Refine. Each pass folds at a better period, which sharpens the stacked
  // tick, which in turn measures the drift more precisely.
  // Chunks grow with each pass. The first has to be short, because the period
  // is still only bin-accurate and a long chunk would smear the tick across
  // the whole fold window. Once the period is close, longer chunks stack more
  // beats each and locate the phase far more precisely — which is what sets
  // how faint a watch can still yield a rate.
  const durationSec = env.length / tgEnvRate;
  const schedule = [
    TG_CHUNK_SEC,
    Math.max(TG_CHUNK_SEC, durationSec / 8),
    Math.max(TG_CHUNK_SEC, durationSec / 6)
  ];
  for(let iter=0; iter<schedule.length; iter++){
    const r = tgRefinePeriod(env, period, schedule[iter]);
    if(!r) break;
    period = r.period;
    phase = r.phase;
    fit = r;
  }
  // Un-refined, the period is only as good as the correlation bin it came
  // from — hundreds of seconds a day out. Reporting that as a rate would be
  // worse than reporting nothing.
  if(!fit) return null;
  // And the fit has to be a line. A quarter of a beat of scatter means the
  // tick could not be located within the individual chunks.
  if(fit.residual * tgEnvRate > period * TG_MAX_PHASE_SCATTER) return null;

  const beatMs = period / tgEnvRate * 1000;
  if(!(beatMs > TG_MIN_BEAT_MS && beatMs < TG_MAX_BEAT_MS)) return null;

  let bestBph = TG_STANDARD_BPH[0], bestDiff = Infinity;
  TG_STANDARD_BPH.forEach(b => {
    const diff = Math.abs(3600000 / b - beatMs);
    if(diff < bestDiff){ bestDiff = diff; bestBph = b; }
  });
  const nominalMs = 3600000 / bestBph;
  // No real watch is 3% off its own beat rate. If the measurement is, we
  // locked onto something that isn't an escapement.
  if(Math.abs(beatMs - nominalMs) / nominalMs > 0.03) return null;

  const secPerDay = (nominalMs - beatMs) / nominalMs * 86400;
  // No mechanical watch, however badly damaged, runs a full percent off its
  // own rate — that is minutes a day. The correlation significance test
  // guards against pure white noise, but a phone held in the hand also picks
  // up its holder's own tremor, and human hand tremor sits at roughly 4–12 Hz
  // — 240–720 bpm, which folds onto exactly the 18000–28800 bph range most
  // watches use. That is a real periodic signal, not noise, so the
  // significance test alone cannot rule it out; this bound catches what it
  // misses; by rejecting the reading outright instead of reporting it.
  if(Math.abs(secPerDay) > TG_MAX_PLAUSIBLE_SPD) return null;

  // 4. Beat error: fold at the full tick-tock cycle and measure how unevenly
  // the two impulses are spaced.
  let beatErrorMs = 0;
  const dbl = tgFoldPhase(env, 0, env.length, period * 2);
  if(dbl){
    const P2 = Math.ceil(period * 2);
    const sum = new Float32Array(P2), cnt = new Float32Array(P2);
    for(let i=0;i<env.length;i++){
      const j = Math.floor(i % (period * 2));
      sum[j] += env[i]; cnt[j]++;
    }
    const prof = new Float32Array(P2);
    for(let j=0;j<P2;j++) prof[j] = cnt[j] ? sum[j]/cnt[j] : 0;
    const a = Math.round(dbl.phase);
    // The companion impulse lives in the opposite half of the cycle.
    let bIdx = a, bVal = -Infinity;
    const lo = Math.round(period * 0.4), hi = Math.round(period * 1.6);
    for(let d=lo; d<=hi; d++){
      const j = (a + d) % P2;
      if(prof[j] > bVal){ bVal = prof[j]; bIdx = a + d; }
    }
    const gap = (bIdx - a) / tgEnvRate * 1000;
    beatErrorMs = Math.abs(gap - (2 * beatMs - gap));
    if(!isFinite(beatErrorMs) || beatErrorMs > beatMs) beatErrorMs = 0;
  }
  // A real escapement's tick and tock are close to symmetric; even a poorly
  // regulated one rarely shows more than a handful of milliseconds. Beat
  // error approaching half the beat interval means the "companion impulse"
  // search above found something roughly as strong on both sides — i.e.
  // there was no real tick/tock alternation to measure, and what got folded
  // is not an escapement.
  if(beatErrorMs > beatMs * TG_MAX_BEAT_ERROR_FRAC) return null;

  // 5. Lock quality, and how many beats went into the stack.
  const whole = tgFoldPhase(env, 0, env.length, period);
  const beats = Math.floor(env.length / period);
  const snrDb = whole && whole.floor > 0
    ? 20 * Math.log10(Math.max(whole.peak, 1e-9) / whole.floor)
    : 0;
  // The stack has to actually stand above the folded floor. A watch's tick
  // has real support at every point in the stack, so even a faint one clears
  // this by several dB once enough beats are folded in; a quasi-periodic
  // source like tremor mostly cancels itself out under folding and rarely
  // does, which is what lets this catch the handful of false locks the rate
  // and beat-error bounds above let through.
  if(snrDb < TG_MIN_SNR_DB) return null;

  // Re-anchor the blinking dot to the beat we just measured.
  tgLockPeriodMs = beatMs;
  if(tgStartWallClock){
    const tickEnvAbs = envStartAbs + phase;
    tgLockAnchorMs = tgStartWallClock + tickEnvAbs / tgEnvRate * 1000;
  }

  return {
    bph: bestBph,
    secPerDay,
    beatErrorMs,
    snrDb,
    lock: est.r,
    band: TG_BANDS[best.band].label,
    beats,
    seconds: env.length / tgEnvRate
  };
}


function tgComputeStats(){
  return tgAnalyze();
}


// Maps an envelope level onto the meter: 0% at -60 dB, 100% at full scale.
function tgLevelPct(v){
  const db = 20 * Math.log10(Math.max(v, 1e-6));
  return Math.max(0, Math.min(100, Math.round((db + 60) / 60 * 100)));
}


function tgRefreshLiveDisplay(){
  const elCount = document.getElementById('tgTickCount');
  if(!elCount) return;
  const elElapsed = document.getElementById('tgElapsed');
  if(elElapsed && tgStartWallClock){
    elElapsed.textContent = Math.floor((Date.now()-tgStartWallClock)/1000) + 's';
  }

  // Live mic level meter, on a decibel scale. A linear one was the reason
  // the meter looked dead: a perfectly usable tick 40 dB down from full
  // scale is 1% of the bar's width and invisible.
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
    elThreshold.style.left = tgLevelPct(tgNoiseFloor) + '%';
  }

  const elPeakHold = document.getElementById('tgPeakHold');
  const elRawHint = document.getElementById('tgRawHint');
  if(elPeakHold){
    const db = 20 * Math.log10(Math.max(tgRawPeakHold, 1e-9));
    elPeakHold.textContent = tgRawPeakHold > 0 ? db.toFixed(0) + ' dB' : '—';
    // Below -70 dB is at the noise floor of the input itself — essentially
    // digital silence. If a few seconds in the loudest thing the raw,
    // unfiltered signal has seen is still down there, no amount of tapping
    // near the phone has registered, and the problem is upstream of any of
    // the filtering or detection logic: the OS or browser isn't delivering
    // real audio on this input at all (permission granted to the wrong
    // device, a muted input, or — on some Macs — hardware-level noise
    // suppression eating transients before they ever reach the page).
    const elapsed = tgStartWallClock ? (Date.now() - tgStartWallClock) / 1000 : 0;
    if(elRawHint){
      elRawHint.textContent = (elapsed > 4 && db < -70)
        ? "The mic isn't registering any sound at all, even unfiltered — tap near it and watch the number above. If it never moves, the OS may be muting or over-processing this input rather than the app."
        : '';
    }
  }

  const stats = tgComputeStats();
  elCount.textContent = stats ? Math.round(stats.lock * 100) + '%' : '—';
  if(!stats) tgLockPeriodMs = 0;
  const elLive = document.getElementById('tgLiveStats');
  // Clearing this when the lock drops matters, not just cosmetically: a
  // watch's actual rate does not change between refreshes, but the room does
  // — a bad reading (hand tremor, a passing noise) can win one analysis and
  // lose the next. Leaving the old numbers up while "lock" simultaneously
  // reads "—" contradicts itself and, worse, makes a rejected reading look
  // like a result the user might act on.
  if(elLive) elLive.innerHTML = stats ? tgFormatStatsHtml(stats, true) : '';
}
