/**
 * Normalised vehicle table.
 *
 * `src/render/models.js` owns the art; this module is the single place that
 * turns that art data into the numbers physics and world generation trust.
 * Normalising here means a bad or missing field in the art data degrades into
 * a sane vehicle instead of an invisible NaN that breaks every collision.
 */

import { VEHICLE_TYPES } from '../render/models.js';
import { clamp } from '../core/math.js';
import { UNLOCK_SCORE } from './config.js';

const MAX_VEHICLE_WIDTH = 0.95;

function normalise(entry, i) {
  const length = Number.isFinite(entry?.length) && entry.length > 0 ? entry.length : 1.7;
  const width = clamp(
    Number.isFinite(entry?.width) && entry.width > 0 ? entry.width : 0.9,
    0.4,
    MAX_VEHICLE_WIDTH,
  );
  return {
    id: entry?.id ?? `vehicle-${i}`,
    kind: entry?.kind ?? 'car',
    length,
    width,
    halfLength: length / 2,
    halfWidth: width / 2,
    weight: Number.isFinite(entry?.weight) ? entry.weight : 1,
    speedMul: clamp(Number.isFinite(entry?.speedMul) ? entry.speedMul : 1, 0.5, 1.6),
    honk: entry?.honk !== false,
    spec: typeof entry?.spec === 'function' ? entry.spec : null,
  };
}

export const VEHICLES = (Array.isArray(VEHICLE_TYPES) ? VEHICLE_TYPES : []).map(normalise);

if (VEHICLES.length === 0) {
  // Never let a broken art module take the game down.
  VEHICLES.push(normalise({ id: 'car', kind: 'car', length: 1.7, width: 0.9 }, 0));
}

const byId = new Map(VEHICLES.map((v) => [v.id, v]));

/** @param {string} id */
export function vehicleById(id) {
  return byId.get(id) || VEHICLES[0];
}

/**
 * Vehicle kinds available at a given score. Big vehicles are held back early
 * so the opening lanes read clearly.
 */
export function availableVehicles(score) {
  return VEHICLES.filter((v) => {
    if (v.kind === 'truck') return score >= UNLOCK_SCORE.truck;
    if (v.kind === 'bus') return score >= UNLOCK_SCORE.bus;
    return true;
  });
}

/**
 * Pick a vehicle type for one lane slot.
 * @param {import('../core/math.js').SeededRNG} rng
 * @param {number} score
 * @param {string} [laneKind] keep a lane thematically consistent when given
 */
export function pickVehicle(rng, score, laneKind) {
  const pool = availableVehicles(score);
  const filtered = laneKind ? pool.filter((v) => v.kind === laneKind) : pool;
  const use = filtered.length ? filtered : pool;
  return rng.pick(use);
}

/** Longest vehicle currently in play — used to size traffic cycles. */
export function maxVehicleLength(score) {
  return availableVehicles(score).reduce((m, v) => Math.max(m, v.length), 0);
}
