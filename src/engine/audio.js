// WebAudio sound effects and a per-theme ambient drone.
export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.sfxMap = {};
    this.volume = 0.6;
    this.ambient = null;
    this.muted = false;
  }

  setMap(sfx) { this.sfxMap = sfx; }

  // Browsers start audio only after a user gesture.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  async buffer(src) {
    if (!this.ctx) return null;
    if (this.buffers.has(src)) return this.buffers.get(src);
    const p = fetch('assets/' + src).then((r) => r.arrayBuffer()).then((b) => this.ctx.decodeAudioData(b)).catch(() => null);
    this.buffers.set(src, p);
    return p;
  }

  async play(name, vol = 1, rate = 1) {
    if (!this.ctx || this.muted) return;
    const src = this.sfxMap[name];
    if (!src) return;
    const buf = await this.buffer(src);
    if (!buf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
    const g = this.ctx.createGain();
    g.gain.value = vol;
    s.connect(g).connect(this.master);
    s.start();
  }

  async setAmbient(theme) {
    if (!this.ctx) return;
    if (this.ambient) { const a = this.ambient; a.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4); setTimeout(() => a.s.stop(), 1500); this.ambient = null; }
    if (!theme || this.muted) return;
    const src = this.sfxMap['amb_' + theme];
    const buf = src && await this.buffer(src);
    if (!buf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    g.gain.setTargetAtTime(0.25, this.ctx.currentTime, 0.8);
    s.connect(g).connect(this.master);
    s.start();
    this.ambient = { s, g };
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
    return this.muted;
  }
}
