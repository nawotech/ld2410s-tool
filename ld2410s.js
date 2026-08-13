/* HLK-LD2410S protocol codec — Web Serial, no dependencies.
 * Protocol per "HLK-LD2410S serial communication protocol V1.00", verified
 * against firmware V1.1.1 hardware. All multi-byte fields little-endian. */

export const CMD_HEAD = [0xfd, 0xfc, 0xfb, 0xfa];
export const CMD_TAIL = [0x04, 0x03, 0x02, 0x01];
export const DAT_HEAD = [0xf4, 0xf3, 0xf2, 0xf1];
export const DAT_TAIL = [0xf8, 0xf7, 0xf6, 0xf5];

export const CMD = {
  FW_VERSION: 0x0000, AUTO_THRESHOLD: 0x0009,
  WRITE_SN: 0x0010, READ_SN: 0x0011,
  WRITE_COMMON: 0x0070, READ_COMMON: 0x0071,
  WRITE_TRIGGER: 0x0072, READ_TRIGGER: 0x0073,
  WRITE_HOLD: 0x0076, READ_HOLD: 0x0077,
  OUTPUT_MODE: 0x007a,
  END_CONFIG: 0x00fe, ENABLE_CONFIG: 0x00ff,
};

/* Common-parameter words. Frequencies are transported as Hz*10. */
export const PARAM = {
  STATUS_FREQ: 0x02, MAX_GATE: 0x05, UNMANNED_DELAY: 0x06,
  MIN_GATE: 0x0a, RESPONSE_SPEED: 0x0b, DIST_FREQ: 0x0c,
};

export const GATES = 16;
export const GATE_METERS = 0.7;   // range resolution, one gate = 70 cm

/* Common-parameter ranges, per protocol V1.00 table 2-2 / user manual table 5-2.
 * The firmware does NOT range-check these and stores each as a single byte, so an
 * out-of-range write is silently truncated (60 Hz -> 600 & 0xff = 88 -> "8.8 Hz")
 * and can wedge the reporting loop entirely. Validate before every write. */
export const LIMITS = {
  maxGate:       { min: 1,   max: 16,  step: 1,   unit: '',   label: 'max gate' },
  minGate:       { min: 0,   max: 16,  step: 1,   unit: '',   label: 'min gate' },
  unmannedDelay: { min: 10,  max: 120, step: 1,   unit: 's',  label: 'unmanned delay' },
  statusFreq:    { min: 0.5, max: 8,   step: 0.5, unit: 'Hz', label: 'status frequency' },
  distFreq:      { min: 0.5, max: 8,   step: 0.5, unit: 'Hz', label: 'distance frequency' },
  responseSpeed: { values: [5, 10],               unit: '',   label: 'response speed' },
};

/** Throws on any common parameter the module would truncate or choke on. */
export function validateCommon(c) {
  for (const [key, lim] of Object.entries(LIMITS)) {
    const v = c[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`${lim.label}: expected a number, got ${JSON.stringify(v)}`);
    }
    if (lim.values) {
      if (!lim.values.includes(v)) {
        throw new Error(`${lim.label}: must be ${lim.values.join(' or ')}, got ${v}`);
      }
      continue;
    }
    if (v < lim.min || v > lim.max) {
      throw new Error(`${lim.label}: must be ${lim.min}–${lim.max}${lim.unit}, got ${v}${lim.unit}`);
    }
    if (Math.abs(v / lim.step - Math.round(v / lim.step)) > 1e-9) {
      throw new Error(`${lim.label}: must be a multiple of ${lim.step}${lim.unit}, got ${v}${lim.unit}`);
    }
  }
  if (c.minGate >= c.maxGate) {
    throw new Error(`min gate (${c.minGate}) must be below max gate (${c.maxGate})`);
  }
}

/* Raw per-gate energy spans ~0..1e5; thresholds are stored in dB. */
export const toDb = (raw) => (raw > 0 ? 10 * Math.log10(raw) : 0);

function u16(lo, hi) { return lo | (hi << 8); }

/** Incremental byte-stream framer. Feed chunks, get whole frames out. */
export class FrameParser {
  constructor() { this.buf = new Uint8Array(0); }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    const frames = [];
    let i = 0;
    while (i < this.buf.length) {
      const c = this._at(i, CMD_HEAD), d = this._at(i, DAT_HEAD);
      if (c || d) {
        if (i + 6 > this.buf.length) break;            // need length field
        const len = u16(this.buf[i + 4], this.buf[i + 5]);
        const end = i + 6 + len;
        if (end + 4 > this.buf.length) break;          // wait for more bytes
        const tail = c ? CMD_TAIL : DAT_TAIL;
        if (this._at(end, tail)) {
          const body = this.buf.slice(i + 6, end);
          frames.push(c ? this._command(body) : this._data(body));
          i = end + 4;
          continue;
        }
        i++;                                           // bad tail, resync
        continue;
      }
      if (this.buf[i] === 0x6e) {                      // minimal report frame
        if (i + 5 > this.buf.length) break;
        if (this.buf[i + 4] === 0x62) {
          frames.push({
            kind: 'data', type: 'minimal',
            state: this.buf[i + 1],
            distance: u16(this.buf[i + 2], this.buf[i + 3]),
          });
          i += 5;
          continue;
        }
      }
      i++;
    }
    this.buf = this.buf.slice(i);
    return frames;
  }

  _at(i, sig) {
    if (i + sig.length > this.buf.length) return false;
    for (let k = 0; k < sig.length; k++) if (this.buf[i + k] !== sig[k]) return false;
    return true;
  }

  _command(body) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    return {
      kind: 'command',
      word: view.getUint16(0, true) & 0x00ff,   // ACK sets the 0x0100 bit
      status: body.length >= 4 ? view.getUint16(2, true) : 0,
      payload: body.slice(4),
      raw: body,
    };
  }

  _data(body) {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const type = body[0];
    if (type === 0x01 && body.length >= 70) {
      const energy = [];
      for (let g = 0; g < GATES; g++) energy.push(view.getUint32(6 + g * 4, true));
      return {
        kind: 'data', type: 'standard',
        state: body[1],
        distance: view.getUint16(2, true),
        energy,
      };
    }
    if (type === 0x03) {
      return { kind: 'data', type: 'progress', percent: view.getUint16(1, true) / 100 };
    }
    return { kind: 'data', type: 'unknown', raw: body };
  }
}

export function buildCommand(word, payload = []) {
  const body = [word & 0xff, (word >> 8) & 0xff, ...payload];
  return new Uint8Array([
    ...CMD_HEAD, body.length & 0xff, (body.length >> 8) & 0xff, ...body, ...CMD_TAIL,
  ]);
}

export const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
export const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];

/** Transport: owns the port, routes ACKs to awaiting callers, data to onData. */
export class LD2410S {
  constructor() {
    this.port = null;
    this.parser = new FrameParser();
    this.pending = null;
    this.onData = () => {};
    this.onRaw = () => {};
    this.onLog = () => {};
    this._reading = false;
  }

  get connected() { return !!this.port; }

  async connect(port, baudRate = 115200) {
    this.port = port;
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none' });
    this.writer = port.writable.getWriter();
    this._reading = true;
    this._readLoop();
  }

  async disconnect() {
    this._reading = false;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
    this.port = null;
  }

  async _readLoop() {
    while (this._reading && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (true) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (!value) continue;
          this.onRaw(value);
          for (const f of this.parser.push(value)) {
            if (f.kind === 'command') {
              if (this.pending && this.pending.word === f.word) {
                const p = this.pending; this.pending = null;
                clearTimeout(p.timer); p.resolve(f);
              }
            } else {
              this.onData(f);
            }
          }
        }
      } catch (e) {
        if (this._reading) this.onLog(`read error: ${e.message}`);
      } finally {
        try { this.reader.releaseLock(); } catch {}
      }
    }
  }

  send(word, payload = []) {
    const frame = buildCommand(word, payload);
    if (this.pending) return Promise.reject(new Error('command already in flight'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`timeout waiting for ACK 0x${word.toString(16)}`));
      }, 2000);
      this.pending = { word, resolve, reject, timer };
      this.writer.write(frame).catch(reject);
    });
  }

  /* Every configuration command must be bracketed by enable/end config. */
  async withConfig(fn) {
    await this.send(CMD.ENABLE_CONFIG, le16(1));
    try { return await fn(); }
    finally { try { await this.send(CMD.END_CONFIG); } catch {} }
  }

  async firmwareVersion() {
    const r = await this.send(CMD.FW_VERSION);
    // payload: 4 bytes reserved, then major/minor/patch as uint16 LE
    const v = new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
    if (r.payload.length < 10) return 'unknown';
    return `${v.getUint16(4, true)}.${v.getUint16(6, true)}.${v.getUint16(8, true)}`;
  }

  async serialNumber() {
    const r = await this.send(CMD.READ_SN);
    const len = r.payload[0] | (r.payload[1] << 8);
    return new TextDecoder().decode(r.payload.slice(2, 2 + len));
  }

  async setOutputMode(standard) {
    return this.send(CMD.OUTPUT_MODE, [...le16(0), ...le16(standard ? 1 : 0), ...le16(0)]);
  }

  /** Reads the six common parameters; response order mirrors request order. */
  async readCommon() {
    const words = [PARAM.MAX_GATE, PARAM.MIN_GATE, PARAM.UNMANNED_DELAY,
                   PARAM.STATUS_FREQ, PARAM.DIST_FREQ, PARAM.RESPONSE_SPEED];
    const r = await this.send(CMD.READ_COMMON, words.flatMap(le16));
    const v = new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
    const val = (i) => v.getUint32(i * 4, true);
    return {
      maxGate: val(0), minGate: val(1), unmannedDelay: val(2),
      statusFreq: val(3) / 10, distFreq: val(4) / 10, responseSpeed: val(5),
    };
  }

  async writeCommon(c) {
    validateCommon(c);
    const pairs = [
      [PARAM.MAX_GATE, c.maxGate], [PARAM.MIN_GATE, c.minGate],
      [PARAM.UNMANNED_DELAY, c.unmannedDelay],
      [PARAM.STATUS_FREQ, Math.round(c.statusFreq * 10)],
      [PARAM.DIST_FREQ, Math.round(c.distFreq * 10)],
      [PARAM.RESPONSE_SPEED, c.responseSpeed],
    ];
    return this.send(CMD.WRITE_COMMON, pairs.flatMap(([w, v]) => [...le16(w), ...le32(v)]));
  }

  async readThresholds(hold) {
    const word = hold ? CMD.READ_HOLD : CMD.READ_TRIGGER;
    const gates = Array.from({ length: GATES }, (_, g) => g);
    const r = await this.send(word, gates.flatMap(le16));
    const v = new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength);
    return gates.map((g) => v.getUint32(g * 4, true));
  }

  async writeThresholds(hold, values) {
    const word = hold ? CMD.WRITE_HOLD : CMD.WRITE_TRIGGER;
    const payload = values.flatMap((v, g) => [...le16(g), ...le32(Math.round(v))]);
    return this.send(word, payload);
  }

  /** Kicks off on-device threshold learning; progress arrives as data frames. */
  async autoThreshold(triggerFactor = 2, holdFactor = 1, scanSeconds = 120) {
    return this.send(CMD.AUTO_THRESHOLD,
      [...le16(triggerFactor), ...le16(holdFactor), ...le16(scanSeconds)]);
  }
}
