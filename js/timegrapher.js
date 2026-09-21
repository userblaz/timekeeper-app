// Timegrapher tab: mic-based tick detection (experimental).
// Known limitation: iOS Safari applies mic gain compression (AGC) that
// can't be disabled from JS, which limits accuracy on iPhone specifically.
// This whole file is the boundary to swap for a native audio module later.
//
// Capture is one plain mono channel, filtered into bands entirely in JS
// (tgMakeBandFilters/tgBiquadStep) rather than via WebAudio's own
// BiquadFilterNodes merged into a multi-channel stream — that combination
// (several filter chains combined with a ChannelMergerNode into one
// multi-channel ScriptProcessorNode) is a known Safari/WebKit weak spot
// where channels can silently collapse, duplicate, or drop, and it
// produced exactly that symptom: loud transients still registered, but a
// genuinely quiet, held-still tick — on caseback, not just glass — never
// produced so much as a raw flash, on a phone where a reference app read
// cleanly. A single mono channel has nothing for that routing to get
// wrong.
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
const TG_SUBHARMONIC_FRAC = 0.65;
// The walk-down below checks up to 7 candidate divisors (8 down to 2) per
// call — a multiple-comparisons problem the plain significance gate
// (tgMinCorrelation, calibrated for a single test) wasn't accounting for.
// Confirmed against a real reading: a watch independently measured at
// 21600 bph (166.7ms) came back from this walk-down as ~54ms — not a
// clean fraction of 166.7ms at all, just a noise fluctuation at one of
// the seven checked positions that happened to clear the single-test
// gate. Multiplying the gate up here for this check specifically (not
// touched anywhere else) cuts down how often chance alone hands one of
// those seven checks a pass, while a real harmonic multiple — genuinely
// strong at every sub-position — still clears it easily.
const TG_SUBHARMONIC_GATE_MULT = 1.8;
// Dividing by exactly 2 gets its own, more lenient bar, separate from
// TG_SUBHARMONIC_FRAC/TG_SUBHARMONIC_GATE_MULT above. Confirmed against a
// second real reading: a watch whose tick and tock are audibly different
// loudness correlates *more strongly* at twice its true beat period than
// at the true period itself — matching every other beat only ever
// compares the louder half against itself, cleaner than matching tick
// against tock does — so the strict bar (raised specifically to stop a
// coincidental noise match at one of seven checked positions) was also
// rejecting this completely different, genuinely common situation: a
// real watch, correctly and repeatably measured at exactly half its
// actual rate. Halving is by far the single most common real-world
// harmonic confusion and the one position (of the seven checked) least
// likely to be a coincidence, so it doesn't need the same multiple-
// comparisons caution the other six do.
const TG_SUBHARMONIC_FRAC_HALF = 0.35;
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
let tgBandFilters = [];  // one JS biquad chain per band — see tgMakeBandFilters
// Which gate inside tgAnalyze rejected the most recent attempt, and how
// close it came — set right before every early `return null` in tgAnalyze,
// read by the diagnostic recording's own display (tgDiagHtml) so "no lock"
// says something more useful than that alone. Live listening doesn't show
// this (it would just flicker through gates as the recording grows), but
// nothing stops it from being read there too later.
let tgLastFailReason = '';

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
    <div class="section" style="margin-top:0;padding-top:0;border-top:none;">
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
    ${tgDiagHtml()}
  </div>`;
}

// --- Diagnostic: record, play it back, and analyze it offline ------------
// Confirmed (by ear) that the mic does capture the tick — so this is no
// longer just "can you hear it": it now also decodes the same recording
// and runs it through the exact same band-filter/envelope/autocorrelation
// pipeline tgAnalyze uses for live listening, but offline, on an exact,
// complete buffer with none of a live ScriptProcessor callback's own
// timing jitter or buffer gaps to muddy the result. That separates two
// very different problems that "can you hear it" alone can't: a real but
// faint signal the analysis simply isn't sensitive enough for yet (fixable
// by tuning), versus something specific to the live-streaming path itself
// (a different fix entirely). 25 seconds, not the original 8 — the
// drift-refinement step (tgRefinePeriod) structurally needs at least
// ~20 seconds of audio to produce any result at all regardless of how
// strong the signal is (it requires 4 chunks of a few beat-periods each),
// so an 8-second clip was guaranteed to come back empty on its own,
// independent of anything about signal quality.
let tgDiagRecording = false;
let tgDiagUrl = null;
let tgDiagSecondsLeft = 0;
let tgDiagTimer = null;
let tgDiagStream = null;
let tgDiagRecorder = null;
let tgDiagError = null;
let tgDiagAnalysis = null; // { peakDb, rmsDb, durationSec, stats } | { error } | null (still analyzing)
let tgDiagExt = 'webm'; // file extension matching whatever mime type actually got used
const TG_DIAG_SECONDS = 25;

function tgDiagHtml(){
  if(tgDiagError){
    return `<p class="hint" style="text-align:center;color:var(--accent);margin-top:10px;">${escapeHtml(tgDiagError)}</p>`;
  }
  if(tgDiagRecording){
    return `<p class="hint" style="text-align:center;margin-top:10px;">Recording… <span id="tgDiagCountdown">${tgDiagSecondsLeft}s</span> left — hold the mic to the watch now.</p>`;
  }
  if(tgDiagUrl){
    const a = tgDiagAnalysis;
    const analysisHtml = !a ? '<p class="hint" style="margin-top:8px;">Analyzing the recording…</p>'
      : a.error ? `<p class="hint" style="margin-top:8px;color:var(--accent);">${escapeHtml(a.error)}</p>`
      : `
        <div class="tg-stat-row"><span>Peak level in this clip</span><b>${a.peakDb.toFixed(0)} dB</b></div>
        <div class="tg-stat-row"><span>Noise floor (RMS)</span><b>${a.rmsDb.toFixed(0)} dB</b></div>
        <div class="tg-stat-row"><span>Duration analyzed</span><b>${a.durationSec.toFixed(1)}s</b></div>
        <div class="tg-stat-row"><span>Found a lock?</span><b style="color:${a.stats ? 'var(--good)' : 'var(--accent)'}">${a.stats ? `Yes — ${a.stats.bph} bph` : 'No'}</b></div>
        ${a.stats ? `<div class="tg-stat-row"><span>Lock strength</span><b>${Math.round(a.stats.lock*100)}%</b></div>` : ''}
        ${a.failReason ? `<p class="hint" style="margin-top:6px;">${escapeHtml(a.failReason)}</p>` : ''}
      `;
    return `
      <div style="margin-top:10px;text-align:center;">
        <audio controls src="${tgDiagUrl}" style="width:100%;"></audio>
        <p class="hint" style="margin:6px 0;">Can you hear the tick in this? That tells us whether the mic captured it, separately from whether the analysis below found it.</p>
        ${analysisHtml}
        <a href="${tgDiagUrl}" download="timegrapher-test.${tgDiagExt}" class="manual-link" style="display:inline-block;margin-top:6px;">Save this recording to send along</a><br/>
        <button type="button" class="manual-link" data-action="tgdiagstart" style="margin-top:6px;">Record again</button>
      </div>`;
  }
  return `<button type="button" class="btn-secondary" data-action="tgdiagstart" style="width:100%;margin-top:8px;">Record ${TG_DIAG_SECONDS}s & play it back (diagnostic)</button>`;
}

async function tgDiagStart(){
  tgDiagError = null;
  tgDiagAnalysis = null;
  if(tgDiagUrl){ URL.revokeObjectURL(tgDiagUrl); tgDiagUrl = null; }
  let stream;
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1 }
    });
  }catch(e){
    tgDiagError = "Couldn't access the microphone.";
    render();
    return;
  }
  tgDiagStream = stream;
  // Safari's MediaRecorder support is real but picky about mime types —
  // ask for whatever it actually supports rather than assuming webm,
  // which iOS doesn't have.
  const candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'];
  let mimeType = '';
  for(const c of candidates){
    if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)){ mimeType = c; break; }
  }
  try{
    tgDiagRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  }catch(e){
    tgDiagError = "This browser can't record audio for playback.";
    stream.getTracks().forEach(t => t.stop());
    tgDiagStream = null;
    render();
    return;
  }
  const chunks = [];
  tgDiagRecorder.ondataavailable = (e) => { if(e.data && e.data.size) chunks.push(e.data); };
  tgDiagRecorder.onstop = async () => {
    const usedType = tgDiagRecorder.mimeType || 'audio/webm';
    tgDiagExt = usedType.includes('mp4') ? 'm4a' : usedType.includes('ogg') ? 'ogg' : 'webm';
    const blob = new Blob(chunks, { type: usedType });
    tgDiagUrl = URL.createObjectURL(blob);
    if(tgDiagStream){ tgDiagStream.getTracks().forEach(t => t.stop()); tgDiagStream = null; }
    tgDiagRecording = false;
    render();
    try{
      const arrayBuffer = await blob.arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const decodeCtx = new Ctx();
      const audioBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
      tgDiagAnalysis = tgAnalyzeRecording(audioBuffer);
      try{ decodeCtx.close(); }catch(e2){}
    }catch(e){
      tgDiagAnalysis = { error: "Couldn't decode this recording to analyze it: " + (e && e.message || e) };
    }
    render();
  };
  tgDiagRecorder.start();
  tgDiagRecording = true;
  tgDiagSecondsLeft = TG_DIAG_SECONDS;
  render();
  tgDiagTimer = setInterval(() => {
    tgDiagSecondsLeft--;
    if(tgDiagSecondsLeft <= 0){
      clearInterval(tgDiagTimer);
      tgDiagTimer = null;
      if(tgDiagRecorder && tgDiagRecorder.state !== 'inactive') tgDiagRecorder.stop();
    } else {
      const el = document.getElementById('tgDiagCountdown');
      if(el) el.textContent = tgDiagSecondsLeft + 's';
    }
  }, 1000);
}

// Runs a decoded recording through the exact same per-sample filter/
// envelope pipeline tgProcessAudioBlock uses live (tgBandFilters/tgBiquadStep),
// in one pass over the whole buffer rather than callback-sized chunks,
// then the same tgAnalyze used for a live lock. Reuses the module-level
// capture state (tgEnvBufs, tgBandFilters, ...) — safe here since this
// only ever runs from the idle Timegrapher screen, never while a live
// listen (tgListening) is in progress.
function tgAnalyzeRecording(audioBuffer){
  const pcm = audioBuffer.getChannelData(0);
  const sr = audioBuffer.sampleRate;
  tgSampleRate = sr;
  tgResetCapture();
  const nb = TG_BANDS.length;
  let peak = 0, sumSq = 0;
  for(let i=0;i<pcm.length;i++){
    const x = pcm[i];
    for(let b=0;b<nb;b++){
      const bf = tgBandFilters[b];
      let v = tgBiquadStep(bf.hp1, x);
      v = tgBiquadStep(bf.hp2, v);
      v = tgBiquadStep(bf.lp, v);
      v *= TG_PREAMP;
      tgDecimSumSq[b] += v * v;
    }
    const a = Math.abs(x);
    if(a > peak) peak = a;
    sumSq += x * x;
    if(a > tgDecimPeak) tgDecimPeak = a;
    if(++tgDecimCount >= tgDecim){
      const slot = tgEnvWrite % tgEnvBufs[0].length;
      for(let b=0;b<nb;b++){ tgEnvBufs[b][slot] = tgDecimSumSq[b] / tgDecim; tgDecimSumSq[b] = 0; }
      tgEnvWrite++;
      tgDecimPeak = 0;
      tgDecimCount = 0;
    }
  }
  const rms = Math.sqrt(sumSq / pcm.length);
  const stats = tgAnalyze();
  return {
    peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
    rmsDb: 20 * Math.log10(Math.max(rms, 1e-9)),
    durationSec: pcm.length / sr,
    stats,
    failReason: stats ? '' : tgLastFailReason
  };
}


function tgFormatStatsHtml(stats, isLive){
  const sign = stats.secPerDay >= 0 ? '+' : '';
  const lockPct = Math.round(stats.lock * 100);
  const lockLabel = stats.lock < 0.15 ? '(faint — get closer)' : stats.lock < 0.35 ? '(ok)' : '(solid)';
  return `
    <div class="tg-stat-row"><span>Detected beat rate</span><b>${stats.bph} bph</b></div>
    <div class="tg-stat-row"><span>Rate</span><b style="color:${stats.secPerDay>=0?'var(--good)':'var(--bad)'}">${sign}${stats.secPerDay.toFixed(1)} s/day</b></div>
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
  // A single plain mono tap, filtered entirely in JS (tgProcessAudioBlock/
  // tgMakeBandFilters below) rather than the WebAudio graph. This used to
  // run three BiquadFilterNode chains in parallel and combine them with a
  // fourth, unfiltered tap into one 4-channel stream via a
  // ChannelMergerNode feeding a single multi-channel ScriptProcessorNode —
  // and that specific combination (multiple filter chains merged into one
  // multi-channel ScriptProcessorNode) is a known weak spot in Safari/
  // WebKit, where channels can silently collapse, duplicate, or drop
  // instead of each carrying its own real signal. A single mono channel
  // has nothing to merge and nothing for WebKit's channel routing to get
  // wrong; every band's filtering now happens on plain sample arrays, in
  // ordinary JS, where "does this number look right" can actually be
  // checked.
  //
  // The node feeding that JS is AudioWorkletNode, not ScriptProcessorNode
  // — confirmed, not just suspected, by the diagnostic recording (which
  // captures via MediaRecorder and analyzes an already-complete buffer,
  // bypassing any live node entirely): once the analysis itself was
  // locking correctly offline, live listening still found nothing, which
  // narrows the remaining problem specifically to *this* node. Deprecated
  // and long known to be unreliable on Safari/iOS — it runs on the main
  // thread and is vulnerable to being starved by layout, GC, or anything
  // else competing for that thread, which reads as exactly "the mic hears
  // nothing" from here. AudioWorkletNode runs its process() callback on a
  // dedicated, high-priority audio rendering thread instead, which is the
  // whole reason it replaced ScriptProcessorNode in the spec. Falls back
  // to ScriptProcessorNode only if AudioWorklet itself isn't available at
  // all (very old browsers) — worklet code lives in TG_WORKLET_SRC below,
  // loaded from a Blob URL rather than a separate file so there's nothing
  // new to add to index.html's own script list.
  let node;
  try{
    if(!tgAudioCtx.audioWorklet) throw new Error('no AudioWorklet support');
    const workletBlob = new Blob([TG_WORKLET_SRC], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(workletBlob);
    try{
      await tgAudioCtx.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    node = new AudioWorkletNode(tgAudioCtx, 'tg-capture-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1]
    });
    node.port.onmessage = (e) => tgProcessAudioBlock(e.data);
  }catch(e){
    node = tgAudioCtx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (ev) => tgProcessAudioBlock(ev.inputBuffer.getChannelData(0));
  }
  const silentGain = tgAudioCtx.createGain(); silentGain.gain.value = 0;
  source.connect(node);
  node.connect(silentGain); silentGain.connect(tgAudioCtx.destination);
  tgProcessor = node;
  tgResetCapture();
  tgListening = true;
  render();
  tgScheduleRefresh(0);
  tgDotRaf = requestAnimationFrame(tgDotLoop);
}

// The AudioWorkletProcessor itself, as source text — registered via a
// Blob URL (see tgStart) rather than shipped as its own file. process()
// runs on the audio rendering thread on every quantum (128 samples,
// standard across browsers) and buffers them up to the same 1024-sample
// blocks tgProcessAudioBlock always expected from the old
// ScriptProcessorNode, so nothing downstream needed to change for the
// switch. Returning true keeps the node alive for the life of the
// AudioContext; this never writes to its outputs, which is fine — it's
// only ever connected through to destination via a silent gain to keep
// the graph pulled, same as the old node was.
const TG_WORKLET_SRC = `
class TgCaptureProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.bufSize = 1024;
    this.buf = new Float32Array(this.bufSize);
    this.pos = 0;
  }
  process(inputs){
    const input = inputs[0];
    const ch = input && input[0];
    if(!ch) return true;
    for(let i=0;i<ch.length;i++){
      this.buf[this.pos++] = ch[i];
      if(this.pos >= this.bufSize){
        this.port.postMessage(this.buf.slice(0, this.pos));
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('tg-capture-processor', TgCaptureProcessor);
`;


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


// A textbook RBJ-cookbook biquad, computed and applied by hand in plain
// JS rather than via a WebAudio BiquadFilterNode — see the comment in
// tgStart on why this moved out of the audio graph entirely. Q = 1/√2
// (Butterworth, maximally flat) matches what a single BiquadFilterNode
// defaults to, so the band shape is the same as before; only where the
// math runs changed.
function tgMakeBiquad(type, freq, sampleRate){
  const f = Math.max(10, Math.min(freq, sampleRate / 2 - 10));
  const w0 = 2 * Math.PI * f / sampleRate;
  const cosw0 = Math.cos(w0), sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Math.SQRT1_2);
  let b0, b1, b2, a0, a1, a2;
  if(type === 'highpass'){
    b0 = (1 + cosw0) / 2; b1 = -(1 + cosw0); b2 = (1 + cosw0) / 2;
  } else {
    b0 = (1 - cosw0) / 2; b1 = 1 - cosw0; b2 = (1 - cosw0) / 2;
  }
  a0 = 1 + alpha; a1 = -2 * cosw0; a2 = 1 - alpha;
  return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function tgBiquadStep(f, x){
  const y = f.b0*x + f.b1*f.x1 + f.b2*f.x2 - f.a1*f.y1 - f.a2*f.y2;
  f.x2 = f.x1; f.x1 = x;
  f.y2 = f.y1; f.y1 = y;
  return y;
}
// One band's filter chain — two cascaded high-passes (one biquad rolls
// off at 12 dB/octave, which still lets plenty of noise through right
// below the corner; doubling it up gets the band genuinely clean) then a
// low-pass, the same topology the old WebAudio node chain used.
function tgMakeBandFilters(sampleRate){
  const nyquist = sampleRate / 2 - 500;
  return TG_BANDS.map(band => ({
    hp1: tgMakeBiquad('highpass', band.lo, sampleRate),
    hp2: tgMakeBiquad('highpass', band.lo, sampleRate),
    lp: tgMakeBiquad('lowpass', Math.min(band.hi, nyquist), sampleRate)
  }));
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
  tgBandFilters = tgMakeBandFilters(tgSampleRate);
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
  dot.style.background = 'var(--good)';
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
  dot.style.background = 'var(--grey)';
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
// Takes a plain Float32Array of mono samples — from either the
// AudioWorkletNode's postMessage (tgStart's preferred path) or the
// ScriptProcessorNode fallback's onaudioprocess (older browsers without
// AudioWorklet support). Both hand this the same shape, so everything
// below is identical either way.
function tgProcessAudioBlock(raw){
  const nb = TG_BANDS.length;
  const len = raw.length;
  let bufferPeak = 0;
  let rawPeak = 0;
  let bufferSum = 0;
  for(let i=0;i<len;i++){
    const x = raw[i];
    for(let b=0;b<nb;b++){
      const bf = tgBandFilters[b];
      let v = tgBiquadStep(bf.hp1, x);
      v = tgBiquadStep(bf.hp2, v);
      v = tgBiquadStep(bf.lp, v);
      v *= TG_PREAMP;
      tgDecimSumSq[b] += v * v;
    }
    // The meter, the noise-floor marker and the "is the mic alive at all"
    // readout all follow this raw, unfiltered, un-preamped signal — not any
    // of the analysis bands above. That distinction matters: a filtered
    // band reading zero could mean a dead mic, or could just mean the tick
    // fell in a different band, and those look identical unless something
    // bypasses the filters entirely.
    const a = Math.abs(x);
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
  if(tgProcessor){
    tgProcessor.onaudioprocess = null;
    if(tgProcessor.port){ try{ tgProcessor.port.onmessage = null; }catch(e){} }
    try{ tgProcessor.disconnect(); }catch(e){}
    tgProcessor = null;
  }
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
    // clears the bar and gets mistaken for the fundamental. div===2 gets
    // its own, more lenient bar — see TG_SUBHARMONIC_FRAC_HALF above.
    const fracNeeded = div === 2 ? TG_SUBHARMONIC_FRAC_HALF : TG_SUBHARMONIC_FRAC;
    const gateMult = div === 2 ? 1 : TG_SUBHARMONIC_GATE_MULT;
    if(cv > bv * fracNeeded && cv > gate * gateMult){ bi = ci; bv = cv; break; }
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


// Steps 2-5 of the old tgAnalyze, for one specific band: coarse period,
// refine, plausibility gates, beat error, SNR. Split out so tgAnalyze can
// try more than one band instead of committing entirely to whichever one
// won step 1's significance contest — see the comment on that loop below
// for why that matters. Sets tgLastFailReason and returns null on any
// gate failure, exactly as the inlined version used to.
function tgAnalyzeBand(bandIdx, total){
  // 2. Coarse period, by autocorrelating the whole recording of this band.
  // Correlating only the tail would throw away exactly the thing that
  // makes a faint watch findable: the noise floor of the correlation falls
  // as 1/sqrt(length), so every second kept is signal recovered.
  const env = tgEnvSlice(bandIdx, total);
  const envStartAbs = tgEnvWrite - env.length;
  const corrEnv = tgDecimateMean(env, TG_CORR_DECIM);
  const est = tgEstimatePeriod(corrEnv, tgEnvRate / TG_CORR_DECIM);
  if(!est){ tgLastFailReason = 'Lost the candidate period when re-checking it over the full recording.'; return null; }
  if(est.r < tgMinCorrelation(est.n)){
    const need = tgMinCorrelation(est.n);
    tgLastFailReason = `Found a weak periodic candidate, but it wasn’t statistically significant enough yet (correlation ${est.r.toFixed(3)}, needed ${need.toFixed(3)} at this length — longer listening or a quieter room would help).`;
    return null;
  }

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
  //
  // On a shorter recording (a 25-30s diagnostic clip, say) the /8 and /6
  // passes below collapse to the same TG_CHUNK_SEC floor as the first pass
  // — durationSec/8 and durationSec/6 only exceed 5s once duration passes
  // 40s and 30s respectively — so what looks like three escalating passes
  // is really one 5-second chunk size tried three times. For a strong
  // signal that's fine; for a faint one, each individual 5s chunk (a few
  // dozen beats) may simply not have enough of its own SNR for
  // tgFoldPhase to locate a peak, even though the *whole* recording
  // correlated well enough to get this far — the final durationSec/4 pass
  // exists specifically for that case: the largest chunk tgRefinePeriod's
  // own 4-chunk minimum still allows, trading away fit-line resolution
  // (the least useful thing to have on a faint recording anyway) for the
  // most per-chunk SNR any schedule here can offer.
  const durationSec = env.length / tgEnvRate;
  const schedule = [
    TG_CHUNK_SEC,
    Math.max(TG_CHUNK_SEC, durationSec / 8),
    Math.max(TG_CHUNK_SEC, durationSec / 6),
    durationSec / 4
  ];
  // A pass that fails to produce enough usable chunks no longer aborts
  // the whole refinement outright — it used to `break` here, which meant
  // a failed *first* pass (the most likely one to fail on a faint signal,
  // being the finest-grained) silently skipped every later, coarser pass
  // that might have succeeded. Trying every scheduled size and keeping
  // whichever succeeded is strictly better: a later failure can only ever
  // leave `fit` at its last successful value, never make a working result
  // worse.
  for(let iter=0; iter<schedule.length; iter++){
    const r = tgRefinePeriod(env, period, schedule[iter]);
    if(!r) continue;
    period = r.period;
    phase = r.phase;
    fit = r;
  }
  // Un-refined, the period is only as good as the correlation bin it came
  // from — hundreds of seconds a day out. Reporting that as a rate would be
  // worse than reporting nothing.
  if(!fit){
    tgLastFailReason = 'Found a candidate period, but couldn’t refine it into a steady rate — the recording may be too short (needs ~20s+) or the tick too faint to locate within each chunk.';
    return null;
  }
  // And the fit has to be a line. A quarter of a beat of scatter means the
  // tick could not be located within the individual chunks.
  if(fit.residual * tgEnvRate > period * TG_MAX_PHASE_SCATTER){
    const scatterFrac = (fit.residual * tgEnvRate) / period;
    tgLastFailReason = `Found a period, but its timing scattered too much across the recording to trust (${(scatterFrac*100).toFixed(0)}% of a beat, needed under ${(TG_MAX_PHASE_SCATTER*100).toFixed(0)}%) — the tick is too faint or inconsistent to pin down precisely yet.`;
    return null;
  }

  const beatMs = period / tgEnvRate * 1000;
  if(!(beatMs > TG_MIN_BEAT_MS && beatMs < TG_MAX_BEAT_MS)){
    tgLastFailReason = `Measured beat interval (${beatMs.toFixed(0)}ms) is outside any real watch’s range.`;
    return null;
  }

  let bestBph = TG_STANDARD_BPH[0], bestDiff = Infinity;
  TG_STANDARD_BPH.forEach(b => {
    const diff = Math.abs(3600000 / b - beatMs);
    if(diff < bestDiff){ bestDiff = diff; bestBph = b; }
  });
  const nominalMs = 3600000 / bestBph;
  // No real watch is 3% off its own beat rate. If the measurement is, we
  // locked onto something that isn't an escapement.
  if(Math.abs(beatMs - nominalMs) / nominalMs > 0.03){
    tgLastFailReason = `Measured rate (${beatMs.toFixed(1)}ms/beat) is too far from any standard beat rate to be a real watch.`;
    return null;
  }

  const secPerDay = (nominalMs - beatMs) / nominalMs * 86400;
  // No mechanical watch, however badly damaged, runs a full percent off its
  // own rate — that is minutes a day. The correlation significance test
  // guards against pure white noise, but a phone held in the hand also picks
  // up its holder's own tremor, and human hand tremor sits at roughly 4–12 Hz
  // — 240–720 bpm, which folds onto exactly the 18000–28800 bph range most
  // watches use. That is a real periodic signal, not noise, so the
  // significance test alone cannot rule it out; this bound catches what it
  // misses; by rejecting the reading outright instead of reporting it.
  if(Math.abs(secPerDay) > TG_MAX_PLAUSIBLE_SPD){
    tgLastFailReason = `Measured rate was implausibly far off (${secPerDay.toFixed(0)} s/day) — likely hand tremor or another periodic noise, not the watch. Try resting the watch and phone still instead of holding them.`;
    return null;
  }

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
  if(beatErrorMs > beatMs * TG_MAX_BEAT_ERROR_FRAC){
    tgLastFailReason = 'Found a steady periodic rate, but the tick/tock pattern didn’t look like a real escapement.';
    return null;
  }

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
  if(snrDb < TG_MIN_SNR_DB){
    tgLastFailReason = `Found a steady, plausible beat rate (${bestBph} bph), but the stacked tick was only ${snrDb.toFixed(1)}dB above the folded noise floor (needed ${TG_MIN_SNR_DB}dB) — very close. A bit more time listening, or getting the mic closer to the caseback, would likely tip this over.`;
    return null;
  }

  // Re-anchor the blinking dot to the beat we just measured.
  tgBestBand = bandIdx;
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
    band: TG_BANDS[bandIdx].label,
    beats,
    seconds: env.length / tgEnvRate
  };
}

// Picks a band and runs the full pipeline on it, same as this used to do
// inline for a single winner — except now every band with a plausible
// coarse candidate gets tried, most-significant first, and a band whose
// full analysis fails a later plausibility gate falls through to the
// next one instead of giving up outright. That distinction matters
// specifically when a real, narrowband noise source (electrical hum, a
// fan, anything with genuine — not random — periodicity) sits in one
// band and is statistically *more* significant there than a faint watch
// tick is in a different band: step 1 alone would hand that noise the
// win and never even look at the band the watch is actually in. Confirmed
// against a real reading: an independently-known 21600 bph watch kept
// coming back with an implausible ~54ms period even after tightening the
// subharmonic-walkdown gate, meaning the winning band's own strongest
// candidate genuinely wasn't the watch — it needed a different band tried
// at all, not a stricter check within the wrong one.
function tgAnalyze(){
  tgLastFailReason = '';
  if(!tgEnvBufs.length){ tgLastFailReason = 'No audio captured yet.'; return null; }
  const total = Math.min(tgEnvWrite, tgEnvBufs[0].length);
  if(total < tgEnvRate * TG_MIN_SEC){ tgLastFailReason = 'Not enough audio yet.'; return null; }

  // 1. Rank every band with a plausible coarse candidate by significance,
  // rather than keeping only the single winner — see the function comment
  // above for why the rest of this needs more than one shot.
  const selLen = Math.min(total, Math.round(TG_BAND_SELECT_SEC * tgEnvRate));
  const candidates = [];
  for(let b=0; b<TG_BANDS.length; b++){
    const selEnv = tgEnvSlice(b, selLen);
    const e = tgEstimatePeriod(tgDecimateMean(selEnv, TG_CORR_DECIM), tgEnvRate / TG_CORR_DECIM);
    if(!e) continue;
    candidates.push({ band: b, sigma: e.r * Math.sqrt(e.n) });
  }
  if(!candidates.length){ tgLastFailReason = 'No periodic signal found in any frequency band — the room may be as loud as the tick, or the mic isn’t picking up the escapement at all.'; return null; }
  candidates.sort((a, b) => b.sigma - a.sigma);

  let firstFailReason = '';
  for(let i=0; i<candidates.length; i++){
    const result = tgAnalyzeBand(candidates[i].band, total);
    if(result) return result;
    // Keep the most-significant band's own failure reason to report if
    // every band ultimately fails — it's the most likely explanation,
    // and a later, weaker band's reason (often just "not significant
    // enough") is usually less informative than the first one's.
    if(!firstFailReason) firstFailReason = tgLastFailReason;
  }
  tgLastFailReason = firstFailReason;
  return null;
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
