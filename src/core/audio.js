/**
 * Crossy Cascade — 100% procedural audio engine.
 *
 * There is not a single audio file in this project: every sound effect is a
 * few oscillators, a filter and an envelope, and the soundtrack is a
 * generative 16-step sequencer. That keeps the download at zero bytes and
 * lets sounds react to gameplay (pitch per character, slow-mo detune,
 * intensity-driven music) in ways sample playback never could.
 *
 * Browser realities this module works around:
 *   - An AudioContext may not be created (or may not start) outside a user
 *     gesture, so construction is free and `unlock()` does the real work.
 *   - Everything before `unlock()` must be a silent no-op, never a throw:
 *     the game calls `play()` from deep inside the simulation.
 *   - `StereoPannerNode` is missing on older Safari, so panning is optional.
 *
 * Scheduling note: the music sequencer uses the standard lookahead pattern —
 * a coarse `setInterval` wakes up often enough to queue notes a little ahead
 * of `ctx.currentTime`. Note timing therefore comes from the audio clock, not
 * from the (jittery, throttled-in-background) timer clock.
 */

import { clamp, lerp, hashInt, SeededRNG } from './math.js';

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Hard cap on simultaneous SFX sources; past this, requests are dropped. */
const MAX_VOICES = 24;
/** Length of the shared white-noise buffer, in seconds. */
const NOISE_SECONDS = 2;
/** How often the sequencer wakes up (ms) and how far ahead it queues (s). */
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.1;
const STEPS_PER_BAR = 16;
/** Identical sounds closer together than this comb-filter into mush. */
const RETRIGGER_GAP = 0.016;
/** Scheduling every voice a hair in the future keeps ramps click-free. */
const LEAD_IN = 0.005;

const MASTER_DEFAULT = 0.8;
const SFX_LEVEL = 0.9;
const MUSIC_LEVEL = 0.42;

const noop = () => {};

/** Equal-temperament MIDI note -> Hz. */
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Stable integer seed from a biome id, so each biome improvises differently. */
function seedFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return hashInt(h) || 1;
}

/* Hoisted note tables — hot paths must not allocate arrays. */
const COIN_RUN = [1046.5, 1318.5, 1568.0, 2093.0];
const UNLOCK_ARP = [523.25, 659.25, 783.99, 1046.5, 1318.5];
const MILESTONE_ARP = [659.25, 830.61, 987.77, 1318.5];
const BUY_NOTES = [1174.7, 1567.98];

/* ------------------------------------------------------------------ *
 * Music themes — one per biome id in palette.js BIOMES
 * ------------------------------------------------------------------ */

/**
 * `root` is a MIDI note; chords and scale degrees are semitone offsets from
 * it. Bass plays two octaves below the chord root, the lead one octave above.
 */
const MUSIC_THEMES = {
  meadow: {
    bpm: 116,
    root: 60, // C4 — bright and major
    progression: [[0, 4, 7], [9, 12, 16], [5, 9, 12], [7, 11, 14]],
    scale: [0, 2, 4, 7, 9, 12, 14, 16],
    bassWave: 'triangle',
    padWave: 'sawtooth',
    leadWave: 'triangle',
    cutoff: 1100,
  },
  sunset: {
    bpm: 104,
    root: 58, // Bb3 mixolydian — warm and lazy
    progression: [[0, 4, 7], [10, 14, 17], [5, 9, 12], [0, 4, 7]],
    scale: [0, 2, 4, 7, 9, 10, 12, 14],
    bassWave: 'triangle',
    padWave: 'sawtooth',
    leadWave: 'sine',
    cutoff: 900,
  },
  dusk: {
    bpm: 122,
    root: 57, // A3 natural minor
    progression: [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]],
    scale: [0, 3, 5, 7, 10, 12, 15, 17],
    bassWave: 'square',
    padWave: 'sawtooth',
    leadWave: 'triangle',
    cutoff: 850,
  },
  night: {
    bpm: 132,
    root: 50, // D3 dorian — driving neon
    progression: [[0, 3, 7], [5, 9, 12], [0, 3, 7], [10, 14, 17]],
    scale: [0, 2, 3, 5, 7, 9, 12, 14],
    bassWave: 'sawtooth',
    padWave: 'square',
    leadWave: 'square',
    cutoff: 1200,
  },
  frost: {
    bpm: 96,
    root: 62, // D4 lydian — glassy and wide
    progression: [[0, 4, 7], [2, 6, 9], [9, 12, 16], [7, 11, 14]],
    scale: [0, 2, 4, 6, 7, 11, 12, 14],
    bassWave: 'sine',
    padWave: 'triangle',
    leadWave: 'sine',
    cutoff: 1400,
  },
};

/* ------------------------------------------------------------------ *
 * AudioManager
 * ------------------------------------------------------------------ */

/**
 * The game's single audio front-end: procedural SFX plus a generative
 * soundtrack, both driven entirely by oscillators and one shared noise buffer.
 *
 * Construction is inert — nothing touches WebAudio until `unlock()` runs
 * inside a user gesture, and every method is a no-op until then.
 *
 * @example
 * const audio = new AudioManager();
 * canvas.addEventListener('pointerdown', () => audio.unlock(), { once: true });
 * audio.play('hop', { rate: 1.2, type: 'triangle', pan: -0.3 });
 * audio.startMusic('night');
 */
export class AudioManager {
  constructor() {
    /** @type {AudioContext|null} */
    this._ctx = null;
    this._master = null;
    this._compressor = null;
    this._sfx = null;
    this._musicBus = null;
    this._musicFilter = null;
    this._bassBus = null;
    this._padBus = null;
    this._leadBus = null;
    this._hatBus = null;

    this._masterVolume = MASTER_DEFAULT;
    this._sfxEnabled = true;
    this._musicEnabled = true;
    this._suspended = false;
    this._panSupported = false;

    /** Live SFX sources, capped at MAX_VOICES. */
    this._voices = 0;
    /** name -> last start time, to suppress machine-gun retriggers. */
    this._lastAt = new Map();

    this._timeScale = 1;
    /** Frequency multiplier applied to SFX; drops during slow-mo. */
    this._sfxPitch = 1;
    /** Frequency multiplier applied to music notes. */
    this._musicPitch = 1;

    this._theme = MUSIC_THEMES.meadow;
    this._musicRng = new SeededRNG(seedFromId('meadow'));
    this._music = {
      wanted: false,
      playing: false,
      biomeId: 'meadow',
      intensity: 0.35,
      step: 0,
      bar: 0,
      nextTime: 0,
      timer: null,
    };
    this._boundTick = () => this._scheduleAhead();

    // The noise source for every splash, crash and hi-hat is generated once
    // here and resampled per voice, so nothing allocates a buffer at runtime.
    const rng = new SeededRNG(0x5eed1e);
    const len = Math.floor(NOISE_SECONDS * 48000);
    this._noiseData = new Float32Array(len);
    for (let i = 0; i < len; i++) this._noiseData[i] = rng.next() * 2 - 1;
    /** @type {AudioBuffer|null} */
    this._noiseBuffer = null;
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Create (or wake) the AudioContext. Must be called from a user gesture —
   * every browser blocks or auto-suspends contexts created outside one.
   * Safe to call repeatedly.
   * @returns {boolean} true when audio is usable.
   */
  unlock() {
    if (this._ctx) {
      this._resumeContext();
      this._syncMusic();
      return this.ready;
    }
    const Ctor =
      typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctor) return false;

    let ctx;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
    } catch {
      try {
        ctx = new Ctor();
      } catch {
        return false; // No audio on this device; the game plays on regardless.
      }
    }
    this._ctx = ctx;

    try {
      this._buildGraph(ctx);
    } catch {
      // A half-built graph is worse than none: drop it and run silent.
      this._ctx = null;
      try {
        ctx.close();
      } catch {
        /* Nothing more we can do. */
      }
      return false;
    }

    // iOS only truly unlocks after a source has run inside the gesture.
    try {
      const kick = ctx.createBufferSource();
      kick.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      kick.connect(this._master);
      kick.start(0);
    } catch {
      /* Best effort only. */
    }

    this._resumeContext();
    this._syncMusic();
    return this.ready;
  }

  /** @returns {boolean} true once a usable AudioContext exists. */
  get ready() {
    return !!this._ctx && this._ctx.state !== 'closed';
  }

  /**
   * Wire master -> compressor -> destination with independent sfx/music buses.
   * The compressor is gentle: it exists to stop a pile-up of coins plus a
   * train horn from clipping, not to pump.
   * @param {AudioContext} ctx
   */
  _buildGraph(ctx) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.22;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this._masterVolume;
    master.connect(comp);

    const sfx = ctx.createGain();
    sfx.gain.value = this._sfxEnabled ? SFX_LEVEL : 0;
    sfx.connect(master);

    const musicBus = ctx.createGain();
    musicBus.gain.value = 0; // faded in by _syncMusic
    musicBus.connect(master);

    const musicFilter = ctx.createBiquadFilter();
    musicFilter.type = 'lowpass';
    musicFilter.Q.value = 0.9;
    musicFilter.frequency.value = this._cutoffForIntensity();
    musicFilter.connect(musicBus);

    const mk = (level) => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(musicFilter);
      return g;
    };

    this._compressor = comp;
    this._master = master;
    this._sfx = sfx;
    this._musicBus = musicBus;
    this._musicFilter = musicFilter;
    this._bassBus = mk(0.5);
    this._padBus = mk(0.2);
    this._leadBus = mk(0.26);
    this._hatBus = mk(0.16);

    this._panSupported = typeof ctx.createStereoPanner === 'function';

    const frames = Math.max(1, Math.floor(NOISE_SECONDS * ctx.sampleRate));
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const dst = buf.getChannelData(0);
    const src = this._noiseData;
    // Wrap rather than resample: white noise is white at any sample rate.
    for (let i = 0; i < frames; i++) dst[i] = src[i % src.length];
    this._noiseBuffer = buf;
  }

  /** Halt everything. Idempotent and safe before `unlock()`. */
  suspend() {
    this._suspended = true;
    this._syncMusic();
    const ctx = this._ctx;
    if (!ctx || ctx.state === 'closed') return;
    try {
      const p = ctx.suspend();
      if (p && p.catch) p.catch(noop);
    } catch {
      /* Some browsers reject suspend() while still starting up. */
    }
  }

  /** Resume after `suspend()`. Idempotent and safe before `unlock()`. */
  resume() {
    this._suspended = false;
    this._resumeContext();
    this._syncMusic();
  }

  /** Ask the context to run again; harmless when it already is. */
  _resumeContext() {
    const ctx = this._ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const p = ctx.resume();
      if (p && p.catch) p.catch(noop);
    } catch {
      /* Still blocked: the next gesture will try again. */
    }
  }

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  /**
   * @param {boolean} on
   */
  setSfxEnabled(on) {
    this._sfxEnabled = !!on;
    if (this._sfx) this._ramp(this._sfx.gain, this._sfxEnabled ? SFX_LEVEL : 0, 0.03);
  }

  /**
   * @param {boolean} on
   */
  setMusicEnabled(on) {
    this._musicEnabled = !!on;
    this._syncMusic();
  }

  /**
   * @param {number} v 0..1
   */
  setMasterVolume(v) {
    this._masterVolume = clamp(Number(v) || 0, 0, 1);
    if (this._master) this._ramp(this._master.gain, this._masterVolume, 0.05);
  }

  /**
   * Slow-motion hook: bends music tempo and detunes SFX downward.
   * @param {number} s time scale, 1 = normal.
   */
  setTimeScale(s) {
    const t = clamp(Number(s) || 1, 0.1, 2);
    this._timeScale = t;
    // Under-pitching hard sells slow-mo; over-pitching stays subtle so a
    // speed-up never turns the mix into chipmunks.
    this._sfxPitch = t < 1 ? lerp(0.62, 1, t) : lerp(1, 1.12, clamp(t - 1, 0, 1));
    this._musicPitch = t < 1 ? lerp(0.72, 1, t) : 1;
  }

  /* ---------------------------------------------------------------- *
   * SFX
   * ---------------------------------------------------------------- */

  /**
   * Fire one sound effect. Never throws, and does nothing before `unlock()`.
   * @param {string} name one of the names in ARCHITECTURE.md §4.
   * @param {{rate?:number, gain?:number, pan?:number, type?:OscillatorType}} [opts]
   *   `rate` multiplies every frequency and shortens the envelope, `pan` is
   *   -1..1 (ignored where StereoPannerNode is unavailable), `type`
   *   overrides the oscillator waveform of tonal voices.
   */
  play(name, opts) {
    const ctx = this._ctx;
    if (!ctx || ctx.state === 'closed' || !this._sfxEnabled) return;
    if (this._voices >= MAX_VOICES) return; // Drop, never glitch.
    this._resumeContext(); // Unlocked but auto-suspended: wake on demand.

    const now = ctx.currentTime;
    const last = this._lastAt.get(name);
    if (last !== undefined && now - last < RETRIGGER_GAP) return;
    this._lastAt.set(name, now);

    const rate = clamp((opts && opts.rate) || 1, 0.25, 4);
    const vol = clamp(opts && opts.gain !== undefined ? opts.gain : 1, 0, 4);
    const pan = opts && opts.pan ? clamp(opts.pan, -1, 1) : 0;
    const type = (opts && opts.type) || null;

    const group = this._beginGroup(pan);
    try {
      this._voice(name, group, now + LEAD_IN, rate * this._sfxPitch, 1 / rate, vol, type);
    } catch {
      /* A malformed automation must not take gameplay down with it. */
    }
    if (group.pending === 0) this._disposeGroup(group);
  }

  /**
   * Build one named voice.
   * @param {string} name
   * @param {object} g voice group
   * @param {number} t0 start time on the audio clock
   * @param {number} p frequency multiplier
   * @param {number} d duration multiplier
   * @param {number} v gain multiplier
   * @param {OscillatorType|null} w waveform override
   */
  _voice(name, g, t0, p, d, v, w) {
    const ctx = this._ctx;

    switch (name) {
      /* -------- movement -------- */
      case 'hop':
        // Fast upward pitch sweep on a triangle: the classic cartoon "boop".
        this._tone(g, {
          t0,
          freq: 300 * p,
          endFreq: 700 * p,
          type: w || 'triangle',
          dur: 0.085 * d,
          peak: 0.32 * v,
          attack: 0.003,
        });
        break;

      case 'jump-land':
        this._tone(g, {
          t0,
          freq: 240 * p,
          endFreq: 110 * p,
          type: w || 'sine',
          dur: 0.075 * d,
          peak: 0.26 * v,
        });
        this._noise(g, {
          t0,
          dur: 0.05 * d,
          peak: 0.08 * v,
          filter: 'lowpass',
          f1: 2400 * p,
          f2: 700 * p,
          q: 0.7,
        });
        break;

      /* -------- economy -------- */
      case 'coin': {
        // Two-note major third — the universal "you got something" cue.
        const type = w || 'square';
        this._tone(g, { t0, freq: 1046.5 * p, type, dur: 0.06 * d, peak: 0.14 * v });
        this._tone(g, {
          t0: t0 + 0.055 * d,
          freq: 1318.5 * p,
          type,
          dur: 0.11 * d,
          peak: 0.14 * v,
        });
        break;
      }

      case 'coin-big': {
        const type = w || 'square';
        for (let i = 0; i < COIN_RUN.length; i++) {
          this._tone(g, {
            t0: t0 + i * 0.05 * d,
            freq: COIN_RUN[i] * p,
            type,
            dur: (i === COIN_RUN.length - 1 ? 0.2 : 0.07) * d,
            peak: 0.13 * v,
          });
        }
        break;
      }

      case 'buy':
        for (let i = 0; i < BUY_NOTES.length; i++) {
          this._tone(g, {
            t0: t0 + i * 0.07 * d,
            freq: BUY_NOTES[i] * p,
            type: w || 'triangle',
            dur: (i ? 0.22 : 0.08) * d,
            peak: 0.16 * v,
          });
        }
        this._noise(g, {
          t0,
          dur: 0.09 * d,
          peak: 0.06 * v,
          filter: 'highpass',
          f1: 5200 * p,
          f2: 8000 * p,
          q: 0.6,
        });
        break;

      case 'unlock': {
        const type = w || 'triangle';
        for (let i = 0; i < UNLOCK_ARP.length; i++) {
          this._tone(g, {
            t0: t0 + i * 0.075 * d,
            freq: UNLOCK_ARP[i] * p,
            type,
            dur: (i === UNLOCK_ARP.length - 1 ? 0.45 : 0.14) * d,
            peak: 0.13 * v,
          });
          // A cent-detuned twin gives the fanfare a chorused shimmer.
          this._tone(g, {
            t0: t0 + i * 0.075 * d,
            freq: UNLOCK_ARP[i] * p,
            type,
            detune: 9,
            dur: (i === UNLOCK_ARP.length - 1 ? 0.45 : 0.14) * d,
            peak: 0.09 * v,
          });
        }
        break;
      }

      case 'milestone':
        for (let i = 0; i < MILESTONE_ARP.length; i++) {
          this._tone(g, {
            t0: t0 + i * 0.06 * d,
            freq: MILESTONE_ARP[i] * p,
            type: w || 'square',
            dur: (i === MILESTONE_ARP.length - 1 ? 0.34 : 0.1) * d,
            peak: 0.12 * v,
          });
        }
        this._tone(g, {
          t0,
          freq: MILESTONE_ARP[0] * 0.5 * p,
          type: 'triangle',
          dur: 0.4 * d,
          peak: 0.1 * v,
          attack: 0.01,
        });
        break;

      /* -------- hazards -------- */
      case 'splash': {
        // Bandpass sweeping down = water closing over the top of something.
        this._noise(g, {
          t0,
          dur: 0.42 * d,
          peak: 0.34 * v,
          filter: 'bandpass',
          f1: 1900 * p,
          f2: 340 * p,
          q: 1.4,
          attack: 0.006,
        });
        this._tone(g, {
          t0,
          freq: 420 * p,
          endFreq: 130 * p,
          type: 'sine',
          dur: 0.16 * d,
          peak: 0.2 * v,
        });
        break;
      }

      case 'crash':
        // Lowpassed noise (the impact) over a detuned square thud (the mass).
        this._noise(g, {
          t0,
          dur: 0.34 * d,
          peak: 0.3 * v,
          filter: 'lowpass',
          f1: 1600 * p,
          f2: 260 * p,
          q: 1.1,
        });
        this._tone(g, {
          t0,
          freq: 96 * p,
          endFreq: 42 * p,
          type: 'square',
          dur: 0.28 * d,
          peak: 0.3 * v,
        });
        this._tone(g, {
          t0,
          freq: 96 * p,
          endFreq: 42 * p,
          type: 'square',
          detune: -26,
          dur: 0.3 * d,
          peak: 0.22 * v,
        });
        break;

      case 'thud':
        this._tone(g, {
          t0,
          freq: 150 * p,
          endFreq: 58 * p,
          type: w || 'sine',
          dur: 0.14 * d,
          peak: 0.3 * v,
        });
        this._noise(g, {
          t0,
          dur: 0.06 * d,
          peak: 0.08 * v,
          filter: 'lowpass',
          f1: 900 * p,
          f2: 220 * p,
          q: 0.7,
        });
        break;

      case 'train-horn': {
        // Two detuned sawtooths a fourth apart, bent down at the tail: the
        // pitch drop is the Doppler shift of something huge going past.
        const type = w || 'sawtooth';
        const dur = 0.95 * d;
        const base = 186 * p;
        const filt = this._sharedFilter(g, t0, 'lowpass', 1500 * p, 900 * p, 0.8, dur);
        for (let i = 0; i < 2; i++) {
          const f = i === 0 ? base : base * 1.335; // horn dyad, roughly a fourth
          for (let k = 0; k < 2; k++) {
            this._tone(g, {
              t0,
              freq: f,
              endFreq: f * 0.84,
              freqHold: dur * 0.55,
              type,
              detune: k ? 7 : -7,
              dur,
              peak: 0.13 * v,
              attack: 0.035,
              hold: dur * 0.62,
              release: dur * 0.34,
              dest: filt,
            });
          }
        }
        break;
      }

      case 'train-pass':
        // Bandpass swelling up then away — a whoosh with a rumble underneath.
        this._noise(g, {
          t0,
          dur: 1.15 * d,
          peak: 0.26 * v,
          filter: 'bandpass',
          f1: 280 * p,
          fMid: 1500 * p,
          f2: 240 * p,
          q: 0.9,
          attack: 0.3 * d,
          hold: 0.25 * d,
          release: 0.55 * d,
          rate: 0.85,
        });
        this._tone(g, {
          t0,
          freq: 62 * p,
          endFreq: 48 * p,
          type: 'triangle',
          dur: 1.0 * d,
          peak: 0.14 * v,
          attack: 0.25 * d,
          hold: 0.35 * d,
          release: 0.4 * d,
        });
        break;

      case 'eagle': {
        // A screech is a bright saw torn apart by fast frequency modulation.
        const dur = 0.55 * d;
        const osc = ctx.createOscillator();
        osc.type = w || 'sawtooth';
        osc.frequency.setValueAtTime(760 * p, t0);
        osc.frequency.exponentialRampToValueAtTime(1750 * p, t0 + dur * 0.35);
        osc.frequency.exponentialRampToValueAtTime(620 * p, t0 + dur);

        const lfo = ctx.createOscillator();
        lfo.type = 'sine';
        lfo.frequency.setValueAtTime(31 * p, t0);
        lfo.frequency.linearRampToValueAtTime(19 * p, t0 + dur);
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.setValueAtTime(280 * p, t0);
        lfo.connect(lfoDepth);
        lfoDepth.connect(osc.frequency);

        const band = ctx.createBiquadFilter();
        band.type = 'bandpass';
        band.Q.value = 2.2;
        band.frequency.setValueAtTime(1500 * p, t0);
        band.frequency.exponentialRampToValueAtTime(2600 * p, t0 + dur);

        const amp = ctx.createGain();
        osc.connect(band);
        band.connect(amp);
        amp.connect(g.out);
        const stop = this._adsr(amp.gain, t0, 0.16 * v, 0.02, dur * 0.5, dur * 0.5);
        g.nodes.push(band, amp, lfoDepth);
        this._start(g, osc, t0, stop);
        this._start(g, lfo, t0, stop);
        break;
      }

      case 'death':
        // Everything falls: pitch, filter and confidence.
        this._tone(g, {
          t0,
          freq: 440 * p,
          endFreq: 88 * p,
          type: w || 'sawtooth',
          dur: 0.6 * d,
          peak: 0.2 * v,
          attack: 0.01,
          hold: 0.3 * d,
          release: 0.32 * d,
          dest: this._sharedFilter(g, t0, 'lowpass', 2400 * p, 380 * p, 3, 0.6 * d),
        });
        this._tone(g, {
          t0: t0 + 0.02,
          freq: 220 * p,
          endFreq: 55 * p,
          type: 'triangle',
          dur: 0.55 * d,
          peak: 0.16 * v,
        });
        break;

      /* -------- power-ups -------- */
      case 'powerup': {
        // Resonant lowpass sweeping open over a stacked fifth.
        const dur = 0.5 * d;
        const filt = this._sharedFilter(g, t0, 'lowpass', 260 * p, 5200 * p, 11, dur);
        this._tone(g, {
          t0,
          freq: 110 * p,
          endFreq: 220 * p,
          type: w || 'sawtooth',
          dur,
          peak: 0.16 * v,
          attack: 0.01,
          hold: dur * 0.6,
          release: dur * 0.38,
          dest: filt,
        });
        this._tone(g, {
          t0,
          freq: 165 * p,
          endFreq: 330 * p,
          type: w || 'sawtooth',
          detune: 6,
          dur,
          peak: 0.12 * v,
          attack: 0.01,
          hold: dur * 0.6,
          release: dur * 0.38,
          dest: filt,
        });
        this._tone(g, {
          t0: t0 + dur * 0.55,
          freq: 1318.5 * p,
          type: 'triangle',
          dur: 0.22 * d,
          peak: 0.12 * v,
        });
        break;
      }

      case 'powerup-end': {
        const dur = 0.4 * d;
        const filt = this._sharedFilter(g, t0, 'lowpass', 4200 * p, 420 * p, 8, dur);
        this._tone(g, {
          t0,
          freq: 330 * p,
          endFreq: 110 * p,
          type: w || 'sawtooth',
          dur,
          peak: 0.15 * v,
          attack: 0.008,
          hold: dur * 0.4,
          release: dur * 0.55,
          dest: filt,
        });
        this._tone(g, {
          t0,
          freq: 349 * p,
          endFreq: 116 * p,
          type: w || 'sawtooth',
          detune: -18, // a beating semitone reads as "wearing off"
          dur,
          peak: 0.1 * v,
          attack: 0.008,
          hold: dur * 0.4,
          release: dur * 0.55,
          dest: filt,
        });
        break;
      }

      case 'shield-break':
        // Glass: a high detuned pair plus a bright noise shatter.
        this._noise(g, {
          t0,
          dur: 0.36 * d,
          peak: 0.2 * v,
          filter: 'highpass',
          f1: 2400 * p,
          f2: 6400 * p,
          q: 0.8,
        });
        this._tone(g, { t0, freq: 1760 * p, type: w || 'square', dur: 0.1 * d, peak: 0.12 * v });
        this._tone(g, {
          t0,
          freq: 1760 * p,
          type: w || 'square',
          detune: 31,
          dur: 0.12 * d,
          peak: 0.1 * v,
        });
        this._tone(g, {
          t0: t0 + 0.08 * d,
          freq: 880 * p,
          endFreq: 300 * p,
          type: 'triangle',
          dur: 0.26 * d,
          peak: 0.12 * v,
        });
        break;

      /* -------- UI -------- */
      case 'menu-move':
        this._tone(g, {
          t0,
          freq: 660 * p,
          type: w || 'sine',
          dur: 0.045 * d,
          peak: 0.11 * v,
          attack: 0.002,
        });
        break;

      case 'menu-select':
        this._tone(g, { t0, freq: 660 * p, type: w || 'square', dur: 0.05 * d, peak: 0.1 * v });
        this._tone(g, {
          t0: t0 + 0.05 * d,
          freq: 988 * p,
          type: w || 'square',
          dur: 0.12 * d,
          peak: 0.1 * v,
        });
        break;

      case 'menu-back':
        this._tone(g, { t0, freq: 620 * p, type: w || 'square', dur: 0.05 * d, peak: 0.09 * v });
        this._tone(g, {
          t0: t0 + 0.05 * d,
          freq: 415 * p,
          type: w || 'square',
          dur: 0.13 * d,
          peak: 0.09 * v,
        });
        break;

      case 'countdown':
        this._tone(g, {
          t0,
          freq: 880 * p,
          type: w || 'sine',
          dur: 0.14 * d,
          peak: 0.18 * v,
          attack: 0.004,
        });
        this._tone(g, {
          t0,
          freq: 1760 * p,
          type: 'sine',
          dur: 0.05 * d,
          peak: 0.05 * v,
        });
        break;

      case 'tick':
        this._noise(g, {
          t0,
          dur: 0.022 * d,
          peak: 0.09 * v,
          filter: 'highpass',
          f1: 4200 * p,
          f2: 6000 * p,
          q: 0.9,
          attack: 0.001,
        });
        this._tone(g, {
          t0,
          freq: 2200 * p,
          type: w || 'sine',
          dur: 0.022 * d,
          peak: 0.06 * v,
          attack: 0.001,
        });
        break;

      case 'error':
        // Two short low buzzes — gated, so it reads as a refusal not a note.
        for (let i = 0; i < 2; i++) {
          this._tone(g, {
            t0: t0 + i * 0.11 * d,
            freq: 150 * p,
            type: w || 'square',
            dur: 0.075 * d,
            peak: 0.16 * v,
            attack: 0.004,
          });
        }
        break;

      default:
        // Unknown names are ignored: a typo must never crash the game.
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * Voice plumbing
   * ---------------------------------------------------------------- */

  /**
   * A voice group owns every node built for one `play()` call so the shared
   * panner/filter is disconnected exactly once — when the *last* source ends,
   * not the first (which would cut longer layers short).
   * @param {number} pan
   */
  _beginGroup(pan) {
    const g = { pending: 0, nodes: [], out: this._sfx, counted: true };
    if (pan && this._panSupported) {
      const panner = this._ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(this._sfx);
      g.nodes.push(panner);
      g.out = panner;
    }
    return g;
  }

  /** Music notes get their own uncounted group so SFX never starve them. */
  _bgGroup(bus) {
    return { pending: 0, nodes: [], out: bus, counted: false };
  }

  _disposeGroup(g) {
    for (const n of g.nodes) {
      try {
        n.disconnect();
      } catch {
        /* Already torn down. */
      }
    }
    g.nodes.length = 0;
  }

  /**
   * Register and schedule a source node, freeing its chain on 'ended'.
   * @param {object} g voice group
   * @param {AudioScheduledSourceNode} src
   * @param {number} t0
   * @param {number} stopAt
   * @param {number} [offset] buffer read offset; <0 means "not a buffer".
   */
  _start(g, src, t0, stopAt, offset = -1) {
    if (g.counted) this._voices++;
    g.pending++;
    src.onended = () => {
      if (g.counted) this._voices = Math.max(0, this._voices - 1);
      try {
        src.disconnect();
      } catch {
        /* Already torn down. */
      }
      if (--g.pending <= 0) this._disposeGroup(g);
    };
    try {
      if (offset >= 0) src.start(t0, offset);
      else src.start(t0);
      src.stop(Math.max(stopAt, t0 + 0.02));
    } catch {
      if (g.counted) this._voices = Math.max(0, this._voices - 1);
      g.pending--;
    }
  }

  /**
   * Percussive envelope: quick attack then an exponential tail.
   * @returns {number} a stop time by which the tail is inaudible (~0.2%).
   */
  _env(param, t0, peak, dur, attack = 0.006) {
    const a = Math.min(attack, dur * 0.5);
    const tc = Math.max(0.005, (dur - a) * 0.28);
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    param.setTargetAtTime(0.00008, t0 + a, tc);
    return t0 + a + tc * 6 + 0.01;
  }

  /** Attack / hold / release envelope for sustained voices. */
  _adsr(param, t0, peak, attack, hold, release) {
    const a = Math.max(0.002, attack);
    const h = Math.max(0, hold);
    const r = Math.max(0.01, release);
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    param.setValueAtTime(Math.max(0.0002, peak), t0 + a + h);
    param.linearRampToValueAtTime(0.0001, t0 + a + h + r);
    return t0 + a + h + r + 0.02;
  }

  /** Smooth a static AudioParam to a value without clicking. */
  _ramp(param, value, seconds = 0.04) {
    const ctx = this._ctx;
    if (!ctx) return;
    try {
      param.setTargetAtTime(value, ctx.currentTime, Math.max(0.005, seconds / 3));
    } catch {
      param.value = value;
    }
  }

  /**
   * A filter shared by several voices in one group, so the sweep applies to
   * the whole stack rather than to each oscillator separately.
   * @returns {BiquadFilterNode}
   */
  _sharedFilter(g, t0, type, f1, f2, q, dur) {
    const ctx = this._ctx;
    const bq = ctx.createBiquadFilter();
    bq.type = type;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(Math.max(30, f1), t0);
    bq.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t0 + Math.max(0.02, dur));
    bq.connect(g.out);
    g.nodes.push(bq);
    return bq;
  }

  /**
   * One oscillator voice.
   * @param {object} g voice group
   * @param {object} o {t0, freq, endFreq?, freqHold?, type?, detune?, dur,
   *   peak, attack?, hold?, release?, dest?}
   */
  _tone(g, o) {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'triangle';
    const dur = Math.max(0.02, o.dur);
    const f0 = Math.max(20, o.freq);
    osc.frequency.setValueAtTime(f0, o.t0);
    if (o.freqHold) osc.frequency.setValueAtTime(f0, o.t0 + o.freqHold);
    if (o.endFreq && o.endFreq !== o.freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.endFreq), o.t0 + dur);
    }
    if (o.detune) osc.detune.setValueAtTime(o.detune, o.t0);

    const amp = ctx.createGain();
    osc.connect(amp);
    amp.connect(o.dest || g.out);
    g.nodes.push(amp);

    const stop =
      o.release !== undefined
        ? this._adsr(amp.gain, o.t0, o.peak, o.attack ?? 0.01, o.hold ?? dur * 0.5, o.release)
        : this._env(amp.gain, o.t0, o.peak, dur, o.attack);
    this._start(g, osc, o.t0, stop);
  }

  /**
   * One filtered white-noise voice, read from the shared buffer.
   * @param {object} g voice group
   * @param {object} o {t0, dur, peak, filter?, f1?, fMid?, f2?, q?, rate?,
   *   attack?, hold?, release?, dest?}
   */
  _noise(g, o) {
    const ctx = this._ctx;
    if (!this._noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.playbackRate.value = clamp(o.rate || 1, 0.25, 4);

    const dur = Math.max(0.02, o.dur);
    let node = src;
    if (o.filter) {
      const bq = ctx.createBiquadFilter();
      bq.type = o.filter;
      bq.Q.value = o.q ?? 1;
      const f1 = Math.max(30, o.f1 ?? 1000);
      bq.frequency.setValueAtTime(f1, o.t0);
      if (o.fMid) {
        bq.frequency.exponentialRampToValueAtTime(Math.max(30, o.fMid), o.t0 + dur * 0.45);
      }
      if (o.f2) bq.frequency.exponentialRampToValueAtTime(Math.max(30, o.f2), o.t0 + dur);
      src.connect(bq);
      g.nodes.push(bq);
      node = bq;
    }

    const amp = ctx.createGain();
    node.connect(amp);
    amp.connect(o.dest || g.out);
    g.nodes.push(amp);

    const stop =
      o.release !== undefined
        ? this._adsr(amp.gain, o.t0, o.peak, o.attack ?? 0.01, o.hold ?? dur * 0.4, o.release)
        : this._env(amp.gain, o.t0, o.peak, dur, o.attack);

    // Cosmetic only: a random read offset stops repeated hits from sounding
    // identical (and from phase-cancelling when they overlap).
    const span = Math.max(0, this._noiseBuffer.duration - dur - 0.1);
    this._start(g, src, o.t0, stop, span > 0 ? Math.random() * span : 0);
  }

  /* ---------------------------------------------------------------- *
   * Generative music
   * ---------------------------------------------------------------- */

  /**
   * Start (or retheme) the soundtrack. Safe before `unlock()` — the request
   * is remembered and honoured as soon as audio comes up.
   * @param {string} [biomeId] one of the ids in palette.js BIOMES.
   */
  startMusic(biomeId = 'meadow') {
    const id = MUSIC_THEMES[biomeId] ? biomeId : 'meadow';
    if (id !== this._music.biomeId || !this._music.wanted) {
      this._music.biomeId = id;
      this._theme = MUSIC_THEMES[id];
      // Reseed so every biome improvises its own recognisable variation.
      this._musicRng.reset(seedFromId(id));
      if (this._musicFilter) this._ramp(this._musicFilter.frequency, this._cutoffForIntensity(), 0.6);
    }
    this._music.wanted = true;
    this._syncMusic();
  }

  /** Fade the soundtrack out and stop scheduling. */
  stopMusic() {
    this._music.wanted = false;
    this._syncMusic();
  }

  /**
   * Drive the arrangement from gameplay pressure.
   * @param {number} v 0 = calm, 1 = frantic (more lead notes, brighter, hats).
   */
  setMusicIntensity(v) {
    this._music.intensity = clamp(Number(v) || 0, 0, 1);
    if (this._musicFilter) this._ramp(this._musicFilter.frequency, this._cutoffForIntensity(), 0.5);
    if (this._leadBus) this._ramp(this._leadBus.gain, lerp(0.18, 0.32, this._music.intensity), 0.5);
  }

  _cutoffForIntensity() {
    const base = this._theme ? this._theme.cutoff : 1000;
    return clamp(base * lerp(0.65, 3.4, this._music ? this._music.intensity : 0.35), 200, 12000);
  }

  /** Reconcile the sequencer with wanted/enabled/suspended/ready state. */
  _syncMusic() {
    const m = this._music;
    const shouldRun = this.ready && m.wanted && this._musicEnabled && !this._suspended;
    if (shouldRun === m.playing) return;

    if (shouldRun) {
      m.playing = true;
      m.step = 0;
      m.bar = 0;
      m.nextTime = this._ctx.currentTime + 0.08;
      this._ramp(this._musicBus.gain, MUSIC_LEVEL, 0.8);
      if (m.timer === null) m.timer = setInterval(this._boundTick, LOOKAHEAD_MS);
      this._scheduleAhead();
    } else {
      m.playing = false;
      if (m.timer !== null) {
        clearInterval(m.timer);
        m.timer = null;
      }
      // Notes already queued ring out into a ducked bus rather than cutting.
      if (this._musicBus) this._ramp(this._musicBus.gain, 0, 0.35);
    }
  }

  /** Seconds per sixteenth step, slowed by the time scale. */
  _stepDuration() {
    const bpm = this._theme.bpm;
    const scale = clamp(this._timeScale, 0.1, 2);
    return clamp(60 / bpm / 4 / scale, 0.04, 2);
  }

  /**
   * Lookahead scheduler: queue every step that falls inside the next
   * SCHEDULE_AHEAD seconds of the audio clock.
   */
  _scheduleAhead() {
    const ctx = this._ctx;
    const m = this._music;
    if (!ctx || !m.playing || ctx.state === 'closed') return;

    // A backgrounded tab freezes the timer while the audio clock runs on;
    // resynchronise instead of frantically scheduling the missed bars.
    if (m.nextTime < ctx.currentTime) m.nextTime = ctx.currentTime + 0.05;

    const stepDur = this._stepDuration();
    const limit = ctx.currentTime + SCHEDULE_AHEAD;
    let guard = 64;
    while (m.nextTime < limit && guard-- > 0) {
      try {
        this._scheduleStep(m.step, m.nextTime, stepDur);
      } catch {
        /* Never let a bad note kill the sequencer. */
      }
      m.nextTime += stepDur;
      m.step++;
      if (m.step >= STEPS_PER_BAR) {
        m.step = 0;
        m.bar++;
      }
    }
  }

  /**
   * Emit one sixteenth: a bass pulse, a pad chord on the downbeat, sparse
   * pentatonic lead and (at intensity) a hat.
   * @param {number} step 0..15
   * @param {number} time audio-clock start time
   * @param {number} stepDur
   */
  _scheduleStep(step, time, stepDur) {
    const th = this._theme;
    const m = this._music;
    const rng = this._musicRng;
    const inten = m.intensity;
    const p = this._musicPitch;
    const chord = th.progression[m.bar % th.progression.length];
    const rootMidi = th.root + chord[0];

    // Bass on the quarters, with ghost notes once things get busy.
    if (step % 4 === 0 || (inten > 0.5 && (step === 3 || step === 11))) {
      const ghost = step % 4 !== 0;
      const midi = rootMidi - 24 + (step === 8 && rng.chance(0.3) ? 7 : 0);
      const f = midiToFreq(midi) * p;
      const g = this._bgGroup(this._bassBus);
      this._tone(g, {
        t0: time,
        freq: f * 1.05,
        endFreq: f,
        type: th.bassWave,
        dur: stepDur * (ghost ? 0.8 : 1.7),
        peak: ghost ? 0.18 : 0.34,
        attack: 0.004,
      });
    }

    // Pad: one soft chord per bar, long attack and release.
    if (step === 0) {
      const barDur = stepDur * STEPS_PER_BAR;
      for (let i = 0; i < chord.length; i++) {
        const g = this._bgGroup(this._padBus);
        this._tone(g, {
          t0: time,
          freq: midiToFreq(th.root + chord[i]) * p,
          type: th.padWave,
          detune: i === 1 ? 5 : i === 2 ? -5 : 0, // slight spread = width
          dur: barDur,
          peak: 0.11,
          attack: barDur * 0.22,
          hold: barDur * 0.4,
          release: barDur * 0.38,
        });
      }
    }

    // Hats arrive with intensity and mark the offbeats.
    if (inten > 0.28 && step % 2 === 1) {
      const g = this._bgGroup(this._hatBus);
      this._noise(g, {
        t0: time,
        dur: 0.045,
        peak: 0.1 * inten * (step % 4 === 3 ? 1.4 : 1),
        filter: 'highpass',
        f1: 7000,
        f2: 9000,
        q: 0.8,
        attack: 0.001,
        rate: 1.6,
      });
    }

    // Lead: sparse when calm, chattering when frantic. Chord tones land on
    // strong steps so the improvisation always agrees with the harmony.
    const density = 0.1 + inten * 0.5;
    const strong = step % 4 === 0;
    if ((step % 2 === 0 || (inten > 0.7 && rng.chance(0.35))) && rng.chance(density)) {
      const degree = strong
        ? chord[rng.int(0, chord.length - 1)]
        : th.scale[rng.int(0, th.scale.length - 1)];
      const octave = rng.chance(0.25 + inten * 0.2) ? 12 : 0;
      const g = this._bgGroup(this._leadBus);
      this._tone(g, {
        t0: time,
        freq: midiToFreq(th.root + 12 + degree + octave) * p,
        type: th.leadWave,
        dur: stepDur * (rng.chance(0.3) ? 2.2 : 1.1),
        peak: 0.16,
        attack: 0.006,
      });
    }
  }
}
