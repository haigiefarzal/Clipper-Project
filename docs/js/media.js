// Baca & tulis video di browser dengan Mediabunny (WebCodecs, akselerasi hardware).
import { loadMediabunny } from './libs.js';

const MAX_DECODE = 2560; // sisi terpanjang saat decode (4K diperkecil supaya cepat & hemat memori)

export class Source {
  static async open(file) {
    const mb = await loadMediabunny();
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error('File ini tidak punya track video.');
    if (!(await video.canDecode())) {
      throw new Error(`Browser ini tidak bisa membaca codec video "${(await video.getCodec()) || '?'}". `
        + 'Coba file MP4 (H.264) atau pakai Chrome/Edge terbaru.');
    }
    let audio = await input.getPrimaryAudioTrack();
    if (audio && !(await audio.canDecode())) audio = null;
    const s = new Source();
    s.mb = mb; s.file = file; s.input = input; s.video = video; s.audio = audio;
    s.dispW = await video.getDisplayWidth();
    s.dispH = await video.getDisplayHeight();
    const k = Math.min(1, MAX_DECODE / Math.max(s.dispW, s.dispH));
    s.sw = Math.round((s.dispW * k) / 2) * 2;
    s.sh = Math.round((s.dispH * k) / 2) * 2;
    s.duration = await input.computeDuration();
    s.t0 = await video.getFirstTimestamp().catch(() => 0);
    try { s.fps = (await video.computePacketStats(120)).averagePacketRate || 30; } catch { s.fps = 30; }
    s.codec = await video.getCodec();
    return s;
  }

  sink(width, height, poolSize = 2) {
    return new this.mb.CanvasSink(this.video, { width, height, fit: 'fill', poolSize });
  }

  /** Ambil satu frame (canvas ukuran sw x sh) di detik t (waktu video, mulai 0). */
  async frameAt(t) {
    this._grab ??= this.sink(this.sw, this.sh, 1);
    const wc = await this._grab.getCanvas(this.t0 + Math.max(0, Math.min(t, this.duration - 0.001)));
    if (!wc) return null;
    const c = document.createElement('canvas');
    c.width = this.sw; c.height = this.sh;
    c.getContext('2d').drawImage(wc.canvas, 0, 0);
    return c;
  }

  /** Iterator canvas di daftar waktu (detik, relatif mulai video). */
  async *framesAt(times, width = this.sw, height = this.sh) {
    const sink = this.sink(width, height, 2);
    const ts = times.map((t) => this.t0 + Math.max(0, Math.min(t, this.duration - 0.001)));
    let last = null;
    for await (const wc of sink.canvasesAtTimestamps(ts)) {
      if (wc) last = wc.canvas;
      yield last;
    }
  }

  /** Decode audio [a, b] detik -> AudioBuffer 48 kHz stereo. null kalau tidak ada audio. */
  async audioRange(a, b, rate = 48000) {
    if (!this.audio) return null;
    const sink = new this.mb.AudioBufferSink(this.audio);
    const srcRate = await this.audio.getSampleRate();
    const chans = Math.max(1, Math.min(2, await this.audio.getNumberOfChannels()));
    const len = Math.max(1, Math.round((b - a) * srcRate));
    const data = Array.from({ length: chans }, () => new Float32Array(len));
    const A = this.t0 + a, B = this.t0 + b;
    for await (const wb of sink.buffers(A, B)) {
      const buf = wb.buffer;
      const off = Math.round((wb.timestamp - A) * buf.sampleRate);
      for (let c = 0; c < chans; c++) {
        const ch = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        const from = Math.max(0, -off), to = Math.min(ch.length, len - off);
        if (to > from) data[c].set(ch.subarray(from, to), off + from);
      }
    }
    const raw = new AudioBuffer({ length: len, numberOfChannels: chans, sampleRate: srcRate });
    data.forEach((d, c) => raw.copyToChannel(d, c));
    return resample(raw, rate, 2);
  }
}

export async function resample(buf, rate, channels, { reverse = false, speed = 1, gain = 1 } = {}) {
  const outLen = Math.max(1, Math.round((buf.duration / speed) * rate));
  const ctx = new OfflineAudioContext(channels, outLen, rate);
  let src = buf;
  if (reverse) {
    src = new AudioBuffer({ length: buf.length, numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate });
    for (let c = 0; c < buf.numberOfChannels; c++) src.copyToChannel(buf.getChannelData(c).slice().reverse(), c);
  }
  const node = ctx.createBufferSource();
  node.buffer = src;
  node.playbackRate.value = speed;
  const g = ctx.createGain();
  g.gain.value = gain;
  node.connect(g).connect(ctx.destination);
  node.start();
  return ctx.startRendering();
}

export function sliceBuffer(buf, a, b) {
  const sr = buf.sampleRate;
  const s = Math.max(0, Math.round(a * sr)), e = Math.min(buf.length, Math.max(s + 1, Math.round(b * sr)));
  const out = new AudioBuffer({ length: e - s, numberOfChannels: buf.numberOfChannels, sampleRate: sr });
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(s, e), c);
  return out;
}

/** Gabungkan beberapa AudioBuffer jadi satu dengan panjang persis (sampel) per bagian. */
export function concatBuffers(parts, sr, channels) {
  const total = parts.reduce((s, p) => s + p.samples, 0);
  const out = new AudioBuffer({ length: Math.max(1, total), numberOfChannels: channels, sampleRate: sr });
  let off = 0;
  for (const p of parts) {
    for (let c = 0; c < channels; c++) {
      const d = p.buf.getChannelData(Math.min(c, p.buf.numberOfChannels - 1)).subarray(0, p.samples);
      out.copyToChannel(d, c, off);
    }
    off += p.samples;
  }
  return out;
}

/** Pilih codec video yang bisa di-encode browser ini. */
export async function pickVideoCodec(W, H, fps) {
  const mb = await loadMediabunny();
  const bitrate = videoBitrate(W, H, fps);
  const codec = await mb.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H, bitrate, frameRate: fps });
  return { codec, bitrate };
}

export function videoBitrate(W, H, fps) {
  const px = W * H;
  const base = px >= 1920 * 1080 * 0.99 ? 12e6 : 9e6;
  return Math.round(fps > 40 ? base * 1.5 : base);
}

export const CODEC_LABEL = { avc: 'H.264', hevc: 'H.265 (HEVC)', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus' };

/**
 * Render & encode MP4.
 * frames: async iterable { draw(ctx), t } yang sudah berurutan; total = jumlah frame.
 */
export async function encodeMp4({ canvas, frames, total, fps, audio, onProgress, isCancelled }) {
  const mb = await loadMediabunny();
  const W = canvas.width, H = canvas.height;
  const { codec, bitrate } = await pickVideoCodec(W, H, fps);
  if (!codec) throw new Error('Browser ini tidak bisa meng-encode video. Pakai Chrome / Edge versi terbaru.');
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const vsrc = new mb.CanvasSource(canvas, { codec, bitrate, keyFrameInterval: 2, sizeChangeBehavior: 'deny' });
  output.addVideoTrack(vsrc, { frameRate: fps });
  let asrc = null, acodec = null;
  if (audio) {
    acodec = await mb.getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate, bitrate: 192000 });
    if (acodec) {
      asrc = new mb.AudioBufferSource({ codec: acodec, bitrate: 192000 });
      output.addAudioTrack(asrc);
    }
  }
  await output.start();
  let i = 0;
  const t0 = performance.now();
  try {
    if (asrc) { await asrc.add(audio); asrc.close(); }
    for await (const f of frames) {
      if (isCancelled?.()) throw new Error('DIBATALKAN');
      await vsrc.add(i / fps, 1 / fps);
      i++;
      if (onProgress && (i % 5 === 0 || i === total)) {
        const el = (performance.now() - t0) / 1000;
        onProgress(Math.min(1, i / total), { speed: i / fps / Math.max(el, 1e-3), eta: el / (i / total) - el });
      }
      void f;
    }
    vsrc.close();
    await output.finalize();
  } catch (e) {
    try { await output.cancel(); } catch { /* abaikan */ }
    throw e;
  }
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), codec, acodec, audioDropped: !!audio && !asrc };
}
