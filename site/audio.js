// audio.js — everything is synthesised with WebAudio, no sample files.
let ctx = null, master = null, sfxBus = null, musicBus = null, ambBus = null;
let enabled = true, started = false;
let rainGain = null, rainNode = null, windGain = null;
let musicTimer = null;

export function audioEnabled() { return enabled; }
export function setEnabled(v) {
  enabled = v;
  if (master) master.gain.setTargetAtTime(v ? 0.8 : 0, ctx.currentTime, 0.05);
}
export function ensureAudio() {
  if (started) return;
  started = true;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) { started = false; return; }
  master = ctx.createGain(); master.gain.value = enabled ? 0.8 : 0; master.connect(ctx.destination);
  sfxBus = ctx.createGain(); sfxBus.gain.value = 0.55; sfxBus.connect(master);
  musicBus = ctx.createGain(); musicBus.gain.value = 0.28; musicBus.connect(master);
  ambBus = ctx.createGain(); ambBus.gain.value = 0.5; ambBus.connect(master);
  startAmbience();
  startMusic();
}
export function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }

// ---------------------------------------------------------------- helpers
function noiseBuffer(seconds = 2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
let _noise = null;
function noise() { return _noise || (_noise = noiseBuffer(2)); }
function env(g, t, a, d, peak = 1, sustain = 0) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t + a + d);
}
function tone(type, f0, f1, dur, vol, bus = sfxBus, attack = 0.005) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  env(g, t, attack, dur, vol);
  o.connect(g); g.connect(bus);
  o.start(t); o.stop(t + dur + 0.05);
}
function burst(dur, vol, filt = 'bandpass', f0 = 1200, f1 = 300, q = 0.8, bus = sfxBus) {
  const s = ctx.createBufferSource(); s.buffer = noise(); s.loop = true;
  const f = ctx.createBiquadFilter(); f.type = filt; f.Q.value = q;
  const t = ctx.currentTime;
  f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
  const g = ctx.createGain(); env(g, t, 0.004, dur, vol);
  s.connect(f); f.connect(g); g.connect(bus);
  s.start(t); s.stop(t + dur + 0.05);
}

// ---------------------------------------------------------------- sfx
const SFX = {
  swing() { burst(0.16, 0.25, 'bandpass', 900, 2400, 1.2); },
  heavy() { burst(0.32, 0.45, 'lowpass', 1800, 200, 0.7); tone('sine', 180, 60, 0.3, 0.3); },
  hit() { burst(0.08, 0.3, 'bandpass', 1800, 500, 1.5); tone('square', 220, 90, 0.07, 0.12); },
  crit() { burst(0.12, 0.4, 'highpass', 1200, 3000, 1); tone('triangle', 660, 220, 0.15, 0.2); },
  kill() { burst(0.22, 0.4, 'lowpass', 1400, 120, 0.8); tone('sawtooth', 160, 40, 0.25, 0.15); },
  ember() { tone('sine', 880, 1320, 0.09, 0.18); },
  shard() { tone('triangle', 1046, 1568, 0.12, 0.2); tone('sine', 1568, 2093, 0.14, 0.1); },
  heart() { tone('sine', 523, 784, 0.18, 0.25); tone('sine', 784, 1046, 0.22, 0.15); },
  hurt() { burst(0.18, 0.5, 'lowpass', 600, 80, 0.5); tone('sine', 120, 50, 0.2, 0.4); },
  dash() { burst(0.22, 0.35, 'bandpass', 400, 2600, 0.6); },
  nova() { burst(0.7, 0.7, 'lowpass', 3000, 100, 0.4); tone('sine', 90, 30, 0.7, 0.6); tone('triangle', 900, 200, 0.4, 0.2); },
  levelup() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone('triangle', f, f, 0.35, 0.3), i * 90)); },
  forge() { tone('square', 660, 660, 0.08, 0.15); setTimeout(() => { burst(0.2, 0.35, 'highpass', 3000, 6000, 1); tone('sine', 1800, 1200, 0.25, 0.2); }, 80); },
  spit() { burst(0.14, 0.25, 'bandpass', 500, 1500, 2); },
  roar() { tone('sawtooth', 70, 45, 1.4, 0.5); burst(1.2, 0.5, 'lowpass', 500, 120, 0.4); },
  slam() { burst(0.5, 0.8, 'lowpass', 900, 60, 0.5); tone('sine', 60, 25, 0.6, 0.8); },
  ui() { tone('sine', 740, 740, 0.06, 0.12); },
  district() { [523, 659, 784].forEach((f, i) => setTimeout(() => tone('triangle', f, f, 0.5, 0.22), i * 120)); },
  thunder() { burst(2.2, 0.9, 'lowpass', 700, 40, 0.3, ambBus); setTimeout(() => burst(1.4, 0.5, 'lowpass', 300, 40, 0.3, ambBus), 300); },
  win() { [392, 523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => tone('triangle', f, f, 0.6, 0.3), i * 140)); },
  lose() { [440, 349, 293, 220].forEach((f, i) => setTimeout(() => tone('sine', f, f * 0.98, 0.7, 0.3), i * 260)); },
};
let lastAt = {};
export function sfx(name, minGap = 0.03) {
  if (!ctx || !enabled) return;
  const now = ctx.currentTime;
  if (lastAt[name] && now - lastAt[name] < minGap) return;
  lastAt[name] = now;
  try { SFX[name](); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- ambience (rain / wind), driven by weather each frame
function startAmbience() {
  const s = ctx.createBufferSource(); s.buffer = noiseBuffer(4); s.loop = true;
  const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2400; f.Q.value = 0.5;
  rainGain = ctx.createGain(); rainGain.gain.value = 0;
  s.connect(f); f.connect(rainGain); rainGain.connect(ambBus); s.start();
  rainNode = f;
  const w = ctx.createBufferSource(); w.buffer = noiseBuffer(4); w.loop = true;
  const wf = ctx.createBiquadFilter(); wf.type = 'lowpass'; wf.frequency.value = 320; wf.Q.value = 0.7;
  windGain = ctx.createGain(); windGain.gain.value = 0;
  w.connect(wf); wf.connect(windGain); windGain.connect(ambBus); w.start();
  // slow wind LFO
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.11; const lg = ctx.createGain(); lg.gain.value = 120;
  lfo.connect(lg); lg.connect(wf.frequency); lfo.start();
}
export function setAmbience(rain, wind) {
  if (!rainGain) return;
  const t = ctx.currentTime;
  rainGain.gain.setTargetAtTime(rain * 0.5, t, 0.8);
  windGain.gain.setTargetAtTime(wind * 0.35, t, 1.2);
}

// ---------------------------------------------------------------- music: slow evolving pad, chord changes every 8 s
const CHORDS = [
  [220.0, 261.6, 329.6, 392.0],   // Am7
  [174.6, 220.0, 261.6, 329.6],   // Fmaj7
  [196.0, 246.9, 293.7, 349.2],   // G
  [164.8, 196.0, 246.9, 293.7],   // Em7
];
let padOsc = [], padFilter = null, chordIdx = 0, tension = 0;
let bassGain = null, arpGain = null, arpOsc = null, arpStep = 0, layerTargets = { bass: 0, arp: 0 };
function startMusic() {
  padFilter = ctx.createBiquadFilter(); padFilter.type = 'lowpass'; padFilter.frequency.value = 600; padFilter.Q.value = 0.6;
  const padGain = ctx.createGain(); padGain.gain.value = 0.25;
  padFilter.connect(padGain); padGain.connect(musicBus);
  const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07; const lg = ctx.createGain(); lg.gain.value = 220;
  lfo.connect(lg); lg.connect(padFilter.frequency); lfo.start();
  for (let i = 0; i < 4; i++) {
    for (const det of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sawtooth'; o.detune.value = det;
      const g = ctx.createGain(); g.gain.value = 0.12;
      o.connect(g); g.connect(padFilter); o.start();
      padOsc.push({ o, g, voice: i });
    }
  }
  // layer 2: low pulse (threat >= 5 or low health)
  bassGain = ctx.createGain(); bassGain.gain.value = 0; bassGain.connect(musicBus);
  const bass = ctx.createOscillator(); bass.type = 'sine'; bass.frequency.value = 55;
  const bassEnv = ctx.createGain(); bassEnv.gain.value = 0.4;
  const pulse = ctx.createOscillator(); pulse.type = 'square'; pulse.frequency.value = 2; const pg = ctx.createGain(); pg.gain.value = 0.35;
  pulse.connect(pg); pg.connect(bassEnv.gain);
  bass.connect(bassEnv); bassEnv.connect(bassGain); bass.start(); pulse.start();
  // layer 3: arpeggio (boss)
  arpGain = ctx.createGain(); arpGain.gain.value = 0; arpGain.connect(musicBus);
  arpOsc = ctx.createOscillator(); arpOsc.type = 'triangle'; arpOsc.frequency.value = 440;
  const arpEnv = ctx.createGain(); arpEnv.gain.value = 0.3;
  const af = ctx.createBiquadFilter(); af.type = 'lowpass'; af.frequency.value = 2200;
  arpOsc.connect(af); af.connect(arpEnv); arpEnv.connect(arpGain); arpOsc.start();
  setInterval(() => { if (!ctx) return; const notes = CHORDS[chordIdx]; const f = notes[arpStep % 4] * (arpStep % 8 < 4 ? 2 : 4); arpStep++; const t = ctx.currentTime; arpOsc.frequency.setValueAtTime(f, t); arpEnv.gain.cancelScheduledValues(t); arpEnv.gain.setValueAtTime(0.35, t); arpEnv.gain.exponentialRampToValueAtTime(0.02, t + 0.13); }, 140);
  setChord(0);
  musicTimer = setInterval(() => setChord((chordIdx + 1) % CHORDS.length), 8000);
}
export function layerState() { return Object.assign({}, layerTargets, { tension }); }
function setChord(i) {
  chordIdx = i;
  const t = ctx.currentTime;
  for (const p of padOsc) p.o.frequency.setTargetAtTime(CHORDS[i][p.voice] * (tension > 0.5 ? 0.5 : 1), t, 1.5);
}
export function setTension(v) {
  // v 0..1 — boss fight / low health: darker, brighter filter
  tension = v;
  if (!padFilter) return;
  padFilter.frequency.setTargetAtTime(600 + v * 1400, ctx.currentTime, 2);
  layerTargets = { bass: v >= 0.45 ? 0.16 : 0, arp: v >= 0.9 ? 0.11 : 0 };
  bassGain.gain.setTargetAtTime(layerTargets.bass, ctx.currentTime, 1.5);
  arpGain.gain.setTargetAtTime(layerTargets.arp, ctx.currentTime, 1.0);
}
export function musicVolume(v) { if (musicBus) musicBus.gain.setTargetAtTime(v, ctx.currentTime, 0.5); }
export function sfxVolume(v) { if (sfxBus) sfxBus.gain.setTargetAtTime(v, ctx.currentTime, 0.1); }
