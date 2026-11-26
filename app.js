import { BioDSP } from './dsp.js';
import { BioTransport } from './transport.js';
import { BioRenderer } from './renderer.js';

const dsp = new BioDSP(250, 64);
const scopeCanvas = document.getElementById('scopeCanvas');
const renderer = new BioRenderer(
  scopeCanvas,
  document.getElementById('morphCanvas'),
  document.getElementById('fftCanvas'),
  document.getElementById('waterfallCanvas')
);

let windowSize = 512;
let filteredBuffer = new Array(windowSize).fill(128);
let rawBuffer = new Array(windowSize).fill(128);

let latestSpectrum = {
  magnitudes: new Float32Array(32),
  peakHold: new Float32Array(32),
  dominantFreq: '0.0',
  medianFreq: '0.0',
  medianFreqNum: 0,
  mdfHistory: [],
};

let latestTimeMetrics = {
  vpp: '0.00',
  rms: '0.00',
  bpm: '--',
  bpmNum: 0,
  rrStdDev: 0,
  isLeadOff: false,
  liveBeat: new Float32Array(48).fill(0.25),
  mitBihTemplate: dsp.mitBihTemplate,
  correlationPct: 0,
};

let currentMode = 'ECG';
let currentGain = 1.0;
let currentAlert = 0;
let isPaused = false;
let audioEnabled = false;
let audioCtx = null;
let lastBeepTime = 0;

let packetsThisSec = 0;
let framesThisSec = 0;
let recordedRows = [];

function playTone(freq = 880, duration = 0.055) {
  if (!audioEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (_) {}
}

function handleIncomingFrame(rawSamples64, hwStatusByte) {
  packetsThisSec++;
  currentAlert = hwStatusByte;

  const enableNotch = document.getElementById('chkNotch').checked;
  const enableBandpass = document.getElementById('chkBandpass').checked;
  const filtered64 = dsp.filterFrame(rawSamples64, enableNotch, enableBandpass, currentMode);

  if (!isPaused) {
    for (let i = 0; i < 64; i++) {
      rawBuffer.push(rawSamples64[i]);
      filteredBuffer.push(filtered64[i]);
    }
    while (filteredBuffer.length > windowSize) {
      rawBuffer.shift();
      filteredBuffer.shift();
    }

    latestSpectrum = dsp.computeSpectrum(filtered64);
    renderer.pushSpectrumColumn(latestSpectrum.magnitudes);
    latestTimeMetrics = dsp.analyzeWaveform(filteredBuffer);

    // Trigger soft QRS audio beep if peak detected in current frame
    const frameMax = Math.max(...filtered64);
    if (frameMax > 195 && performance.now() - lastBeepTime > 320) {
      lastBeepTime = performance.now();
      playTone(hwStatusByte > 0 ? 440 : 880, 0.05);
    }
  }

  if (recordedRows.length < 15000) {
    const ts = new Date().toISOString();
    for (let i = 0; i < 64; i++) {
      recordedRows.push(`${ts},${currentMode},${rawSamples64[i]},${filtered64[i]},${hwStatusByte}`);
    }
  }

  updateAlertBanner(hwStatusByte);
  if (hwStatusByte > 0) appendAnomalyLog(hwStatusByte);
}

const transport = new BioTransport(handleIncomingFrame, (state, label) => {
  const pill = document.getElementById('connStatus');
  pill.className = `status-pill ${state}`;
  document.getElementById('connText').textContent = label;

  document.getElementById('btnUsb').textContent = transport.activeType === 'USB' ? 'Disconnect USB' : 'Connect USB (115200)';
  document.getElementById('btnBle').textContent = transport.activeType === 'BLE' ? 'Disconnect BLE' : 'Connect BLE';
  document.getElementById('btnSim').textContent = transport.activeType === 'SIM' ? 'Stop Virtual Patient' : 'Start Virtual Patient';
});

// 60 FPS Render Loop
function renderLoop() {
  framesThisSec++;
  const showRaw = document.getElementById('chkShowRaw').checked;
  renderer.drawScope(filteredBuffer, rawBuffer, showRaw, currentGain, currentAlert > 0);
  renderer.drawMorphologyOrFatigue(currentMode, latestTimeMetrics, latestSpectrum);
  renderer.drawFFT(latestSpectrum.magnitudes, latestSpectrum.peakHold);
  renderer.drawWaterfall();
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

// Update KPIs & Edge-AI Inference every 350ms
setInterval(() => {
  document.getElementById('kpi1Val').textContent = currentMode === 'ECG' ? latestTimeMetrics.bpm : latestTimeMetrics.rms;
  document.getElementById('kpiVpp').textContent = latestTimeMetrics.vpp;
  document.getElementById('kpiRms').textContent = latestTimeMetrics.rms;
  document.getElementById('kpiDomFreq').textContent = latestSpectrum.dominantFreq;
  document.getElementById('kpiMdf').textContent = latestSpectrum.medianFreq;
  document.getElementById('kpiCorr').textContent = currentMode === 'ECG' ? latestTimeMetrics.correlationPct : '--';
  document.getElementById('morphBadge').textContent =
    currentMode === 'ECG' ? `Corr: ${latestTimeMetrics.correlationPct}%` : `MDF: ${latestSpectrum.medianFreq} Hz`;

  const ai = dsp.classifyEdgeAI(latestTimeMetrics, latestSpectrum, currentMode, currentAlert);
  document.getElementById('aiLatencyBadge').textContent = `Infer: ${ai.inferMs} ms`;
  document.getElementById('probNormal').textContent = `${ai.normal}%`;
  document.getElementById('barNormal').style.width = `${ai.normal}%`;
  document.getElementById('probArr').textContent = `${ai.arrhythmia}%`;
  document.getElementById('barArr').style.width = `${ai.arrhythmia}%`;
  document.getElementById('probFatigue').textContent = `${ai.fatigue}%`;
  document.getElementById('barFatigue').style.width = `${ai.fatigue}%`;
  document.getElementById('probNoise').textContent = `${ai.noise}%`;
  document.getElementById('barNoise').style.width = `${ai.noise}%`;
}, 350);

setInterval(() => {
  document.getElementById('fpsStat').textContent = framesThisSec;
  document.getElementById('ppsStat').textContent = packetsThisSec;
  framesThisSec = 0;
  packetsThisSec = 0;
}, 1000);

function updateAlertBanner(code) {
  const banner = document.getElementById('alertBanner');
  const title = document.getElementById('alertTitle');
  const badge = document.getElementById('codeBadge');

  if (code > 0 || latestTimeMetrics.isLeadOff) {
    banner.className = 'alert-banner danger';
    if (latestTimeMetrics.isLeadOff) {
      title.textContent = 'SENSOR ALERT: Electrode Lead-Off / Signal Saturation';
    } else if (code === 1) {
      title.textContent = 'ANOMALY (01): Arrhythmia / Abnormal Heart Rate Detected';
    } else {
      title.textContent = 'ANOMALY (10): Neuromuscular Fatigue Spectral Shift';
    }
  } else {
    banner.className = 'alert-banner normal';
    title.textContent = 'Normal Sinus / Baseline Bio-Signal';
  }
  badge.textContent = `HW STATUS: 0${code}`;
}

function appendAnomalyLog(code) {
  const log = document.getElementById('eventLog');
  if (log.querySelector('.log-empty')) log.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'log-row';
  const time = new Date().toLocaleTimeString();
  const desc = code === 1 ? 'Cardiac Anomaly (01)' : 'Muscle Fatigue (10)';
  row.innerHTML = `<span class="log-tag-err">[${time}] ${desc}</span><span>Mode: ${currentMode} | BPM: ${latestTimeMetrics.bpm} | Vpp: ${latestTimeMetrics.vpp}V</span>`;
  log.prepend(row);
}

// Interactive Click-to-Measure Calipers on Oscilloscope
scopeCanvas.addEventListener('click', (e) => {
  if (!isPaused) {
    document.getElementById('caliperReadout').textContent = 'Tip: Click "Pause & Calipers" first to freeze the waveform and measure Δt / ΔV.';
    return;
  }
  const rect = scopeCanvas.getBoundingClientRect();
  const xNorm = (e.clientX - rect.left) / rect.width;
  const yNorm = (e.clientY - rect.top) / rect.height;

  if (renderer.calipers.length >= 2) renderer.calipers = [];
  renderer.calipers.push({ xNorm, yNorm });

  if (renderer.calipers.length === 1) {
    document.getElementById('caliperReadout').textContent = 'Caliper 1 placed — click a second point to calculate Δt (ms), BPM, and ΔV (mV).';
  } else if (renderer.calipers.length === 2) {
    const totalMs = (windowSize / 250) * 1000;
    const dtMs = Math.abs(renderer.calipers[1].xNorm - renderer.calipers[0].xNorm) * totalMs;
    const equivBpm = dtMs > 10 ? Math.round(60000 / dtMs) : '--';
    const dvMv = Math.abs(renderer.calipers[1].yNorm - renderer.calipers[0].yNorm) * (3300 / currentGain);
    document.getElementById('caliperReadout').innerHTML =
      `<strong>Caliper Measurement:</strong> Δt = <strong>${dtMs.toFixed(1)} ms</strong> (${equivBpm} BPM) | ΔV = <strong>${dvMv.toFixed(0)} mV</strong>`;
  }
});

// Event Listeners
document.getElementById('btnUsb').addEventListener('click', async () => {
  try {
    if (transport.activeType === 'USB') await transport.disconnect();
    else await transport.connectUSB();
  } catch (err) { alert(err.message); }
});

document.getElementById('btnBle').addEventListener('click', async () => {
  try {
    if (transport.activeType === 'BLE') await transport.disconnect();
    else await transport.connectBLE();
  } catch (err) { alert(err.message); }
});

document.getElementById('btnSim').addEventListener('click', async () => {
  if (transport.activeType === 'SIM') await transport.disconnect();
  else await transport.startSimulator();
});

document.getElementById('btnAudio').addEventListener('click', (e) => {
  audioEnabled = !audioEnabled;
  e.target.textContent = audioEnabled ? 'Audio: ON' : 'Audio: OFF';
  e.target.classList.toggle('active', audioEnabled);
  if (audioEnabled) playTone(880, 0.06);
});

document.getElementById('btnPrint').addEventListener('click', () => window.print());

// Virtual Patient Presets
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    transport.preset = btn.dataset.preset;
    transport.leadOff = false;
    document.getElementById('btnLeadOff').classList.remove('active');

    // Automatically switch mode tab to match selected preset
    const targetMode = transport.preset === 'fatigue' ? 'sEMG' : transport.preset === 'eeg' ? 'EEG' : 'ECG';
    switchMode(targetMode);

    if (transport.activeType !== 'SIM') {
      await transport.startSimulator();
    }
  });
});

document.getElementById('humSlider').addEventListener('input', (e) => {
  transport.humLevel = parseInt(e.target.value, 10) / 100;
  document.getElementById('humVal').textContent = `${e.target.value}%`;
});

document.getElementById('driftSlider').addEventListener('input', (e) => {
  transport.driftLevel = parseInt(e.target.value, 10) / 100;
  document.getElementById('driftVal').textContent = `${e.target.value}%`;
});

document.getElementById('btnLeadOff').addEventListener('click', async (e) => {
  transport.leadOff = !transport.leadOff;
  e.target.classList.toggle('active', transport.leadOff);
  if (transport.activeType !== 'SIM') await transport.startSimulator();
});

document.getElementById('csvFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    await transport.startCSVReplay(text);
  } catch (err) { alert(err.message); }
});

function switchMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  dsp.reset();
  renderer.clearWaterfall();

  document.getElementById('kpi1Label').textContent = mode === 'ECG' ? 'HEART RATE' : 'SIGNAL RMS';
  document.getElementById('kpi1Unit').textContent = mode === 'ECG' ? 'BPM' : 'V';
  document.getElementById('morphTitle').textContent =
    mode === 'sEMG' ? 'sEMG Neuromuscular Fatigue Decay Curve' : 'MIT-BIH Reference Beat vs. Live Morphology';
  document.getElementById('morphSub').textContent =
    mode === 'sEMG' ? 'Rolling Spectral Median Frequency (MDF) Over Time' : 'Normalized P-QRS-T Template Correlation Overlay';
}

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

document.getElementById('gainSelect').addEventListener('change', (e) => {
  currentGain = parseFloat(e.target.value);
});

document.getElementById('windowSelect').addEventListener('change', (e) => {
  windowSize = parseInt(e.target.value, 10);
  filteredBuffer = new Array(windowSize).fill(128);
  rawBuffer = new Array(windowSize).fill(128);
});

document.getElementById('btnFreeze').addEventListener('click', (e) => {
  isPaused = !isPaused;
  renderer.calipers = [];
  e.target.textContent = isPaused ? 'Resume Live Trace' : 'Pause & Calipers';
  e.target.classList.toggle('active', isPaused);
  document.getElementById('caliperReadout').textContent = isPaused
    ? 'Trace paused — click any two points on the waveform to place measurement calipers.'
    : 'Click "Pause & Calipers" then click two points on the waveform to measure Δt (ms) and ΔV (mV)';
});

document.getElementById('btnClear').addEventListener('click', () => {
  filteredBuffer = new Array(windowSize).fill(128);
  rawBuffer = new Array(windowSize).fill(128);
  renderer.calipers = [];
  dsp.reset();
  renderer.clearWaterfall();
  recordedRows = [];
});

document.getElementById('btnClearLog').addEventListener('click', () => {
  document.getElementById('eventLog').innerHTML =
    '<div class="log-empty">No anomaly events recorded. System monitoring active.</div>';
});

document.getElementById('btnExport').addEventListener('click', () => {
  if (recordedRows.length === 0) {
    alert('No signal data captured yet. Start the Virtual Patient or connect hardware first.');
    return;
  }
  const csv = 'timestamp,mode,raw_adc_8bit,filtered_adc_8bit,hw_status\n' + recordedRows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fpga_biosignal_session_${currentMode}_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});