/**
 * Power-up catalogue: pure data plus the voxel spec for the floating pickup
 * crate. The effect runtime (stacking, timers, world time scale) lives in
 * `src/game/powerups.js`; nothing in this file touches game state, Three.js
 * or the DOM, so it stays trivially testable and cheap to import.
 *
 * Every crate is the same silhouette — an open cage around a glowing core —
 * so the player learns "cage = power-up" once, and only the colour and the
 * face emblem tell them *which* one it is. That reads at arcade speed far
 * better than five bespoke shapes.
 */

import { DIFFICULTY_MAX_SCORE } from '../core/constants.js';
import { clamp, lerp, smoothstep } from '../core/math.js';
import { PALETTE } from '../render/palette.js';

/* ------------------------------------------------------------------ *
 * Crate geometry constants
 * ------------------------------------------------------------------ */

/** Distance from the crate centre to a cage bar's centreline. */
const CAGE_HALF = 0.2;
/** Square cross-section of every cage bar. */
const CAGE_BAR = 0.055;
/** Corner cubes are fatter than the bars, which is what fakes the bevel. */
const CAGE_CORNER = 0.075;
/** Half-size of the whole crate; also its centre height, so y = 0 is the bottom. */
const CRATE_HALF = CAGE_HALF + CAGE_CORNER / 2; // 0.2375 -> fits inside 0.6
/** Plane the face emblems sit on: flush with the outside of the cage bars. */
const EMBLEM_R = CAGE_HALF + CAGE_BAR / 2 - 0.0225;
/** Emblem plate thickness, thick enough to catch a highlight edge-on. */
const EMBLEM_T = 0.05;

/**
 * Emblem glyphs in face-local units: `[u, v, w, h]` where `u` is across the
 * face, `v` is up it, and the origin is the face centre. Cells are laid out
 * so they only ever *touch* — never overlap — because two coplanar boxes of
 * the same colour z-fight and shimmer under the orthographic camera.
 */
const EMBLEMS = {
  // Horseshoe magnet, opening upward.
  magnet: [
    [-0.07, 0.02, 0.05, 0.16],
    [0.07, 0.02, 0.05, 0.16],
    [0, -0.085, 0.19, 0.05],
  ],
  // Tapering heater shield.
  shield: [
    [0, 0.075, 0.19, 0.05],
    [0, 0.015, 0.15, 0.07],
    [0, -0.05, 0.09, 0.06],
    [0, -0.095, 0.04, 0.03],
  ],
  // Two coins stacked corner-to-corner: "one coin became two".
  doubler: [
    [-0.055, 0.055, 0.11, 0.11],
    [0.055, -0.055, 0.11, 0.11],
  ],
  // Square clock face with hands at 12 and 3.
  slowmo: [
    [0, 0.085, 0.21, 0.04],
    [0, -0.085, 0.21, 0.04],
    [-0.085, 0, 0.04, 0.17],
    [0.085, 0, 0.04, 0.17],
    [0, 0, 0.032, 0.032],
    [0, 0.0435, 0.032, 0.055],
    [0.0435, 0, 0.055, 0.032],
  ],
  // Stepped arrow pointing up-field.
  jetpack: [
    [0, 0.09, 0.06, 0.04],
    [0, 0.04, 0.16, 0.06],
    [0, -0.045, 0.06, 0.11],
  ],
};

/**
 * Mix a `#rrggbb` colour toward white (`amount > 0`) or black (`amount < 0`).
 * Local rather than shared because it is the only place in the codebase that
 * needs tints, and pulling in a colour class here would drag Three.js into a
 * pure-data module.
 * @param {string} hex
 * @param {number} amount -1..1
 * @returns {string} `#rrggbb`
 */
function shade(hex, amount) {
  const n = parseInt(String(hex).replace('#', ''), 16) | 0;
  const target = amount < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amount));
  const mix = (c) => Math.round(c + (target - c) * p);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Push one emblem cell onto all five visible faces of the crate.
 *
 * Each face gets its own `u -> world` mapping so the glyph is never mirrored:
 * looking at a face, screen-right is `-Z` on +X, `+Z` on -X, `+X` on +Z,
 * `-X` on -Z, and `+X` on the top (where screen-up is `-Z`, matching the
 * camera sitting at +Z).
 */
function pushEmblemCell(boxes, u, v, w, h, color) {
  const R = EMBLEM_R;
  const T = EMBLEM_T;
  boxes.push({ pos: [R, v, -u], size: [T, h, w], color, emissive: color });
  boxes.push({ pos: [-R, v, u], size: [T, h, w], color, emissive: color });
  boxes.push({ pos: [u, v, R], size: [w, h, T], color, emissive: color });
  boxes.push({ pos: [-u, v, -R], size: [w, h, T], color, emissive: color });
  boxes.push({ pos: [u, R, -v], size: [w, T, h], color, emissive: color });
}

/**
 * Voxel spec for a pickup crate.
 *
 * Two parts, deliberately: `shell` carries the cage *and* its emblems so a
 * spin rotates the whole readable surface as one piece, while `core` is a
 * separate glow mesh the game can scale-pulse on its own beat.
 *
 * @param {string} id power-up id, selects the emblem glyph
 * @param {string} color base power-up colour
 * @returns {object} voxel spec, ≤ 0.6 on every axis, y = 0 at the bottom
 */
function crateSpec(id, color) {
  const barColor = color;
  const cornerColor = shade(color, -0.3);
  const emblemColor = shade(color, 0.62);
  const shell = [];

  // 12 edge bars. Each runs the full span between opposite corners so the
  // corner cubes cap them without leaving a seam.
  const span = CAGE_HALF * 2;
  for (const a of [-CAGE_HALF, CAGE_HALF]) {
    for (const b of [-CAGE_HALF, CAGE_HALF]) {
      shell.push({ pos: [0, a, b], size: [span, CAGE_BAR, CAGE_BAR], color: barColor });
      shell.push({ pos: [a, 0, b], size: [CAGE_BAR, span, CAGE_BAR], color: barColor });
      shell.push({ pos: [a, b, 0], size: [CAGE_BAR, CAGE_BAR, span], color: barColor });
    }
  }

  // 8 bevel corners.
  for (const x of [-CAGE_HALF, CAGE_HALF]) {
    for (const y of [-CAGE_HALF, CAGE_HALF]) {
      for (const z of [-CAGE_HALF, CAGE_HALF]) {
        shell.push({
          pos: [x, y, z],
          size: [CAGE_CORNER, CAGE_CORNER, CAGE_CORNER],
          color: cornerColor,
        });
      }
    }
  }

  const cells = EMBLEMS[id] || EMBLEMS.shield;
  for (const [u, v, w, h] of cells) pushEmblemCell(shell, u, v, w, h, emblemColor);

  // Core: a bright cube with three axis spikes poking through the cage
  // windows. Spikes reach 0.15, the bars' inner faces sit at ~0.1725, so the
  // core always stays fully enclosed no matter how the shell is spun.
  const coreBright = shade(color, 0.3);
  const spikeColor = shade(color, 0.68);
  const core = [
    { pos: [0, 0, 0], size: [0.19, 0.19, 0.19], color: coreBright, emissive: coreBright },
    { pos: [0, 0, 0], size: [0.3, 0.07, 0.07], color: spikeColor, emissive: spikeColor },
    { pos: [0, 0, 0], size: [0.07, 0.3, 0.07], color: spikeColor, emissive: spikeColor },
    { pos: [0, 0, 0], size: [0.07, 0.07, 0.3], color: spikeColor, emissive: spikeColor },
  ];

  return {
    scale: 1,
    parts: [
      {
        name: 'shell',
        pivot: [0, CRATE_HALF, 0],
        material: 'phong',
        castShadow: true,
        boxes: shell,
      },
      {
        name: 'core',
        pivot: [0, CRATE_HALF, 0],
        material: 'glow',
        castShadow: false,
        boxes: core,
      },
    ],
  };
}

/**
 * Crates spawn constantly, and a spec is immutable data that every consumer
 * (`recolorSpec` / `extendSpec` / `buildVoxelModel`) treats as read-only, so
 * one build per power-up is enough for the whole session.
 * @type {Map<string, object>}
 */
const SPEC_CACHE = new Map();

function cachedSpec(id, color) {
  let spec = SPEC_CACHE.get(id);
  if (!spec) {
    spec = crateSpec(id, color);
    SPEC_CACHE.set(id, spec);
  }
  return spec;
}

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

/**
 * The five power-ups. `weight` is the *early-game* selection weight; see
 * `rollPowerup` for how it drifts with score.
 *
 * @type {Array<{
 *   id: string, name: string, icon: string, color: string, duration: number,
 *   description: string, weight: number, rarity: string, build: () => object
 * }>}
 */
export const POWERUPS = [
  {
    id: 'magnet',
    name: 'Coin Magnet',
    icon: '🧲',
    color: PALETTE.magnet,
    duration: 8,
    description: 'Drags every nearby coin straight to you for 8 seconds.',
    weight: 30,
    rarity: 'common',
    build: () => cachedSpec('magnet', PALETTE.magnet),
  },
  {
    id: 'shield',
    name: 'Shield',
    icon: '🛡',
    color: PALETTE.shield,
    duration: 20,
    description: 'Soaks up one fatal hit. Lasts 20 seconds or until it breaks.',
    weight: 22,
    rarity: 'rare',
    build: () => cachedSpec('shield', PALETTE.shield),
  },
  {
    id: 'doubler',
    name: 'Coin Doubler',
    icon: '×2',
    color: PALETTE.doubler,
    duration: 12,
    description: 'Every coin is worth double for 12 seconds.',
    weight: 24,
    rarity: 'common',
    build: () => cachedSpec('doubler', PALETTE.doubler),
  },
  {
    id: 'slowmo',
    name: 'Slow Motion',
    icon: '⏳',
    color: PALETTE.slowmo,
    duration: 6,
    description: 'Drops the world to 55% speed for 6 seconds. You do not slow down.',
    weight: 16,
    rarity: 'rare',
    build: () => cachedSpec('slowmo', PALETTE.slowmo),
  },
  {
    id: 'jetpack',
    name: 'Jetpack',
    icon: '🚀',
    color: PALETTE.jetpack,
    duration: 4.5,
    description: 'Auto-hops you forward at speed, untouchable, for 4.5 seconds.',
    weight: 8,
    rarity: 'epic',
    build: () => cachedSpec('jetpack', PALETTE.jetpack),
  },
];

const BY_ID = new Map(POWERUPS.map((p) => [p.id, p]));

/**
 * Look up a power-up definition.
 * @param {string} id
 * @returns {object|null} the entry, or `null` when the id is unknown.
 */
export function getPowerup(id) {
  return BY_ID.get(id) ?? null;
}

/**
 * How each weight moves from its `weight` value at score 0 to its value at
 * `DIFFICULTY_MAX_SCORE`. Late-game rows are dense enough that raw greed
 * items stop mattering, so the two survival tools take over while jetpack —
 * which trivialises a whole screen — is pinned flat and therefore *shrinks*
 * as a share of a growing pool.
 */
const WEIGHT_SLOPE = {
  magnet: -12,
  shield: 16,
  doubler: -8,
  slowmo: 14,
  jetpack: 0,
};

/**
 * Pick a power-up id, biased by how far the run has got.
 *
 * Curve: `t = clamp(score / DIFFICULTY_MAX_SCORE, 0, 1)`, then every weight
 * is a straight lerp `weight + slope * t` (no weight ever reaches 0, so any
 * power-up remains possible at any score):
 *
 * ```
 *   id        t=0  ->  t=1     share@0   share@1
 *   magnet     30  ->   18      30.0%     16.4%
 *   doubler    24  ->   16      24.0%     14.5%
 *   shield     22  ->   38      22.0%     34.5%
 *   slowmo     16  ->   30      16.0%     27.3%
 *   jetpack     8  ->    8       8.0%      7.3%
 *   total     100      110
 * ```
 *
 * @param {import('../core/math.js').SeededRNG} rng draws exactly one number
 * @param {number} [score] current run score
 * @returns {string} power-up id
 */
export function rollPowerup(rng, score = 0) {
  const t = clamp(score / DIFFICULTY_MAX_SCORE, 0, 1);
  const picked = rng.weighted(POWERUPS, (p) => p.weight + WEIGHT_SLOPE[p.id] * t);
  return picked.id;
}

/** Per-row spawn probability at score 0. */
const SPAWN_CHANCE_MIN = 0.05;
/** Per-row spawn probability once difficulty has saturated. */
const SPAWN_CHANCE_MAX = 0.11;

/**
 * Probability that any one *eligible* row (worldgen decides eligibility —
 * crates never go on rails or in traffic) carries a power-up crate.
 *
 * Smoothstepped rather than linear so the opening rows stay clean and the
 * ramp lands softly at `DIFFICULTY_MAX_SCORE` instead of kinking there.
 *
 * @param {number} [score]
 * @returns {number} probability in [0.05, 0.11]
 */
export function powerupSpawnChance(score = 0) {
  const t = smoothstep(0, DIFFICULTY_MAX_SCORE, score);
  return lerp(SPAWN_CHANCE_MIN, SPAWN_CHANCE_MAX, t);
}
