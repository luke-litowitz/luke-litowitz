/**
 * Difficulty curves and the safety rules that make every generated stretch of
 * world provably crossable.
 *
 * The important idea here: gaps are *derived from* speed rather than rolled
 * independently. A lane is only legal if a player standing in it gets a
 * traffic-free window long enough to hop out of. That turns "is this level
 * fair?" from a play-testing question into an invariant.
 */

import { clamp, lerp, smoothstep } from '../core/math.js';
import {
  DIFFICULTY_MAX_SCORE,
  HOP_DURATION,
  PLAYER_HALF_W,
  COL_COUNT,
  TRAFFIC_MARGIN,
  TILE,
} from '../core/constants.js';

/** Total length of one traffic cycle. Vehicles wrap seamlessly over this. */
export const TRAFFIC_SPAN = COL_COUNT * TILE + 2 * TRAFFIC_MARGIN;

/**
 * Reaction window a player is guaranteed while standing in a lane, in seconds.
 * Shrinks with difficulty but never below "one hop plus a beat".
 */
export function safeWindow(t) {
  return lerp(0.95, 0.46, t);
}

/**
 * Minimum clear distance between two vehicles in a lane, derived from speed.
 *
 *   window = (gap - playerWidth) / speed  >=  safeWindow(t)
 *
 * so gap >= playerWidth + speed * safeWindow(t). Solving it this way means a
 * fast lane automatically becomes a sparse lane.
 */
export function minSafeGap(speed, t) {
  return 2 * PLAYER_HALF_W + speed * safeWindow(t) + HOP_DURATION * speed * 0.5;
}

/**
 * Difficulty snapshot for a score. Everything the generator needs.
 * @param {number} score
 */
export function difficultyAt(score) {
  const raw = clamp(score / DIFFICULTY_MAX_SCORE, 0, 1);
  // Ease so the first 40 rows ramp gently and the top end plateaus.
  const t = smoothstep(0, 1, raw);

  return {
    score,
    t,

    /* Road */
    carSpeed: [lerp(2.4, 5.4, t), lerp(4.0, 8.2, t)],
    // Extra slack on top of the derived minimum, so lanes are not all identical.
    gapSlack: [lerp(0.6, 0.15, t), lerp(3.4, 1.1, t)],
    maxRoadRun: Math.round(lerp(2, 5, t)),
    honkChance: lerp(0.12, 0.3, t),

    /* Water */
    logSpeed: [lerp(1.0, 1.9, t), lerp(1.9, 3.3, t)],
    // Reachable ceiling is meanLogLength / (meanLogLength + LOG_GAP[0]);
    // with 1-4 tile logs that is ~0.77, so these floors always have headroom.
    logCoverage: lerp(0.62, 0.46, t),
    logLength: [1, Math.round(lerp(4, 3, t))],
    maxWaterRun: Math.round(lerp(2, 4, t)),
    lilyChance: lerp(0.3, 0.14, t),

    /* Rail */
    trainSpeed: lerp(19, 30, t),
    trainCars: [Math.round(lerp(3, 4, t)), Math.round(lerp(5, 7, t))],
    trainWindow: lerp(4.2, 2.3, t),
    maxRailRun: Math.round(lerp(1, 2, t)),

    /* Grass */
    obstacleDensity: lerp(0.14, 0.3, t),
    grassRun: [1, Math.round(lerp(3, 2, t))],

    /* Economy */
    coinChance: lerp(0.3, 0.2, t),

    /* Row-type weights (grass is handled separately as the connective tissue) */
    weights: {
      road: lerp(0.52, 0.42, t),
      water: lerp(0.2, 0.29, t),
      rail: lerp(0.08, 0.18, t),
      grass: lerp(0.2, 0.11, t),
    },
  };
}

/**
 * Vehicle speed is clamped so nothing ever moves faster than the swept
 * collision can comfortably resolve, and so lanes stay readable.
 */
export const MAX_VEHICLE_SPEED = 9;
export const MAX_TRAIN_SPEED = 32;

/** Minimum/maximum gap between platforms in a water row, in tiles. */
export const LOG_GAP = [0.75, 2.7];

/**
 * Adjacent water rows must differ in signed velocity by at least this much.
 * Guarantees the two rows drift relative to each other, so a rider always
 * eventually gets a landing window instead of being permanently stranded.
 */
export const MIN_WATER_VELOCITY_DELTA = 0.45;

/** Score thresholds at which new hazards are introduced. */
export const UNLOCK_SCORE = {
  water: 6,
  rail: 14,
  truck: 10,
  bus: 22,
  powerups: 8,
};
