/**
 * Pure maths helpers: grid conversion, easing, deterministic RNG and the
 * swept-AABB solver that every collision in the game funnels through.
 *
 * Nothing in here touches Three.js or the DOM, so it is unit-testable under
 * plain Node (see `test/math.test.mjs`).
 */

import { TILE } from './constants.js';

/* ------------------------------------------------------------------ *
 * Scalar helpers
 * ------------------------------------------------------------------ */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));

export function smoothstep(edge0, edge1, x) {
  const t = clamp(invLerp(edge0, edge1, x), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach.
 * `rate` is roughly "how many e-folds per second".
 */
export function damp(current, target, rate, dt) {
  return lerp(target, current, Math.exp(-rate * dt));
}

export function approach(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Shortest signed angular difference, radians. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function dampAngle(current, target, rate, dt) {
  return current + angleDelta(current, target) * (1 - Math.exp(-rate * dt));
}

/* ------------------------------------------------------------------ *
 * Grid <-> world
 * ------------------------------------------------------------------ */

export const colToX = (col) => col * TILE;
export const rowToZ = (row) => -row * TILE;
export const xToCol = (x) => Math.round(x / TILE);
export const zToRow = (z) => Math.round(-z / TILE);

/* ------------------------------------------------------------------ *
 * Hop curves
 * ------------------------------------------------------------------ */

/**
 * Ballistic height profile over a normalised hop, peaking at 1 in the middle.
 * `4t(1-t)` is the exact shape of a projectile under constant gravity when
 * launch and landing heights match, so the arc is physically faithful.
 */
export const hopArc = (t) => 4 * t * (1 - t);

/**
 * Horizontal progress of a hop. Slightly eased so the take-off reads as a
 * push and the landing as a plant, while remaining monotonic (never
 * overshoots, so the swept collision stays well defined).
 */
export function hopEase(t) {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
}

/* ------------------------------------------------------------------ *
 * Axis-aligned boxes in the XZ plane
 * ------------------------------------------------------------------ */

/** @returns {{minX:number,maxX:number,minZ:number,maxZ:number}} */
export function makeAABB(cx, cz, halfW, halfD) {
  return { minX: cx - halfW, maxX: cx + halfW, minZ: cz - halfD, maxZ: cz + halfD };
}

export function setAABB(out, cx, cz, halfW, halfD) {
  out.minX = cx - halfW;
  out.maxX = cx + halfW;
  out.minZ = cz - halfD;
  out.maxZ = cz + halfD;
  return out;
}

export function aabbOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export function aabbContainsPoint(a, x, z) {
  return x >= a.minX && x <= a.maxX && z >= a.minZ && z <= a.maxZ;
}

/**
 * Swept AABB using the slab method.
 *
 * Box `a` is displaced by (dx, dz) over one step while box `b` stays put.
 * Pass the *relative* displacement when both boxes move.
 *
 * @returns {{t:number, nx:number, nz:number}|null}
 *   `t` is the normalised time of first contact in [0, 1]; `nx`/`nz` is the
 *   surface normal of the face that was hit. `null` when there is no hit.
 *   An initial overlap reports `t = 0`.
 */
export function sweptAABB(a, dx, dz, b) {
  if (aabbOverlap(a, b)) {
    // Already intersecting: report immediate contact, normal opposes motion.
    const nx = dx > 0 ? -1 : dx < 0 ? 1 : 0;
    const nz = dz > 0 ? -1 : dz < 0 ? 1 : 0;
    return { t: 0, nx, nz };
  }

  let tEnterX = -Infinity;
  let tExitX = Infinity;
  let tEnterZ = -Infinity;
  let tExitZ = Infinity;

  if (dx === 0) {
    if (a.maxX <= b.minX || a.minX >= b.maxX) return null;
  } else {
    const t1 = (b.minX - a.maxX) / dx;
    const t2 = (b.maxX - a.minX) / dx;
    tEnterX = Math.min(t1, t2);
    tExitX = Math.max(t1, t2);
  }

  if (dz === 0) {
    if (a.maxZ <= b.minZ || a.minZ >= b.maxZ) return null;
  } else {
    const t1 = (b.minZ - a.maxZ) / dz;
    const t2 = (b.maxZ - a.minZ) / dz;
    tEnterZ = Math.min(t1, t2);
    tExitZ = Math.max(t1, t2);
  }

  const tEnter = Math.max(tEnterX, tEnterZ);
  const tExit = Math.min(tExitX, tExitZ);

  if (tEnter > tExit || tExit < 0 || tEnter > 1) return null;
  if (tEnter < 0) return null; // moving apart

  let nx = 0;
  let nz = 0;
  if (tEnterX > tEnterZ) nx = dx > 0 ? -1 : 1;
  else nz = dz > 0 ? -1 : 1;

  return { t: tEnter, nx, nz };
}

/**
 * Convenience wrapper: does a moving box collide with a static box at any
 * point during the step? Handles the both-moving case for the caller.
 */
export function sweepHits(a, aVx, aVz, b, bVx, bVz, dt) {
  return sweptAABB(a, (aVx - bVx) * dt, (aVz - bVz) * dt, b) !== null;
}

/* ------------------------------------------------------------------ *
 * Deterministic RNG (mulberry32)
 * ------------------------------------------------------------------ */

export class SeededRNG {
  constructor(seed = 1) {
    this.seed = seed >>> 0 || 1;
    this._s = this.seed;
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0 || 1;
    this._s = this.seed;
    return this;
  }

  /** @returns {number} uniform in [0, 1) */
  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** Inclusive integer range. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1 - 1e-9));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /**
   * Pick from `[{ weight, ...}]`. Falls back to the last entry when all
   * weights are zero.
   */
  weighted(entries, weightOf = (e) => e.weight) {
    let total = 0;
    for (const e of entries) total += Math.max(0, weightOf(e));
    if (total <= 0) return entries[entries.length - 1];
    let r = this.next() * total;
    for (const e of entries) {
      r -= Math.max(0, weightOf(e));
      if (r <= 0) return e;
    }
    return entries[entries.length - 1];
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/** 32-bit integer hash, handy for stable per-row variation. */
export function hashInt(n) {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic float in [0,1) from an integer pair. */
export function hash01(a, b = 0) {
  return hashInt(hashInt(a) ^ Math.imul(b + 1, 0x9e3779b9)) / 4294967296;
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function formatNumber(n) {
  return Math.floor(n).toLocaleString('en-US');
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
