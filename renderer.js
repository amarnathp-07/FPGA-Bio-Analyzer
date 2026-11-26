// 60 FPS Multi-Graph Renderer (Oscilloscope + Calipers, Morphology/Poincare/MDF, FFT, Waterfall)
class BioRenderer {
  constructor(scopeCanvas, morphCanvas, fftCanvas, waterfallCanvas) {
    this.scopeCanvas = scopeCanvas;
    this.morphCanvas = morphCanvas;
    this.fftCanvas = fftCanvas;
    this.waterfallCanvas = waterfallCanvas;

    this.scopeCtx = scopeCanvas.getContext('2d');
    this.morphCtx = morphCanvas.getContext('2d');
    this.fftCtx = fftCanvas.getContext('2d');
    this.wfCtx = waterfallCanvas.getContext('2d');

    this.wfHistory = [];
    this.maxWfCols = 160;
    this.calipers = []; // Up to 2 measurement points { xNorm, yNorm }
  }

  resizeCanvas(canvas, ctx) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: rect.width, h: rect.height };
  }

  pushSpectrumColumn(magnitudes) {
    this.wfHistory.push(Float32Array.from(magnitudes));
    if (this.wfHistory.length > this.maxWfCols) this.wfHistory.shift();
  }

  clearWaterfall() {
    this.wfHistory = [];
  }

  // 1. Oscilloscope with Raw Overlay & Interactive Measurement Calipers
  drawScope(filteredBuf, rawBuf, showRaw = true, gain = 1.0, isAlert = false) {
    const { w, h } = this.resizeCanvas(this.scopeCanvas, this.scopeCtx);
    const ctx = this.scopeCtx;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    // Clinical Grid
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 20) {
      ctx.strokeStyle = x % 100 === 0 ? '#e2e8f0' : '#f1f5f9';
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += 20) {
      ctx.strokeStyle = y % 100 === 0 ? '#e2e8f0' : '#f1f5f9';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const midY = h / 2;
    ctx.strokeStyle = '#cbd5e1';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(w, midY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.fillText('3.3V', 6, 12);
    ctx.fillText('1.65V', 6, midY - 4);
    ctx.fillText('0.0V', 6, h - 6);

    const len = filteredBuf.length;
    if (len < 2) return;

    // Optional Unfiltered Raw Trace Overlay
    if (showRaw && rawBuf.length === len) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let i = 0; i < len; i++) {
        const x = (i / (len - 1)) * w;
        const centered = (rawBuf[i] - 128) * gain;
        const clamped = Math.max(-128, Math.min(127, centered));
        const y = midY - (clamped / 128) * (h * 0.44);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Main DSP-Filtered Signal
    ctx.strokeStyle = isAlert ? '#dc2626' : '#0d9488';
    ctx.lineWidth = 2.1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = (i / (len - 1)) * w;
      const centered = (filteredBuf[i] - 128) * gain;
      const clamped = Math.max(-128, Math.min(127, centered));
      const y = midY - (clamped / 128) * (h * 0.44);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Draw Interactive Measurement Calipers if placed
    if (this.calipers.length > 0) {
      this.calipers.forEach((pt, idx) => {
        const cx = pt.xNorm * w;
        const cy = pt.yNorm * h;
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, h);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#2563eb';
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(`C${idx + 1}`, cx + 5, cy - 6);
      });

      if (this.calipers.length === 2) {
        const x1 = this.calipers[0].xNorm * w;
        const y1 = this.calipers[0].yNorm * h;
        const x2 = this.calipers[1].xNorm * w;
        const y2 = this.calipers[1].yNorm * h;
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
  }

  // 2. Context-Aware Morphology / MIT-BIH Template Overlay OR sEMG Fatigue Curve
  drawMorphologyOrFatigue(mode, timeMetrics, specMetrics) {
    const { w, h } = this.resizeCanvas(this.morphCanvas, this.morphCtx);
    const ctx = this.morphCtx;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y <= h; y += 24) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    if (mode === 'sEMG') {
      // Plot 60-frame Spectral Median Frequency (MDF) Fatigue Trendline
      const hist = specMetrics.mdfHistory;
      if (hist.length < 2) return;

      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      hist.forEach((mdf, idx) => {
        const x = 16 + (idx / Math.max(1, hist.length - 1)) * (w - 32);
        const norm = Math.min(1, Math.max(0, mdf / 110));
        const y = h - 22 - norm * (h - 38);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Fatigue threshold line at 52 Hz
      const threshY = h - 22 - (52 / 110) * (h - 38);
      ctx.strokeStyle = '#dc2626';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(16, threshY);
      ctx.lineTo(w - 16, threshY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#64748b';
      ctx.font = '10px sans-serif';
      ctx.fillText('110 Hz', 8, 14);
      ctx.fillText('52 Hz Fatigue Threshold', 8, threshY - 4);
      ctx.fillText('Rolling Median Frequency (MDF) Trend', w - 185, h - 6);
      return;
    }

    // ECG / EEG: Overlay MIT-BIH Golden Reference Beat (dashed blue) vs Live Beat (solid teal)
    const ref = timeMetrics.mitBihTemplate;
    const live = timeMetrics.liveBeat;

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ref.forEach((v, i) => {
      const x = 16 + (i / (ref.length - 1)) * (w - 32);
      const y = h - 22 - v * (h - 38);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#0d9488';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    live.forEach((v, i) => {
      const x = 16 + (i / (live.length - 1)) * (w - 32);
      const y = h - 22 - v * (h - 38);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.fillText('Dashed Blue: MIT-BIH Reference  |  Solid Teal: Live Extracted Beat', 12, h - 6);
  }

  // 3. 64-Point FFT Power Spectrum
  drawFFT(magnitudes, peakHold) {
    const { w, h } = this.resizeCanvas(this.fftCanvas, this.fftCtx);
    const ctx = this.fftCtx;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#f1f5f9';
    ctx.lineWidth = 1;
    for (let y = 0; y <= h; y += 25) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const bins = magnitudes.length - 1;
    const barW = (w - 24) / bins;

    for (let b = 1; b <= bins; b++) {
      const x = 12 + (b - 1) * barW;
      const norm = Math.min(1, magnitudes[b] / 42);
      const barH = norm * (h - 28);

      ctx.fillStyle = '#0d9488';
      ctx.fillRect(x + 1, h - 18 - barH, Math.max(2, barW - 3), barH);

      const peakNorm = Math.min(1, peakHold[b] / 42);
      const peakY = h - 18 - peakNorm * (h - 28);
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(x + 1, peakY - 2, Math.max(2, barW - 3), 2);
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.fillText('0 Hz', 12, h - 4);
    ctx.fillText('30 Hz', w * 0.25, h - 4);
    ctx.fillText('50 Hz (Notch)', w * 0.4, h - 4);
    ctx.fillText('90 Hz', w * 0.75, h - 4);
    ctx.fillText('125 Hz', w - 38, h - 4);
  }

  // 4. Scrolling Waterfall Spectrogram
  drawWaterfall() {
    const { w, h } = this.resizeCanvas(this.waterfallCanvas, this.wfCtx);
    const ctx = this.wfCtx;

    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    if (this.wfHistory.length === 0) return;

    const colW = w / this.maxWfCols;
    const bins = 31;
    const rowH = (h - 18) / bins;

    for (let c = 0; c < this.wfHistory.length; c++) {
      const col = this.wfHistory[c];
      const x = c * colW;

      for (let b = 1; b <= bins; b++) {
        const intensity = Math.min(1, col[b] / 38);
        const y = h - 18 - b * rowH;

        if (intensity < 0.15) ctx.fillStyle = '#f1f5f9';
        else if (intensity < 0.4) ctx.fillStyle = '#99f6e4';
        else if (intensity < 0.7) ctx.fillStyle = '#0d9488';
        else if (intensity < 0.9) ctx.fillStyle = '#f59e0b';
        else ctx.fillStyle = '#dc2626';

        ctx.fillRect(x, y, Math.ceil(colW), Math.ceil(rowH));
      }
    }

    ctx.fillStyle = '#64748b';
    ctx.font = '10px sans-serif';
    ctx.fillText('Older ← Time → Live', 8, h - 4);
    ctx.fillText('Top: 125 Hz | Bottom: 0 Hz', w - 135, h - 4);
  }
}