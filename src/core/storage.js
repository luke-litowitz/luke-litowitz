/**
 * Persistence layer: profile, wallet, unlocks and the local leaderboard.
 *
 * Everything here is defensive by construction. `localStorage` is missing in
 * some embedded webviews, throws `SecurityError` when cookies are blocked, and
 * throws `QuotaExceededError` in Safari private mode *on write only* — so a
 * successful feature probe is not a guarantee. Rather than let any of that
 * reach gameplay code, this module degrades to an in-memory store and keeps
 * the game fully playable; the only thing lost is durability.
 *
 * No function in this file may throw. Callers treat it as infallible.
 */

import { STORAGE_KEY, LEADERBOARD_SIZE, DEFAULT_CHARACTER } from './constants.js';
import { clamp } from './math.js';

/** Schema version written by this build. */
const SCHEMA_VERSION = 1;

/** Trailing-edge debounce window for `saveProfile`. */
const SAVE_DEBOUNCE_MS = 250;
/**
 * Upper bound on how long a write can be deferred. Without it, a caller that
 * saves every frame (coin pickups, say) would reset the debounce forever and
 * nothing would ever hit disk.
 */
const SAVE_MAX_WAIT_MS = 1000;

const DEATH_CAUSES = ['car', 'train', 'water', 'eagle', 'void'];
const QUALITY_VALUES = ['auto', 'low', 'medium', 'high'];
const MAX_NAME_LENGTH = 18;

/** Biome id used when a stored entry predates biome tracking or is corrupt. */
const FALLBACK_BIOME = 'meadow';
/** Stable sentinel so undated entries sort deterministically. */
const EPOCH_ISO = new Date(0).toISOString();

/* ------------------------------------------------------------------ *
 * Default profile
 * ------------------------------------------------------------------ */

/** Build a brand new profile. Fresh object graph every call — never shared. */
function makeDefaultProfile() {
  return {
    version: SCHEMA_VERSION,
    name: 'Player',
    coins: 0,
    bestScore: 0,
    totalRuns: 0,
    totalCoins: 0,
    totalDistance: 0,
    selected: DEFAULT_CHARACTER,
    unlocked: [DEFAULT_CHARACTER],
    leaderboard: [],
    stats: { deaths: { car: 0, train: 0, water: 0, eagle: 0, void: 0 } },
    settings: {
      sfx: true,
      music: true,
      shadows: true,
      quality: 'auto',
      reducedMotion: false,
      cameraShake: true,
    },
    seenTutorial: false,
  };
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Frozen template of a new profile. Read-only: clone it (or call
 * `loadProfile`/`resetProfile`) before mutating.
 * @type {Readonly<object>}
 */
export const DEFAULT_PROFILE = deepFreeze(makeDefaultProfile());

/** Top-level keys this build knows about; anything else is newer-build data. */
const KNOWN_PROFILE_KEYS = new Set(Object.keys(DEFAULT_PROFILE));
/**
 * Never copied out of parsed JSON. `JSON.parse('{"__proto__":…}')` yields an
 * own property, and assigning it back through `obj[key] = …` would reach the
 * `Object.prototype` setter instead of defining a field.
 */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ------------------------------------------------------------------ *
 * safeStorage — feature-detected once, mirrored in memory
 * ------------------------------------------------------------------ */

const memoryStore = new Map();
/**
 * Keys whose durable write failed. Their `memoryStore` copy is newer than
 * whatever `localStorage` still holds, so reads must prefer memory — otherwise
 * a quota error would silently roll the session back to an older profile.
 */
const staleKeys = new Set();
let backend; // undefined = not probed yet, null = unusable.

function probeBackend() {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
    // Access alone can throw under strict cookie policies; a round-trip is the
    // only reliable probe.
    const key = `${STORAGE_KEY}:__probe__`;
    ls.setItem(key, '1');
    ls.removeItem(key);
    return ls;
  } catch {
    return null;
  }
}

const safeStorage = {
  /** @returns {boolean} true when a durable backend was detected. */
  get available() {
    if (backend === undefined) backend = probeBackend();
    return backend !== null;
  },

  /** @returns {string|null} */
  get(key) {
    if (backend === undefined) backend = probeBackend();
    if (backend && !staleKeys.has(key)) {
      try {
        const raw = backend.getItem(key);
        // A durable backend that never rejected a write for this key is
        // authoritative *including when it says "absent"* — falling back to the
        // memory mirror here would resurrect a profile the player (or another
        // tab) deliberately cleared.
        return raw === null || raw === undefined ? null : raw;
      } catch {
        backend = null; // Policy flipped mid-session; stop asking.
      }
    }
    return memoryStore.has(key) ? memoryStore.get(key) : null;
  },

  /** @returns {boolean} true when the value reached durable storage. */
  set(key, value) {
    memoryStore.set(key, value); // Mirror first: the session must stay coherent.
    if (backend === undefined) backend = probeBackend();
    if (!backend) {
      staleKeys.add(key);
      return false;
    }
    try {
      backend.setItem(key, value);
      staleKeys.delete(key);
      return true;
    } catch {
      // Quota exceeded or SecurityError. The memory copy holds the truth now.
      staleKeys.add(key);
      return false;
    }
  },

  remove(key) {
    memoryStore.delete(key);
    staleKeys.delete(key);
    if (backend === undefined) backend = probeBackend();
    if (!backend) return;
    try {
      backend.removeItem(key);
    } catch {
      /* nothing sensible to do; the memory mirror is already clear */
    }
  },
};

/* ------------------------------------------------------------------ *
 * Coercion helpers
 * ------------------------------------------------------------------ */

function toNumber(value, fallback) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return fallback;
}

/** Non-negative integer; negatives clamp to 0. */
function toCount(value, fallback = 0) {
  return clamp(Math.floor(toNumber(value, fallback)), 0, Number.MAX_SAFE_INTEGER);
}

/** Non-negative real (distance can be fractional). */
function toAmount(value, fallback = 0) {
  return clamp(toNumber(value, fallback), 0, Number.MAX_SAFE_INTEGER);
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  }
  return fallback;
}

function toId(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  return s === '' ? fallback : s;
}

function toName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  // Strip control characters so a pasted name cannot break the UI layout.
  const s = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return s === '' ? fallback : s;
}

/* ------------------------------------------------------------------ *
 * Leaderboard entries
 * ------------------------------------------------------------------ */

/**
 * Monotonic counter behind entry ids. Combined with the score and the
 * submission time it yields a stable, collision-free key without touching
 * `Math.random` (which would break replay determinism tooling).
 */
let entrySeq = 0;

function makeEntryId(score, stamp) {
  entrySeq += 1;
  // Zero-padded so the id sorts lexicographically in creation order — plain
  // `${entrySeq}` puts "10" before "9", which inverts the oldest-first
  // tie-break for two runs submitted in the same millisecond.
  return `e${stamp.toString(36)}-${Math.max(0, Math.floor(score))}-${entrySeq
    .toString(36)
    .padStart(8, '0')}`;
}

/**
 * Sort: highest score first, oldest first on a tie (an earlier player keeps
 * the higher slot), id as a final tie-break so the order is total and stable.
 */
function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sanitizeEntry(raw, index, seenIds) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const score = toCount(src.score, 0);

  let date = EPOCH_ISO;
  if (typeof src.date === 'string' || typeof src.date === 'number') {
    const t = new Date(src.date).getTime();
    if (Number.isFinite(t)) date = new Date(t).toISOString();
  }

  let id = toId(src.id, '');
  if (id === '' || seenIds.has(id)) id = `m${index}-${score}-${seenIds.size}`;
  while (seenIds.has(id)) id = `${id}x`;
  seenIds.add(id);

  return {
    id,
    score,
    coins: toCount(src.coins, 0),
    character: toId(src.character, DEFAULT_CHARACTER),
    biome: toId(src.biome, FALLBACK_BIOME),
    date,
  };
}

function sanitizeBoard(raw) {
  if (!Array.isArray(raw)) return [];
  const seenIds = new Set();
  const board = raw.map((entry, i) => sanitizeEntry(entry, i, seenIds));
  board.sort(compareEntries);
  board.length = Math.min(board.length, LEADERBOARD_SIZE);
  return board;
}

/* ------------------------------------------------------------------ *
 * Migration
 * ------------------------------------------------------------------ */

/**
 * Normalise any parsed blob into a valid profile.
 *
 * Rules: missing keys come from the defaults, wrong types are coerced rather
 * than discarded, negatives clamp to 0, `unlocked` is deduped. A version from
 * a *newer* build is preserved and its data kept as-is wherever it still
 * parses — downgrading a player must never wipe their progress.
 *
 * @param {unknown} raw
 * @returns {object} a fresh, fully-populated profile
 */
function migrate(raw) {
  const out = makeDefaultProfile();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;

  const src = /** @type {Record<string, any>} */ (raw);
  const version = toNumber(src.version, SCHEMA_VERSION);
  out.version = version > SCHEMA_VERSION ? version : SCHEMA_VERSION;

  // Top-level fields a newer build added ride along untouched; every known key
  // below overwrites its passthrough copy with a validated value.
  for (const key of Object.keys(src)) {
    if (!KNOWN_PROFILE_KEYS.has(key) && !RESERVED_KEYS.has(key)) out[key] = src[key];
  }

  out.name = toName(src.name, out.name);
  out.coins = toCount(src.coins, 0);
  out.bestScore = toCount(src.bestScore, 0);
  out.totalRuns = toCount(src.totalRuns, 0);
  out.totalCoins = toCount(src.totalCoins, 0);
  out.totalDistance = toAmount(src.totalDistance, 0);
  out.seenTutorial = toBool(src.seenTutorial, false);

  // Unlocks: dedupe, drop junk, and guarantee the starter is always owned.
  if (Array.isArray(src.unlocked)) {
    const set = new Set([DEFAULT_CHARACTER]);
    for (const id of src.unlocked) {
      const clean = toId(id, '');
      if (clean !== '') set.add(clean);
    }
    out.unlocked = [...set];
  }

  // A selection the player does not own would soft-lock character rendering.
  const selected = toId(src.selected, DEFAULT_CHARACTER);
  out.selected = out.unlocked.includes(selected) ? selected : DEFAULT_CHARACTER;

  out.leaderboard = sanitizeBoard(src.leaderboard);
  // Keep the counter ahead of anything already on disk.
  entrySeq += out.leaderboard.length;

  const stats = src.stats && typeof src.stats === 'object' ? src.stats : {};
  // Stat groups a newer build added (streaks, jumps, …) survive a downgrade
  // for the same reason unknown settings do.
  for (const [key, value] of Object.entries(stats)) {
    if (key !== 'deaths' && !RESERVED_KEYS.has(key)) out.stats[key] = value;
  }
  const deaths = stats.deaths && typeof stats.deaths === 'object' ? stats.deaths : {};
  for (const cause of DEATH_CAUSES) out.stats.deaths[cause] = toCount(deaths[cause], 0);
  // Preserve death causes introduced by a newer build instead of dropping them.
  for (const [key, value] of Object.entries(deaths)) {
    if (!DEATH_CAUSES.includes(key) && !RESERVED_KEYS.has(key)) {
      out.stats.deaths[key] = toCount(value, 0);
    }
  }

  const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
  const defaults = out.settings;
  out.settings = {
    // Unknown keys ride along so a newer build's settings survive a downgrade.
    ...settings,
    sfx: toBool(settings.sfx, defaults.sfx),
    music: toBool(settings.music, defaults.music),
    shadows: toBool(settings.shadows, defaults.shadows),
    quality: QUALITY_VALUES.includes(settings.quality) ? settings.quality : defaults.quality,
    reducedMotion: toBool(settings.reducedMotion, defaults.reducedMotion),
    cameraShake: toBool(settings.cameraShake, defaults.cameraShake),
  };

  return out;
}

/* ------------------------------------------------------------------ *
 * Load / save
 * ------------------------------------------------------------------ */

let pendingProfile = null;
let saveTimer = null;
let firstPendingAt = 0;
let listenersBound = false;

function writeNow(profile) {
  let json;
  try {
    json = JSON.stringify(profile);
  } catch {
    return false; // Cyclic or non-serialisable: drop the write, keep playing.
  }
  return safeStorage.set(STORAGE_KEY, json);
}

function cancelPending() {
  if (saveTimer !== null && typeof clearTimeout === 'function') clearTimeout(saveTimer);
  saveTimer = null;
  firstPendingAt = 0;
  pendingProfile = null;
}

/** Write the newest pending profile immediately. Safe to call at any time. */
function flushSave() {
  const profile = pendingProfile;
  if (saveTimer !== null && typeof clearTimeout === 'function') clearTimeout(saveTimer);
  saveTimer = null;
  firstPendingAt = 0;
  pendingProfile = null;
  if (profile) writeNow(profile);
}

/**
 * Bound lazily on first save so importing this module never touches the DOM.
 * `visibilitychange` covers mobile backgrounding (where `unload` never fires)
 * and `pagehide` covers bfcache navigations.
 */
function bindFlushListeners() {
  if (listenersBound) return;
  listenersBound = true;
  try {
    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', () => {
        if (doc.visibilityState === 'hidden') flushSave();
      });
    }
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('pagehide', flushSave);
    }
  } catch {
    /* headless or locked-down host: the debounced write still runs */
  }
}

/**
 * Read the stored profile, migrating and validating it.
 * Corrupt JSON or an unavailable backend yields a fresh default profile.
 * @returns {object} a mutable profile object
 */
export function loadProfile() {
  let raw = null;
  try {
    raw = safeStorage.get(STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (typeof raw !== 'string' || raw === '') return makeDefaultProfile();

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt blob: start clean but leave it on disk — the next save overwrites
    // it, and destroying it here would forfeit any chance of manual recovery.
    return makeDefaultProfile();
  }
  return migrate(parsed);
}

/**
 * Persist a profile. Debounced (~250 ms, trailing) and flushed automatically
 * when the page is hidden or unloaded, so rapid updates cost one write.
 * @param {object} profile
 * @returns {boolean} true when the write was accepted for scheduling
 */
export function saveProfile(profile) {
  if (!profile || typeof profile !== 'object') return false;
  pendingProfile = profile;
  bindFlushListeners();

  if (typeof setTimeout !== 'function') {
    flushSave();
    return true;
  }

  const now = Date.now();
  if (!firstPendingAt) firstPendingAt = now;
  // Debounce, but never defer past the max-wait deadline.
  const wait = clamp(firstPendingAt + SAVE_MAX_WAIT_MS - now, 0, SAVE_DEBOUNCE_MS);
  if (saveTimer !== null && typeof clearTimeout === 'function') clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, wait);
  return true;
}

/**
 * Wipe all stored progress and return a brand new profile.
 * @returns {object}
 */
export function resetProfile() {
  cancelPending(); // A queued save must not resurrect the old profile.
  const fresh = makeDefaultProfile();
  try {
    safeStorage.remove(STORAGE_KEY);
  } catch {
    /* handled inside safeStorage; belt and braces */
  }
  writeNow(fresh);
  return fresh;
}

/* ------------------------------------------------------------------ *
 * Wallet & unlocks
 * ------------------------------------------------------------------ */

/**
 * Credit coins to the wallet. Also accrues the lifetime `totalCoins` stat.
 * @param {object} profile
 * @param {number} amount coins to add; non-positive or invalid values are ignored
 * @returns {number} the new balance
 */
export function addCoins(profile, amount) {
  if (!profile || typeof profile !== 'object') return 0;
  const n = toCount(amount, 0);
  profile.coins = toCount(profile.coins, 0) + n;
  profile.totalCoins = toCount(profile.totalCoins, 0) + n;
  if (n > 0) saveProfile(profile);
  return profile.coins;
}

/**
 * Debit coins if the player can afford it.
 * @param {object} profile
 * @param {number} amount
 * @returns {boolean} true when the balance covered the cost and was debited
 */
export function spendCoins(profile, amount) {
  if (!profile || typeof profile !== 'object') return false;
  const cost = toCount(amount, 0);
  const balance = toCount(profile.coins, 0);
  profile.coins = balance;
  if (cost > balance) return false;
  profile.coins = balance - cost;
  if (cost > 0) saveProfile(profile);
  return true;
}

/**
 * Grant a character. Idempotent.
 * @param {object} profile
 * @param {string} id character id
 * @returns {boolean} true when this call performed the unlock
 */
export function unlockCharacter(profile, id) {
  if (!profile || typeof profile !== 'object') return false;
  const clean = toId(id, '');
  if (clean === '') return false;
  if (!Array.isArray(profile.unlocked)) profile.unlocked = [DEFAULT_CHARACTER];
  if (profile.unlocked.includes(clean)) return false;
  profile.unlocked.push(clean);
  saveProfile(profile);
  return true;
}

/**
 * @param {object} profile
 * @param {string} id character id
 * @returns {boolean} true when the character is owned (the starter always is)
 */
export function isUnlocked(profile, id) {
  const clean = toId(id, '');
  if (clean === '') return false;
  if (clean === DEFAULT_CHARACTER) return true;
  if (!profile || !Array.isArray(profile.unlocked)) return false;
  return profile.unlocked.includes(clean);
}

/* ------------------------------------------------------------------ *
 * Leaderboard
 * ------------------------------------------------------------------ */

/**
 * Record a finished run: files it on the leaderboard and rolls up lifetime
 * stats. The wallet is *not* credited here — coins are banked by `addCoins`
 * during the run, so doing it again would double-count.
 *
 * @param {object} profile
 * @param {{score:number, coins?:number, character?:string, biome?:string, distance?:number}} entry
 * @returns {{rank:number|null, isBest:boolean}} 1-based rank on the kept board
 *   (`null` if the run missed the cut), and whether it beat the previous best
 */
export function submitScore(profile, entry) {
  if (!profile || typeof profile !== 'object') return { rank: null, isBest: false };
  const src = entry && typeof entry === 'object' ? entry : {};

  const score = toCount(src.score, 0);
  const coins = toCount(src.coins, 0);
  const previousBest = toCount(profile.bestScore, 0);
  const stamp = Date.now();

  const record = {
    id: makeEntryId(score, stamp),
    score,
    coins,
    character: toId(src.character, toId(profile.selected, DEFAULT_CHARACTER)),
    biome: toId(src.biome, FALLBACK_BIOME),
    date: new Date(stamp).toISOString(),
  };

  const board = Array.isArray(profile.leaderboard) ? profile.leaderboard : [];
  board.push(record);
  board.sort(compareEntries);
  board.length = Math.min(board.length, LEADERBOARD_SIZE);
  profile.leaderboard = board;

  profile.bestScore = Math.max(previousBest, score);
  profile.totalRuns = toCount(profile.totalRuns, 0) + 1;
  // `totalCoins` is accrued by `addCoins` as the run banks each coin, so the
  // run total must NOT be added again here — that double-counted the lifetime
  // stat on every run.
  profile.totalCoins = toCount(profile.totalCoins, 0);
  // Distance defaults to the score: one point is one row crossed.
  profile.totalDistance = toAmount(profile.totalDistance, 0) + toAmount(src.distance, score);

  const index = board.indexOf(record);
  saveProfile(profile);
  return { rank: index >= 0 ? index + 1 : null, isBest: score > previousBest };
}

/**
 * Leaderboard for display: sorted, capped, and a defensive copy so the UI can
 * never mutate stored state.
 * @param {object} profile
 * @returns {Array<{id:string,score:number,coins:number,character:string,biome:string,date:string}>}
 */
export function getLeaderboard(profile) {
  if (!profile || !Array.isArray(profile.leaderboard)) return [];
  const board = profile.leaderboard
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      id: toId(e.id, ''),
      score: toCount(e.score, 0),
      coins: toCount(e.coins, 0),
      character: toId(e.character, DEFAULT_CHARACTER),
      biome: toId(e.biome, FALLBACK_BIOME),
      date: typeof e.date === 'string' ? e.date : EPOCH_ISO,
    }));
  board.sort(compareEntries);
  board.length = Math.min(board.length, LEADERBOARD_SIZE);
  return board;
}

/**
 * Drop every leaderboard entry. Lifetime stats and the wallet are untouched.
 * @param {object} profile
 * @returns {object} the same profile, for chaining
 */
export function clearLeaderboard(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  profile.leaderboard = [];
  saveProfile(profile);
  return profile;
}
