// Unified Transport: Virtual Patient Synthesizer, CSV Replay, Web Serial (115200) & Web Bluetooth
const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

export class BioTransport {
  constructor(onFrame, onStatusChange) {
    this.onFrame = onFrame;
    this.onStatusChange = onStatusChange;
    this.activeType = null; // 'USB' | 'BLE' | 'SIM' | 'CSV'

    this.serialPort = null;
    this.serialReader = null;
    this.bleDevice = null;
    this.simInterval = null;
    this.simSampleIdx = 0;

    // Virtual Patient Parameters
    this.preset = 'normal'; // 'normal' | 'tachy' | 'brady' | 'pvc' | 'fatigue' | 'eeg'
    this.humLevel = 0.15;
    this.driftLevel = 0.10;
    this.leadOff = false;

    // CSV Replay Buffer
    this.csvSamples = [];
    this.csvCursor = 0;
  }

  async connectUSB() {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial requires Google Chrome or Microsoft Edge on desktop.');
    }
    await this.disconnect();
    this.serialPort = await navigator.serial.requestPort();
    await this.serialPort.open({ baudRate: 115200 });
    this.activeType = 'USB';
    this.onStatusChange('connected', 'USB 115200');
    this.readSerialLoop();
  }

  async readSerialLoop() {
    const rxBuffer = [];
    this.serialReader = this.serialPort.readable.getReader();
    try {
      while (this.activeType === 'USB') {
        const { value, done } = await this.serialReader.read();
        if (done) break;
        if (value) {
          for (let i = 0; i < value.length; i++) rxBuffer.push(value[i]);
          while (rxBuffer.length >= 66) {
            if (rxBuffer[0] !== 0xAA) {
              rxBuffer.shift();
              continue;
            }
            const frame = rxBuffer.splice(0, 66);
            const samples = new Uint8Array(frame.slice(1, 65));
            const statusByte = frame[65];
            this.onFrame(samples, statusByte);
          }
        }
      }
    } catch (_) {
      if (this.activeType === 'USB') this.onStatusChange('offline', 'USB Disconnected');
    } finally {
      if (this.serialReader) this.serialReader.releaseLock();
    }
  }

  async connectBLE() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth requires Google Chrome or Microsoft Edge.');
    }
    await this.disconnect();
    this.bleDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    this.bleDevice.addEventListener('gattserverdisconnected', () => {
      this.activeType = null;
      this.onStatusChange('offline', 'Offline');
    });

    const server = await this.bleDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const char = await service.getCharacteristic(CHARACTERISTIC_UUID);
    await char.startNotifications();

    char.addEventListener('characteristicvaluechanged', (e) => {
      const view = e.target.value;
      if (view.byteLength >= 65) {
        const samples = new Uint8Array(64);
        for (let i = 0; i < 64; i++) samples[i] = view.getUint8(i);
        this.onFrame(samples, view.getUint8(64));
      }
    });

    this.activeType = 'BLE';
    this.onStatusChange('connected', 'BLE Connected');
  }

  // Virtual Patient 250 Hz Bio-Signal Generator
  async startSimulator() {
    await this.disconnect();
    this.activeType = 'SIM';
    this.simSampleIdx = 0;
    this.onStatusChange('demo', 'Virtual Patient');

    this.simInterval = setInterval(() => {
      const samples = new Uint8Array(64);
      let hwStatus = 0;

      for (let i = 0; i < 64; i++) {
        const n = this.simSampleIdx + i;
        const tSec = n / 250;

        if (this.leadOff) {
          samples[i] = Math.random() > 0.5 ? 255 : 0;
          continue;
        }

        let clean = 128;

        if (this.preset === 'normal' || this.preset === 'tachy' || this.preset === 'brady' || this.preset === 'pvc') {
          const period = this.preset === 'tachy' ? 101 : this.preset === 'brady' ? 357 : 208; // 148, 42, or 72 BPM
          const beatNum = Math.floor(n / period);
          const phase = n % period;

          if (this.preset === 'pvc' && beatNum % 4 === 3) {
            // Premature Ventricular Contraction (wide, inverted abnormal beat)
            if (phase >= 12 && phase <= 26) clean = 128 - Math.sin(((phase - 12) / 14) * Math.PI) * 95;
            else if (phase > 26 && phase <= 46) clean = 128 + Math.sin(((phase - 26) / 20) * Math.PI) * 45;
          } else {
            // Realistic P-QRS-T morphology
            if (phase >= 18 && phase <= 28) clean = 128 + Math.sin(((phase - 18) / 10) * Math.PI) * 15;
            else if (phase === 38) clean = 108;
            else if (phase === 40) clean = 232;
            else if (phase === 42) clean = 84;
            else if (phase >= 62 && phase <= 82) clean = 128 + Math.sin(((phase - 62) / 20) * Math.PI) * 24;
          }
        } else if (this.preset === 'fatigue') {
          // Isometric sEMG contraction whose frequency gradually shifts downward (fatigue)
          const fatigueFactor = Math.max(0.35, 1 - (tSec % 30) / 40);
          const f1 = 85 * fatigueFactor;
          const f2 = 55 * fatigueFactor;
          const burst = 0.65 + 0.35 * Math.sin(2 * Math.PI * 0.4 * tSec);
          clean = 128 + burst * (45 * Math.sin(2 * Math.PI * f1 * tSec) + 30 * Math.cos(2 * Math.PI * f2 * tSec));
        } else if (this.preset === 'eeg') {
          // Neural Alpha (10 Hz) + Beta (21 Hz)
          clean = 128 + 30 * Math.sin(2 * Math.PI * 10 * tSec) + 14 * Math.sin(2 * Math.PI * 21 * tSec);
        }

        // Add controllable 50 Hz Mains Hum & 0.25 Hz Baseline Wander
        const hum50Hz = this.humLevel * 38 * Math.sin(2 * Math.PI * 50 * tSec);
        const drift = this.driftLevel * 32 * Math.sin(2 * Math.PI * 0.25 * tSec);

        const noisy = clean + hum50Hz + drift + (Math.random() - 0.5) * 2.5;
        samples[i] = Math.max(0, Math.min(255, Math.round(noisy)));
      }

      if (this.preset === 'tachy' || this.preset === 'pvc') hwStatus = 1;
      else if (this.preset === 'fatigue' && ((this.simSampleIdx / 250) % 30) > 12) hwStatus = 2;

      this.simSampleIdx += 64;
      this.onFrame(samples, hwStatus);
    }, 256);
  }

  // Replay Uploaded CSV Bio-Signal File at 250 Hz
  async startCSVReplay(csvText) {
    await this.disconnect();
    const lines = csvText.split(/\r?\n/);
    const parsed = [];
    for (const line of lines) {
      const cols = line.split(',');
      for (const c of cols) {
        const num = parseFloat(c.trim());
        if (!Number.isNaN(num)) {
          // Auto-scale normalized floats (-1..1 or 0..3.3V) to 8-bit 0..255
          let scaled = num;
          if (num >= -2 && num <= 2) scaled = ((num + 1) / 2) * 255;
          else if (num > 2 && num <= 5) scaled = (num / 3.3) * 255;
          parsed.push(Math.max(0, Math.min(255, Math.round(scaled))));
          break;
        }
      }
    }

    if (parsed.length < 64) {
      throw new Error('CSV file must contain at least 64 numeric sample values.');
    }

    this.csvSamples = parsed;
    this.csvCursor = 0;
    this.activeType = 'CSV';
    this.onStatusChange('demo', `CSV Replay (${parsed.length} pts)`);

    this.simInterval = setInterval(() => {
      const frame = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        frame[i] = this.csvSamples[(this.csvCursor + i) % this.csvSamples.length];
      }
      this.csvCursor = (this.csvCursor + 64) % this.csvSamples.length;
      this.onFrame(frame, 0);
    }, 256);
  }

  async disconnect() {
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }
    if (this.serialReader) {
      try { await this.serialReader.cancel(); } catch (_) {}
      this.serialReader = null;
    }
    if (this.serialPort) {
      try { await this.serialPort.close(); } catch (_) {}
      this.serialPort = null;
    }
    if (this.bleDevice && this.bleDevice.gatt.connected) {
      this.bleDevice.gatt.disconnect();
      this.bleDevice = null;
    }
    this.activeType = null;
    this.onStatusChange('offline', 'Offline');
  }
}