/**
 * Voxel specs for every non-character prop in the game: road traffic, trains,
 * river platforms, scenery, pickups, the rail signal and the eagle.
 *
 * Everything here is *plain data* — no Three.js objects — so `PropFactory`
 * can memoise one template per key, clone it, and pool the clones. Each
 * function is pure and allocation-light; it is called once per unique key at
 * most, never per frame.
 *
 * Conventions
 * -----------
 * - Model origin = centre of the footprint at ground level (`y = 0`), matching
 *   `buildVoxelModel`. Rows add props at `y = 0`, so model space *is* world
 *   space in Y.
 * - Vehicles and trains face **+X**: length along X, width along Z. The row
 *   mirrors them with `rotation.y = π` for lanes travelling the other way, so
 *   nothing here may bake in a direction beyond that.
 * - Creatures face **-Z**, matching the player's `yaw = 0` (see `DIRS` in
 *   `src/game/player.js`).
 * - Vehicle `length`/`width` in `VEHICLE_TYPES` are the numbers physics builds
 *   its AABBs from, so every silhouette below is measured to hit them exactly:
 *   the outermost boxes define the extremes, nothing overhangs.
 */

import { LOG_TOP_Y, LILYPAD_TOP_Y, TILE } from '../core/constants.js';
import { clamp, SeededRNG } from '../core/math.js';
import { PALETTE } from './palette.js';
import { extendSpec } from './voxel.js';

/* ------------------------------------------------------------------ *
 * Local helpers
 * ------------------------------------------------------------------ */

/**
 * Blend a `#rrggbb` colour toward white (`amount > 0`) or black (`amount < 0`).
 * Doing this here rather than with `THREE.Color` keeps the module free of any
 * renderer dependency, so specs stay testable under plain Node.
 * @param {string} hex
 * @param {number} amount -1..1
 * @returns {string}
 */
function shade(hex, amount) {
  if (typeof hex !== 'string' || hex.length !== 7 || hex[0] !== '#') return hex;
  const n = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) return hex;
  const target = amount < 0 ? 0 : 255;
  const p = Math.min(1, Math.abs(amount));
  const r = Math.round(((n >> 16) & 255) + (target - ((n >> 16) & 255)) * p);
  const g = Math.round(((n >> 8) & 255) + (target - ((n >> 8) & 255)) * p);
  const b = Math.round((n & 255) + (target - (n & 255)) * p);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Three concentric boxes whose union approximates an octagonal prism — a far
 * better cylinder than a single cube for logs, wheels and coins, at a cost of
 * two extra boxes.
 * @param {Array} boxes destination
 * @param {'x'|'y'|'z'} axis long axis of the prism
 * @param {number} cx centre
 * @param {number} cy centre
 * @param {number} cz centre
 * @param {number} length extent along `axis`
 * @param {number} radius circumscribed radius of the cross-section
 * @param {string} color
 */
function pushPrism(boxes, axis, cx, cy, cz, length, radius, color) {
  const d = radius * 2;
  // Widest, tallest, and the 45° chamfer that turns the plus-shape into an
  // octagon. 0.7 / 0.88 are the inscribed-square and chamfer ratios.
  const cross = [
    [d, d * 0.7],
    [d * 0.7, d],
    [d * 0.88, d * 0.88],
  ];
  for (let i = 0; i < cross.length; i++) {
    const u = cross[i][0];
    const v = cross[i][1];
    const size =
      axis === 'x' ? [length, v, u] : axis === 'y' ? [u, length, v] : [u, v, length];
    boxes.push({ pos: [cx, cy, cz], size, color });
  }
}

/**
 * One road wheel: an octagonal tyre plus a lighter hubcap on the outer face.
 * The tyre's tallest box bottoms out at exactly `y = 0`, so the vehicle sits
 * on the ground however the caller stacks the body.
 * @param {Array} tyres destination for tyre boxes
 * @param {Array} hubs destination for hubcap boxes (may be the same array)
 * @param {number} x
 * @param {number} z signed: the hubcap faces outward from it
 * @param {number} r wheel radius
 * @param {number} t tyre thickness along Z
 */
function pushWheel(tyres, hubs, x, z, r, t) {
  const s = Math.sign(z) || 1;
  tyres.push({ pos: [x, r, z], size: [r * 2, r * 1.42, t], color: PALETTE.tyre });
  tyres.push({ pos: [x, r, z], size: [r * 1.42, r * 2, t], color: PALETTE.tyre });
  tyres.push({ pos: [x, r, z], size: [r * 1.76, r * 1.76, t], color: PALETTE.tyre });
  // Hubcap buries itself in the tyre and stands 0.02 proud of it, so it is the
  // widest thing on the vehicle and no two faces are ever coplanar.
  const hubT = 0.05;
  const outer = Math.abs(z) + t * 0.5 + 0.02;
  hubs.push({
    pos: [x, r, s * (outer - hubT * 0.5)],
    size: [r * 0.95, r * 0.95, hubT],
    color: PALETTE.hubcap,
  });
}

/* ------------------------------------------------------------------ *
 * Cars
 * ------------------------------------------------------------------ */

/** Half length of every car: the light plates below land exactly here. */
const CAR_HALF = 0.85;
/** Wheel geometry shared by cars, trucks and buses. */
const WHEEL_R = 0.15;
const WHEEL_Z = 0.36;
const WHEEL_T = 0.14;
/**
 * Widest point of any road vehicle: wheel centre 0.36 + half thickness 0.07
 * + hubcap 0.02 = 0.45 -> total width 0.90, which is what `VEHICLE_TYPES`
 * declares and what the swept AABBs use.
 */
const ROAD_WIDTH = 0.9;

/**
 * A car, facing +X. Four silhouettes so a lane of eight colours never reads as
 * eight clones.
 *
 * Measured extents: X ∈ [-0.85, 0.85] (1.70 long, set by the light plates),
 * Z ∈ [-0.45, 0.45] (0.90 wide, set by the hubcaps), tallest roof 0.78.
 *
 * @param {string} [color] body colour, usually from `VEHICLE_COLORS`
 * @param {number} [variant] 0 hatchback, 1 sedan, 2 sports, 3 pickup
 * @returns {object} voxel spec with parts `body`, `cabin`, `wheels`,
 *   `lights` (headlights) and `brake` (taillights)
 */
export function carSpec(color = PALETTE.carRed, variant = 0) {
  const v = ((Math.round(variant) || 0) % 4 + 4) % 4;
  const dark = shade(color, -0.3);
  const light = shade(color, 0.14);

  const body = [];
  const glass = [];
  const tyres = [];
  const hubs = [];

  let wheelX = 0.55;
  let lightY = 0.33;
  let bumperY = 0.26;

  switch (v) {
    case 1: {
      // Sedan: three-box profile, long bonnet and a proper boot.
      body.push({ pos: [0, 0.29, 0], size: [1.66, 0.26, 0.74], color });
      body.push({ pos: [0, 0.18, 0], size: [1.6, 0.08, 0.78], color: dark });
      body.push({ pos: [0.42, 0.45, 0], size: [0.8, 0.1, 0.72], color });
      body.push({ pos: [-0.5, 0.46, 0], size: [0.66, 0.12, 0.72], color });
      body.push({ pos: [-0.06, 0.46, 0], size: [0.9, 0.12, 0.72], color });
      body.push({ pos: [-0.06, 0.725, 0], size: [0.8, 0.07, 0.66], color: light });
      glass.push({ pos: [-0.06, 0.6, 0], size: [0.88, 0.22, 0.7], color: PALETTE.glass });
      wheelX = 0.57;
      break;
    }
    case 2: {
      // Sports: low, wide, chopped roof and a rear wing.
      body.push({ pos: [0, 0.24, 0], size: [1.66, 0.22, 0.8], color });
      body.push({ pos: [0.74, 0.15, 0], size: [0.22, 0.06, 0.84], color: dark });
      body.push({ pos: [-0.05, 0.4, 0], size: [1.24, 0.1, 0.76], color });
      body.push({ pos: [-0.14, 0.605, 0], size: [0.62, 0.07, 0.62], color: light });
      body.push({ pos: [-0.66, 0.5, 0.24], size: [0.06, 0.14, 0.06], color: dark });
      body.push({ pos: [-0.66, 0.5, -0.24], size: [0.06, 0.14, 0.06], color: dark });
      body.push({ pos: [-0.68, 0.59, 0], size: [0.16, 0.05, 0.72], color: dark });
      glass.push({ pos: [-0.1, 0.5, 0], size: [0.8, 0.18, 0.72], color: PALETTE.glass });
      wheelX = 0.58;
      lightY = 0.26;
      bumperY = 0.2;
      break;
    }
    case 3: {
      // Pickup: cab forward, open bed with walls and a tailgate.
      body.push({ pos: [0, 0.3, 0], size: [1.66, 0.26, 0.76], color });
      body.push({ pos: [0, 0.19, 0], size: [1.6, 0.08, 0.8], color: dark });
      body.push({ pos: [0.3, 0.47, 0], size: [0.66, 0.1, 0.74], color });
      body.push({ pos: [0.28, 0.735, 0], size: [0.6, 0.07, 0.68], color: light });
      body.push({ pos: [-0.42, 0.46, 0], size: [0.84, 0.06, 0.72], color: shade(color, -0.42) });
      body.push({ pos: [-0.42, 0.56, 0.33], size: [0.84, 0.26, 0.08], color });
      body.push({ pos: [-0.42, 0.56, -0.33], size: [0.84, 0.26, 0.08], color });
      body.push({ pos: [-0.81, 0.56, 0], size: [0.08, 0.26, 0.74], color: light });
      body.push({ pos: [-0.03, 0.57, 0], size: [0.07, 0.28, 0.74], color });
      glass.push({ pos: [0.28, 0.6, 0], size: [0.62, 0.2, 0.7], color: PALETTE.glass });
      wheelX = 0.58;
      lightY = 0.34;
      break;
    }
    default: {
      // Hatchback: tall greenhouse running all the way to the tail.
      body.push({ pos: [0, 0.3, 0], size: [1.66, 0.26, 0.74], color });
      body.push({ pos: [0, 0.19, 0], size: [1.6, 0.08, 0.78], color: dark });
      body.push({ pos: [-0.06, 0.46, 0], size: [1.42, 0.1, 0.72], color });
      body.push({ pos: [-0.62, 0.6, 0], size: [0.12, 0.22, 0.66], color });
      body.push({ pos: [-0.2, 0.745, 0], size: [0.92, 0.07, 0.66], color: light });
      glass.push({ pos: [-0.2, 0.6, 0], size: [0.9, 0.22, 0.7], color: PALETTE.glass });
      break;
    }
  }

  // Bumpers stop 0.01 short of the light plates so no two faces are coplanar.
  body.push({ pos: [0.79, bumperY, 0], size: [0.1, 0.16, 0.76], color: dark });
  body.push({ pos: [-0.79, bumperY, 0], size: [0.1, 0.16, 0.76], color: dark });

  pushWheel(tyres, hubs, wheelX, WHEEL_Z, WHEEL_R, WHEEL_T);
  pushWheel(tyres, hubs, wheelX, -WHEEL_Z, WHEEL_R, WHEEL_T);
  pushWheel(tyres, hubs, -wheelX, WHEEL_Z, WHEEL_R, WHEEL_T);
  pushWheel(tyres, hubs, -wheelX, -WHEEL_Z, WHEEL_R, WHEEL_T);

  // Lights define ±CAR_HALF, i.e. the exact 1.70 the physics AABB assumes.
  const headlights = [
    { pos: [CAR_HALF - 0.015, lightY, 0.24], size: [0.03, 0.1, 0.16], color: PALETTE.headlight },
    { pos: [CAR_HALF - 0.015, lightY, -0.24], size: [0.03, 0.1, 0.16], color: PALETTE.headlight },
  ];
  const taillights = [
    { pos: [-CAR_HALF + 0.015, lightY, 0.25], size: [0.03, 0.09, 0.15], color: PALETTE.taillight },
    { pos: [-CAR_HALF + 0.015, lightY, -0.25], size: [0.03, 0.09, 0.15], color: PALETTE.taillight },
  ];

  return {
    scale: 1,
    parts: [
      { name: 'body', boxes: body.concat(hubs) },
      { name: 'wheels', boxes: tyres },
      { name: 'cabin', material: 'glass', boxes: glass },
      { name: 'lights', material: 'glow', castShadow: false, boxes: headlights },
      { name: 'brake', material: 'glow', castShadow: false, boxes: taillights },
    ],
  };
}

/**
 * Taxi: a sedan in cab yellow with a roof sign and a checker stripe.
 * Same 1.70 x 0.90 envelope as any other car.
 * @returns {object} voxel spec
 */
function taxiSpec() {
  const base = carSpec(PALETTE.carYellow, 1);
  const trim = [];
  // Checker band along both flanks, just proud of the body (0.375 < 0.45).
  for (let i = 0; i < 7; i++) {
    const x = -0.6 + i * 0.2;
    const c = i % 2 === 0 ? '#20242c' : '#f4f4f4';
    trim.push({ pos: [x, 0.39, 0.375], size: [0.2, 0.09, 0.02], color: c });
    trim.push({ pos: [x, 0.39, -0.375], size: [0.2, 0.09, 0.02], color: c });
  }
  trim.push({ pos: [-0.06, 0.79, 0], size: [0.3, 0.11, 0.18], color: '#20242c' });
  return extendSpec(base, [
    { name: 'trim', boxes: trim },
    {
      name: 'sign',
      material: 'glow',
      castShadow: false,
      boxes: [{ pos: [-0.06, 0.8, 0], size: [0.26, 0.09, 0.2], color: '#ffdd66' }],
    },
  ]);
}

/**
 * Police cruiser: white sedan, dark doors, and a `siren` bar the game can
 * flash. Same 1.70 x 0.90 envelope as any other car.
 * @returns {object} voxel spec
 */
function policeSpec() {
  const base = carSpec(PALETTE.carWhite, 1);
  const livery = [
    { pos: [-0.06, 0.32, 0.375], size: [0.78, 0.2, 0.02], color: '#1b2740' },
    { pos: [-0.06, 0.32, -0.375], size: [0.78, 0.2, 0.02], color: '#1b2740' },
    { pos: [0.5, 0.3, 0.375], size: [0.3, 0.12, 0.02], color: '#1b2740' },
    { pos: [0.5, 0.3, -0.375], size: [0.3, 0.12, 0.02], color: '#1b2740' },
    // Light-bar mounts, so the siren appears to sit on something.
    { pos: [-0.06, 0.78, 0], size: [0.36, 0.05, 0.2], color: '#20242c' },
  ];
  return extendSpec(base, [
    { name: 'livery', boxes: livery },
    {
      name: 'siren',
      material: 'glow',
      castShadow: false,
      boxes: [
        { pos: [-0.06, 0.845, 0.06], size: [0.34, 0.08, 0.08], color: '#3f7bff' },
        { pos: [-0.06, 0.845, -0.06], size: [0.34, 0.08, 0.08], color: '#ff3b30' },
      ],
    },
  ]);
}

/* ------------------------------------------------------------------ *
 * Truck & bus
 * ------------------------------------------------------------------ */

/**
 * Articulated-looking box truck facing +X: cab, a visible 0.20 gap, and a
 * cargo box riding a chassis rail that bridges the gap.
 *
 * Measured extents: X ∈ [-1.50, 1.50] (3.00 long), Z ∈ [-0.45, 0.45] (0.90).
 *
 * @param {string} [color] cab colour
 * @returns {object} voxel spec with parts `body`, `wheels`, `cabin`,
 *   `lights`, `brake`
 */
export function truckSpec(color = PALETTE.truckCab) {
  const cab = color;
  const cabDark = shade(cab, -0.3);
  const box = PALETTE.truckBody;

  const body = [
    // Chassis rail: the reason the cab/box gap reads as a gap and not a cut.
    { pos: [0, 0.26, 0], size: [2.8, 0.1, 0.52], color: '#3c4048' },
    { pos: [1.05, 0.55, 0], size: [0.82, 0.66, 0.84], color: cab },
    { pos: [1.05, 0.9, 0], size: [0.78, 0.06, 0.8], color: shade(cab, 0.12) },
    { pos: [1.46, 0.36, 0], size: [0.06, 0.2, 0.7], color: cabDark },
    { pos: [0.68, 0.62, 0], size: [0.06, 0.5, 0.86], color: cabDark },
    // Cargo box + roof rim.
    { pos: [-0.52, 0.66, 0], size: [1.92, 0.76, 0.86], color: box },
    { pos: [-0.52, 1.06, 0], size: [1.94, 0.04, 0.88], color: shade(box, -0.18) },
    { pos: [-1.485, 0.64, 0], size: [0.03, 0.68, 0.8], color: shade(box, -0.24) },
  ];
  // Corrugation ribs stand 0.01 proud of the cargo sides.
  for (let i = 0; i < 4; i++) {
    body.push({
      pos: [-1.2 + i * 0.42, 0.66, 0],
      size: [0.05, 0.72, 0.88],
      color: shade(box, -0.1),
    });
  }

  const glass = [
    { pos: [1.47, 0.66, 0], size: [0.03, 0.26, 0.7], color: PALETTE.glass },
    { pos: [1.3, 0.66, 0.425], size: [0.36, 0.22, 0.02], color: PALETTE.glass },
    { pos: [1.3, 0.66, -0.425], size: [0.36, 0.22, 0.02], color: PALETTE.glass },
  ];

  const tyres = [];
  const hubs = [];
  for (const x of [1.15, -0.62, -1.06]) {
    pushWheel(tyres, hubs, x, WHEEL_Z, WHEEL_R, WHEEL_T);
    pushWheel(tyres, hubs, x, -WHEEL_Z, WHEEL_R, WHEEL_T);
  }

  return {
    scale: 1,
    parts: [
      { name: 'body', boxes: body.concat(hubs) },
      { name: 'wheels', boxes: tyres },
      { name: 'cabin', material: 'glass', boxes: glass },
      {
        name: 'lights',
        material: 'glow',
        castShadow: false,
        boxes: [
          { pos: [1.485, 0.32, 0.26], size: [0.03, 0.12, 0.16], color: PALETTE.headlight },
          { pos: [1.485, 0.32, -0.26], size: [0.03, 0.12, 0.16], color: PALETTE.headlight },
        ],
      },
      {
        name: 'brake',
        material: 'glow',
        castShadow: false,
        // Slung under the cargo door so the two never share a face plane.
        boxes: [
          { pos: [-1.485, 0.22, 0.28], size: [0.03, 0.1, 0.14], color: PALETTE.taillight },
          { pos: [-1.485, 0.22, -0.28], size: [0.03, 0.1, 0.14], color: PALETTE.taillight },
        ],
      },
    ],
  };
}

/**
 * City bus facing +X: a long slab with a window strip down both flanks and
 * roof vents to break up the top.
 *
 * Measured extents: X ∈ [-1.70, 1.70] (3.40 long), Z ∈ [-0.45, 0.45] (0.90).
 *
 * @param {string} [color] body colour, defaults to the classic bus yellow
 * @returns {object} voxel spec with parts `body`, `wheels`, `cabin`,
 *   `lights`, `brake`
 */
export function busSpec(color = PALETTE.busBody) {
  const dark = shade(color, -0.28);
  const body = [
    { pos: [0, 0.66, 0], size: [3.3, 0.8, 0.86], color },
    { pos: [0, 0.24, 0], size: [3.26, 0.14, 0.82], color: dark },
    { pos: [0, 1.09, 0], size: [3.26, 0.06, 0.84], color: shade(color, 0.14) },
    { pos: [0.6, 1.14, 0], size: [0.34, 0.06, 0.5], color: dark },
    { pos: [-0.7, 1.14, 0], size: [0.34, 0.06, 0.5], color: dark },
    // Door frames: 0.006 proud of the glass strip, never coplanar with it.
    { pos: [0.92, 0.72, 0.4335], size: [0.05, 0.62, 0.03], color: dark },
    { pos: [-0.42, 0.72, 0.4335], size: [0.05, 0.62, 0.03], color: dark },
    { pos: [0.92, 0.72, -0.4335], size: [0.05, 0.62, 0.03], color: dark },
    { pos: [-0.42, 0.72, -0.4335], size: [0.05, 0.62, 0.03], color: dark },
  ];

  const glass = [
    { pos: [-0.05, 0.82, 0.435], size: [2.86, 0.3, 0.02], color: PALETTE.glass },
    { pos: [-0.05, 0.82, -0.435], size: [2.86, 0.3, 0.02], color: PALETTE.glass },
    { pos: [1.665, 0.8, 0], size: [0.03, 0.34, 0.72], color: PALETTE.glass },
    { pos: [-1.665, 0.8, 0], size: [0.03, 0.3, 0.68], color: PALETTE.glass },
  ];

  const tyres = [];
  const hubs = [];
  for (const x of [1.28, -1.18]) {
    pushWheel(tyres, hubs, x, WHEEL_Z, WHEEL_R, WHEEL_T);
    pushWheel(tyres, hubs, x, -WHEEL_Z, WHEEL_R, WHEEL_T);
  }

  return {
    scale: 1,
    parts: [
      { name: 'body', boxes: body.concat(hubs) },
      { name: 'wheels', boxes: tyres },
      { name: 'cabin', material: 'glass', boxes: glass },
      {
        name: 'lights',
        material: 'glow',
        castShadow: false,
        boxes: [
          { pos: [1.685, 0.34, 0.28], size: [0.03, 0.12, 0.16], color: PALETTE.headlight },
          { pos: [1.685, 0.34, -0.28], size: [0.03, 0.12, 0.16], color: PALETTE.headlight },
        ],
      },
      {
        name: 'brake',
        material: 'glow',
        castShadow: false,
        boxes: [
          { pos: [-1.685, 0.32, 0.3], size: [0.03, 0.1, 0.14], color: PALETTE.taillight },
          { pos: [-1.685, 0.32, -0.3], size: [0.03, 0.1, 0.14], color: PALETTE.taillight },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Train
 * ------------------------------------------------------------------ */

/** Matches `TRAIN_CAR_LENGTH` in `src/game/rows.js`: cars are laid end to end. */
const TRAIN_HALF = 2.3;
/** Rail head sits at y ≈ 0.11 (see `railDetailGeometry`), rails at z = ±0.22. */
const RAIL_Z = 0.22;
const RAIL_TOP = 0.1;

/** Push one flanged train wheel, bottoming out on the rail head. */
function pushRailWheel(boxes, x) {
  for (const z of [RAIL_Z, -RAIL_Z]) {
    boxes.push({ pos: [x, RAIL_TOP + 0.15, z], size: [0.3, 0.21, 0.11], color: PALETTE.tyre });
    boxes.push({ pos: [x, RAIL_TOP + 0.15, z], size: [0.21, 0.3, 0.11], color: PALETTE.tyre });
    boxes.push({ pos: [x, RAIL_TOP + 0.15, z], size: [0.26, 0.26, 0.13], color: '#3a3f47' });
  }
}

/**
 * One train car, facing +X and exactly 4.60 long so a 4-6 car consist reads as
 * one continuous machine.
 *
 * Measured extents: X ∈ [-2.30, 2.30], Z ∈ [-0.49, 0.49], top 1.53 (engine).
 *
 * @param {'engine'|'car'} [kind]
 * @returns {object} voxel spec; the engine adds a `lamp` part ('glow') for its
 *   forward headlamp
 */
export function trainCarSpec(kind = 'car') {
  const body = PALETTE.trainBody;
  const trim = PALETTE.trainDark;
  const boxes = [
    { pos: [0, 0.4, 0], size: [4.44, 0.14, 0.94], color: trim },
    { pos: [-2.27, 0.4, 0], size: [0.06, 0.14, 0.22], color: trim },
  ];
  const wheels = [];
  const glass = [];
  const parts = [];

  if (kind === 'engine') {
    boxes.push({ pos: [-0.25, 0.8, 0], size: [3.8, 0.68, 0.92], color: body });
    boxes.push({ pos: [-0.25, 1.16, 0], size: [3.7, 0.05, 0.86], color: trim });
    // Tapering nose: three blocks, tip landing exactly on +2.30.
    boxes.push({ pos: [1.78, 0.76, 0], size: [0.5, 0.58, 0.84], color: body });
    boxes.push({ pos: [2.14, 0.7, 0], size: [0.24, 0.44, 0.66], color: body });
    boxes.push({ pos: [2.275, 0.66, 0], size: [0.05, 0.32, 0.5], color: shade(body, -0.15) });
    // Cowcatcher: a stepped wedge sweeping down to the rail head.
    boxes.push({ pos: [2.1, 0.3, 0], size: [0.28, 0.18, 0.7], color: trim });
    boxes.push({ pos: [2.19, 0.2, 0], size: [0.2, 0.14, 0.58], color: trim });
    boxes.push({ pos: [2.25, 0.13, 0], size: [0.1, 0.12, 0.44], color: trim });
    // Chimney.
    boxes.push({ pos: [1.5, 1.3, 0], size: [0.24, 0.3, 0.24], color: trim });
    boxes.push({ pos: [1.5, 1.45, 0], size: [0.3, 0.06, 0.3], color: shade(trim, 0.1) });
    // Driver's cab.
    boxes.push({ pos: [0.55, 1.24, 0], size: [0.92, 0.42, 0.9], color: body });
    boxes.push({ pos: [0.55, 1.49, 0], size: [0.98, 0.08, 0.96], color: trim });
    // Running boards.
    boxes.push({ pos: [-0.2, 0.48, 0.47], size: [3.6, 0.05, 0.04], color: trim });
    boxes.push({ pos: [-0.2, 0.48, -0.47], size: [3.6, 0.05, 0.04], color: trim });

    glass.push({ pos: [1.02, 1.28, 0], size: [0.03, 0.24, 0.6], color: PALETTE.trainWindow });
    glass.push({ pos: [0.55, 1.28, 0.455], size: [0.5, 0.24, 0.02], color: PALETTE.trainWindow });
    glass.push({ pos: [0.55, 1.28, -0.455], size: [0.5, 0.24, 0.02], color: PALETTE.trainWindow });

    for (const x of [1.55, 0.95, -0.55, -1.45]) pushRailWheel(wheels, x);

    parts.push({
      name: 'lamp',
      material: 'glow',
      castShadow: false,
      boxes: [
        { pos: [2.05, 0.98, 0], size: [0.18, 0.16, 0.2], color: PALETTE.trainLight },
        { pos: [2.16, 0.98, 0], size: [0.06, 0.12, 0.14], color: '#ffffff' },
      ],
    });
  } else {
    boxes.push({ pos: [0, 0.84, 0], size: [4.4, 0.76, 0.92], color: body });
    boxes.push({ pos: [0, 1.26, 0], size: [4.44, 0.08, 0.96], color: trim });
    boxes.push({ pos: [1.1, 0.84, 0], size: [0.24, 0.62, 0.94], color: trim });
    boxes.push({ pos: [-1.1, 0.84, 0], size: [0.24, 0.62, 0.94], color: trim });
    boxes.push({ pos: [0, 0.52, 0.47], size: [4.2, 0.06, 0.04], color: trim });
    boxes.push({ pos: [0, 0.52, -0.47], size: [4.2, 0.06, 0.04], color: trim });
    boxes.push({ pos: [2.27, 0.4, 0], size: [0.06, 0.14, 0.22], color: trim });

    glass.push({ pos: [0, 1.0, 0.455], size: [3.9, 0.28, 0.02], color: PALETTE.trainWindow });
    glass.push({ pos: [0, 1.0, -0.455], size: [3.9, 0.28, 0.02], color: PALETTE.trainWindow });

    for (const x of [1.75, 1.45, -1.45, -1.75]) pushRailWheel(wheels, x);
  }

  return {
    scale: 1,
    parts: [
      { name: 'body', boxes },
      { name: 'wheels', boxes: wheels },
      { name: 'windows', material: 'glass', boxes: glass },
      ...parts,
    ],
  };
}

/* ------------------------------------------------------------------ *
 * River platforms
 * ------------------------------------------------------------------ */

/**
 * A floating log, `lengthTiles` tiles long (1..4) and exactly that long in X so
 * the physics half-length (`length / 2`) matches the art.
 *
 * The trunk radius is 0.33 and its centre sits at `LOG_TOP_Y - 0.33`, which
 * puts the top of the trunk at **exactly `LOG_TOP_Y` (0.16)** — the surface
 * height `rows.js` hands the player to stand on. (Only the end rims, 3%
 * oversized on purpose, stand 0.01 above that.) The underside lands at -0.51,
 * comfortably below the water plane at `-WATER_SINK` (-0.24), so the log reads
 * as floating rather than hovering.
 *
 * @param {number} lengthTiles 1..4
 * @returns {object} voxel spec with parts `log` and `ends`
 */
export function logSpec(lengthTiles = 2) {
  const tiles = clamp(Math.round(lengthTiles) || 1, 1, 4);
  const len = tiles * TILE;
  const half = len / 2;
  const r = 0.33; // 0.66 across — well inside the 0.9 lane budget
  const cy = LOG_TOP_Y - r;

  const boxes = [];
  pushPrism(boxes, 'x', 0, cy, 0, len - 0.06, r, PALETTE.log);

  // Bark ridges along the flanks. The prism's widest cross-section reaches
  // |z| = r only while |y - cy| <= r * 0.71, so the ridges sit low on the
  // flank and stand 0.01 proud of it — level with the end rims, and still
  // above the water plane at -WATER_SINK (-0.24) so they read.
  for (const s of [1, -1]) {
    boxes.push({
      pos: [0, cy + 0.08, s * (r - 0.01)],
      size: [len * 0.72, 0.09, 0.04],
      color: PALETTE.logDark,
    });
  }
  // Knots ride the shoulder, where the octagon steps in from r to r * 0.88, so
  // they clear the trunk without ever poking above LOG_TOP_Y (0.16).
  boxes.push({ pos: [-len * 0.18, cy + 0.285, 0.255], size: [0.16, 0.07, 0.14], color: PALETTE.logDark });
  boxes.push({ pos: [len * 0.22, cy + 0.28, -0.24], size: [0.13, 0.08, 0.12], color: PALETTE.logDark });

  // End grain: a slightly oversized bark rim, then two concentric rings, each
  // stepping 0.01 further out so no two faces ever share a plane. The inner
  // ring lands exactly on ±half, defining the log's length.
  const ends = [];
  const ringDark = shade(PALETTE.logRing, -0.28);
  for (const s of [1, -1]) {
    pushPrism(ends, 'x', s * (half - 0.045), cy, 0, 0.05, r * 1.03, PALETTE.logRing);
    ends.push({ pos: [s * (half - 0.025), cy, 0], size: [0.03, 0.19, 0.19], color: ringDark });
    ends.push({ pos: [s * (half - 0.02), cy, 0], size: [0.04, 0.08, 0.08], color: PALETTE.logRing });
  }

  return {
    scale: 1,
    parts: [
      { name: 'log', boxes },
      { name: 'ends', boxes: ends },
    ],
  };
}

/**
 * A lily pad: a notched disc whose top sits at `LILYPAD_TOP_Y` (0.06), the
 * surface height `rows.js` reports to the player. A short stem drops to -0.30
 * so the pad is visibly rooted in the water plane at -0.24 instead of hovering.
 *
 * @param {boolean} [withFlower] add the pink bloom (roughly 40% of pads)
 * @returns {object} voxel spec with parts `pad` and, optionally, `flower`
 */
export function lilypadSpec(withFlower = false) {
  const r = 0.42; // 0.84 across, inside the 0.9 lane budget
  const thick = 0.05;
  const y = LILYPAD_TOP_Y - thick / 2;

  const boxes = [
    { pos: [0, -0.13, 0], size: [0.1, 0.34, 0.1], color: shade(PALETTE.lily, -0.3) },
  ];

  // Strips along Z, each as long as the circle allows. The two central strips
  // are cut back on +X to carve the pad's classic notch.
  const strips = [-0.36, -0.24, -0.12, 0, 0.12, 0.24, 0.36];
  for (const z of strips) {
    const halfLen = Math.sqrt(Math.max(0, r * r - z * z));
    const az = Math.abs(z);
    const cut = az < 0.06 ? 0.1 : az < 0.18 ? 0.26 : halfLen;
    const edge = az > 0.3 ? shade(PALETTE.lily, -0.12) : PALETTE.lily;
    boxes.push({
      pos: [(cut - halfLen) / 2, y, z],
      size: [cut + halfLen, thick, 0.125],
      color: edge,
    });
  }
  // Veins, a touch proud of the pad so they catch the light.
  boxes.push({ pos: [-0.12, y + 0.02, 0], size: [0.5, 0.02, 0.04], color: shade(PALETTE.lily, 0.18) });
  boxes.push({ pos: [-0.16, y + 0.02, 0.18], size: [0.36, 0.02, 0.04], color: shade(PALETTE.lily, 0.18) });
  boxes.push({ pos: [-0.16, y + 0.02, -0.18], size: [0.36, 0.02, 0.04], color: shade(PALETTE.lily, 0.18) });

  // The notch eats 0.075 off the +X side, so the whole pad is nudged back to
  // keep its visual centre on the origin the collision AABB is built around.
  const recentre = [0.0375, 0, 0];
  const parts = [{ name: 'pad', pivot: recentre, boxes }];

  if (withFlower) {
    const f = PALETTE.lilyFlower;
    parts.push({
      name: 'flower',
      pivot: recentre,
      boxes: [
        { pos: [-0.16, 0.1, 0.12], size: [0.12, 0.08, 0.12], color: f },
        { pos: [-0.16, 0.16, 0.12], size: [0.08, 0.06, 0.08], color: shade(f, 0.2) },
        { pos: [-0.27, 0.09, 0.12], size: [0.1, 0.05, 0.08], color: shade(f, -0.1) },
        { pos: [-0.05, 0.09, 0.12], size: [0.1, 0.05, 0.08], color: shade(f, -0.1) },
        { pos: [-0.16, 0.09, 0.23], size: [0.08, 0.05, 0.1], color: shade(f, -0.1) },
        { pos: [-0.16, 0.09, 0.01], size: [0.08, 0.05, 0.1], color: shade(f, -0.1) },
        { pos: [-0.16, 0.2, 0.12], size: [0.05, 0.04, 0.05], color: PALETTE.coin },
      ],
    });
  }

  return { scale: 1, parts };
}

/* ------------------------------------------------------------------ *
 * Scenery
 * ------------------------------------------------------------------ */

/** Shared fallback so a caller that forgets its rng still gets stable art. */
function rngOr(rng, seed) {
  return rng && typeof rng.next === 'function' ? rng : new SeededRNG(seed);
}

/**
 * A tree. Footprint never exceeds 0.86 so a blocked tile still reads as one
 * tile, and height stays inside 1.1..2.4.
 *
 * @param {number} [variant] 0 round broadleaf, 1 tall conifer, 2 stump + canopy
 * @param {import('../core/math.js').SeededRNG} [rng] deterministic variation
 * @returns {object} voxel spec with parts `trunk` and `canopy`
 */
export function treeSpec(variant = 0, rng) {
  const r = rngOr(rng, 1000 + variant);
  const v = ((Math.round(variant) || 0) % 3 + 3) % 3;
  const leaf = r.pick([PALETTE.leaf1, PALETTE.leaf2, PALETTE.leaf3]);
  const trunk = [];
  const canopy = [];

  if (v === 1) {
    // Conifer: thin trunk, four tapering tiers with visible steps.
    // `h` is the tier stack; the crown tip adds another 0.11, so the range is
    // capped at 2.28 to keep the whole model inside the documented 2.4.
    const h = r.range(1.7, 2.28);
    const tw = 0.2;
    trunk.push({ pos: [0, h * 0.14, 0], size: [tw, h * 0.28, tw], color: PALETTE.trunk });
    trunk.push({ pos: [0, 0.05, 0], size: [tw + 0.1, 0.1, tw + 0.1], color: PALETTE.trunkDark });
    const tiers = [0.82, 0.66, 0.5, 0.32];
    let y = h * 0.26;
    for (let i = 0; i < tiers.length; i++) {
      const th = (h - h * 0.26) / tiers.length;
      canopy.push({
        pos: [0, y + th * 0.5, 0],
        size: [tiers[i], th * 1.05, tiers[i]],
        color: i % 2 === 0 ? leaf : shade(leaf, -0.1),
      });
      y += th;
    }
    canopy.push({ pos: [0, h + 0.04, 0], size: [0.12, 0.14, 0.12], color: shade(leaf, 0.1) });
  } else if (v === 2) {
    // Stump with a low, wide canopy — reads as an old broad hardwood.
    const h = r.range(1.1, 1.5);
    const tw = r.range(0.32, 0.38);
    trunk.push({ pos: [0, h * 0.26, 0], size: [tw, h * 0.52, tw], color: PALETTE.trunk });
    trunk.push({ pos: [0, 0.06, 0], size: [tw + 0.14, 0.12, tw + 0.14], color: PALETTE.trunkDark });
    trunk.push({
      pos: [r.range(-0.2, 0.2), h * 0.34, r.range(-0.2, 0.2)],
      size: [0.12, 0.1, 0.26],
      color: PALETTE.trunkDark,
    });
    const cw = r.range(0.74, 0.86);
    canopy.push({ pos: [0, h * 0.6, 0], size: [cw, 0.26, cw], color: shade(leaf, -0.08) });
    canopy.push({ pos: [0, h * 0.82, 0], size: [cw * 0.82, 0.24, cw * 0.82], color: leaf });
    canopy.push({
      pos: [r.range(-0.12, 0.12), h * 0.98, r.range(-0.12, 0.12)],
      size: [cw * 0.5, 0.18, cw * 0.5],
      color: shade(leaf, 0.12),
    });
  } else {
    // Round broadleaf: a four-layer blob, widest a third of the way up.
    const h = r.range(1.4, 2.2);
    const tw = 0.22;
    trunk.push({ pos: [0, h * 0.21, 0], size: [tw, h * 0.42, tw], color: PALETTE.trunk });
    trunk.push({ pos: [0, 0.06, 0], size: [tw + 0.12, 0.12, tw + 0.12], color: PALETTE.trunkDark });
    const cw = r.range(0.72, 0.86);
    const base = h * 0.4;
    const span = h - base;
    canopy.push({ pos: [0, base + span * 0.16, 0], size: [cw * 0.74, span * 0.34, cw * 0.74], color: shade(leaf, -0.12) });
    canopy.push({ pos: [0, base + span * 0.44, 0], size: [cw, span * 0.36, cw], color: leaf });
    canopy.push({ pos: [0, base + span * 0.72, 0], size: [cw * 0.84, span * 0.3, cw * 0.84], color: shade(leaf, 0.06) });
    canopy.push({ pos: [0, base + span * 0.94, 0], size: [cw * 0.48, span * 0.22, cw * 0.48], color: shade(leaf, 0.16) });
  }

  return {
    scale: 1,
    parts: [
      { name: 'trunk', boxes: trunk },
      { name: 'canopy', boxes: canopy },
    ],
  };
}

/**
 * A boulder cluster: 3-5 chunks, footprint ≤ 0.82, height 0.3-0.62.
 * @param {import('../core/math.js').SeededRNG} [rng]
 * @returns {object} voxel spec with part `rock`
 */
export function rockSpec(rng) {
  const r = rngOr(rng, 2000);
  const boxes = [];
  const w = r.range(0.6, 0.78);
  const h = r.range(0.24, 0.34);
  boxes.push({ pos: [0, h * 0.5, 0], size: [w, h, w * r.range(0.86, 1)], color: PALETTE.rock });
  boxes.push({
    pos: [r.range(-0.08, 0.08), h * 0.9, r.range(-0.08, 0.08)],
    size: [w * 0.74, h * 0.8, w * 0.7],
    color: PALETTE.rockDark,
  });

  const chunks = r.int(1, 3);
  for (let i = 0; i < chunks; i++) {
    const s = r.range(0.16, 0.3);
    boxes.push({
      pos: [r.range(-0.26, 0.26), h * r.range(1.1, 1.7), r.range(-0.24, 0.24)],
      size: [s, s * r.range(0.7, 1.1), s * r.range(0.8, 1.1)],
      color: r.chance(0.5) ? PALETTE.rock : PALETTE.rockDark,
    });
  }
  // A couple of pebbles anchor the cluster to the ground plane.
  for (let i = 0; i < 2; i++) {
    const s = r.range(0.1, 0.16);
    boxes.push({
      pos: [r.range(-0.34, 0.34), s * 0.4, r.range(-0.3, 0.3)],
      size: [s, s * 0.8, s],
      color: shade(PALETTE.rockDark, -0.08),
    });
  }
  return { scale: 1, parts: [{ name: 'rock', boxes }] };
}

/**
 * A shrub: overlapping leafy blobs on a short woody base, footprint ≤ 0.8.
 * @param {import('../core/math.js').SeededRNG} [rng]
 * @returns {object} voxel spec with parts `bush` and (sometimes) `berries`
 */
export function bushSpec(rng) {
  const r = rngOr(rng, 3000);
  const base = r.pick([PALETTE.bush, PALETTE.leaf2, PALETTE.leaf3]);
  const boxes = [
    { pos: [0, 0.06, 0], size: [0.16, 0.12, 0.16], color: PALETTE.trunkDark },
  ];
  const blobs = r.int(3, 5);
  for (let i = 0; i < blobs; i++) {
    const s = r.range(0.26, 0.44);
    boxes.push({
      pos: [r.range(-0.18, 0.18), r.range(0.14, 0.36), r.range(-0.16, 0.16)],
      size: [s, s * r.range(0.7, 1), s * r.range(0.8, 1.05)],
      color: i % 2 === 0 ? base : shade(base, r.range(-0.16, 0.14)),
    });
  }

  const parts = [{ name: 'bush', boxes }];
  if (r.chance(0.4)) {
    const berries = [];
    const count = r.int(2, 4);
    for (let i = 0; i < count; i++) {
      berries.push({
        pos: [r.range(-0.22, 0.22), r.range(0.24, 0.46), r.range(-0.2, 0.2)],
        size: [0.07, 0.07, 0.07],
        color: r.chance(0.5) ? '#e8453c' : '#f2a0d0',
      });
    }
    parts.push({ name: 'berries', boxes: berries });
  }
  return { scale: 1, parts };
}

/* ------------------------------------------------------------------ *
 * Pickups
 * ------------------------------------------------------------------ */

/**
 * A collectable coin: a 0.4 octagonal disc standing upright in the XY plane
 * (thin along Z) so the row's `rotation.y` spin flashes edge-on to face-on.
 *
 * The disc is centred on the model origin rather than resting on the ground,
 * because a coin never touches it: `rows.js` places the mesh at `COIN_Y = 0.42`
 * and the magnet animates that Y directly. Keeping the origin at the disc
 * centre makes 0.42 the literal float height of the coin's middle.
 *
 * @returns {object} voxel spec with parts `disc` and `emblem`
 */
export function coinSpec() {
  const disc = [];
  pushPrism(disc, 'z', 0, 0, 0, 0.06, 0.19, PALETTE.coin);
  // Rim: a wider, thinner prism reads as the milled edge and sets the 0.4
  // diameter the pickup radius is tuned against.
  pushPrism(disc, 'z', 0, 0, 0, 0.04, 0.2, PALETTE.coinDark);

  // Four-point star, standing 0.01 proud of each face so it is never coplanar.
  const emblem = [
    { pos: [0, 0, 0], size: [0.16, 0.05, 0.08], color: PALETTE.coinDark },
    { pos: [0, 0, 0], size: [0.05, 0.16, 0.08], color: PALETTE.coinDark },
    { pos: [0, 0, 0], size: [0.09, 0.09, 0.08], color: PALETTE.coinDark },
  ];

  return {
    scale: 1,
    parts: [
      { name: 'disc', material: 'phong', boxes: disc },
      { name: 'emblem', material: 'phong', boxes: emblem },
    ],
  };
}

/**
 * Generic pickup crate. Power-ups ship their own art (`src/data/powerups.js`);
 * this is the fallback for anything else that needs a box to grab.
 *
 * A 0.48 cage centred 0.24 above the origin (the row then floats it at
 * `CRATE_Y`), with the `core` part the row animator spins and pulses.
 *
 * @param {string} [color]
 * @returns {object} voxel spec with parts `shell` and `core`
 */
export function crateSpec(color = PALETTE.doubler) {
  const half = 0.24;
  const bar = 0.06;
  const span = half * 2;
  const barColor = color;
  const cornerColor = shade(color, -0.32);
  const shell = [];

  for (const a of [-half, half]) {
    for (const b of [-half, half]) {
      shell.push({ pos: [0, a, b], size: [span, bar, bar], color: barColor });
      shell.push({ pos: [a, 0, b], size: [bar, span, bar], color: barColor });
      shell.push({ pos: [a, b, 0], size: [bar, bar, span], color: barColor });
    }
  }
  for (const x of [-half, half]) {
    for (const y of [-half, half]) {
      for (const z of [-half, half]) {
        shell.push({ pos: [x, y, z], size: [0.09, 0.09, 0.09], color: cornerColor });
      }
    }
  }

  const bright = shade(color, 0.34);
  const core = [
    { pos: [0, 0, 0], size: [0.16, 0.16, 0.16], color: bright },
    { pos: [0, 0, 0], size: [0.26, 0.06, 0.06], color: shade(color, 0.65) },
    { pos: [0, 0, 0], size: [0.06, 0.26, 0.06], color: shade(color, 0.65) },
    { pos: [0, 0, 0], size: [0.06, 0.06, 0.26], color: shade(color, 0.65) },
  ];

  return {
    scale: 1,
    parts: [
      { name: 'shell', pivot: [0, half, 0], material: 'phong', boxes: shell },
      { name: 'core', pivot: [0, half, 0], material: 'glow', castShadow: false, boxes: core },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Rail signal
 * ------------------------------------------------------------------ */

/**
 * Level-crossing post: striped mast, cross-buck, and two lamps facing +X (the
 * playfield — `rows.js` mirrors the right-hand post with `rotation.y = π` so
 * both signals face inward).
 *
 * `parts.lamp` holds *only* the two bright bulbs, because `rows.js` toggles its
 * visibility to flash the warning; the hoods and dark lenses live in `post` so
 * the hardware never blinks out of existence with them.
 *
 * @returns {object} voxel spec with parts `post` and `lamp`
 */
export function signalSpec() {
  const white = '#e8e8e8';
  const post = [
    { pos: [0, 0.06, 0], size: [0.34, 0.12, 0.34], color: '#6a7078' },
    { pos: [0, 0.8, 0], size: [0.12, 1.6, 0.12], color: white },
  ];
  // Hazard bands, 0.01 proud of the mast.
  for (const y of [0.35, 0.75, 1.15]) {
    post.push({ pos: [0, y, 0], size: [0.14, 0.12, 0.14], color: PALETTE.railSignal });
  }

  // Cross-buck: two stepped diagonals in the YZ plane (boxes cannot rotate).
  for (let i = -3; i <= 3; i++) {
    post.push({
      pos: [0.09, 1.6 + i * 0.075, i * 0.075],
      size: [0.05, 0.1, 0.1],
      color: white,
    });
    if (i !== 0) {
      post.push({
        pos: [0.09, 1.6 + i * 0.075, -i * 0.075],
        size: [0.05, 0.1, 0.1],
        color: white,
      });
    }
  }
  post.push({ pos: [0.06, 1.6, 0], size: [0.04, 0.09, 0.62], color: '#20242c' });

  // Lamp hoods + unlit lenses, so a dark signal still reads as a signal.
  for (const z of [0.17, -0.17]) {
    post.push({ pos: [0.1, 1.18, z], size: [0.09, 0.18, 0.18], color: '#2a2d33' });
    post.push({ pos: [0.15, 1.18, z], size: [0.03, 0.13, 0.13], color: PALETTE.railSignalOff });
  }

  return {
    scale: 1,
    parts: [
      { name: 'post', boxes: post },
      {
        name: 'lamp',
        material: 'glow',
        castShadow: false,
        boxes: [
          { pos: [0.175, 1.18, 0.17], size: [0.04, 0.14, 0.14], color: PALETTE.railSignal },
          { pos: [0.175, 1.18, -0.17], size: [0.04, 0.14, 0.14], color: PALETTE.railSignal },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Eagle
 * ------------------------------------------------------------------ */

/**
 * The anti-camping eagle: a dark silhouette with a hooked beak and open talons.
 *
 * Faces -Z, matching the player's `yaw = 0`. The model origin is the *body
 * centre*, not a ground contact point, because `eagle.js` flies the group down
 * to y ≈ 0.55 — talons hang to -0.34 so they close on the player at that height.
 *
 * `wingL` / `wingR` pivot at the shoulders (±0.18) and their boxes run outward
 * to ±0.62 locally, i.e. a 1.60 wingspan, so a rotation about Z (or X) flaps
 * them around the shoulder joint exactly as `eagle.js` expects.
 *
 * @returns {object} voxel spec with parts `body`, `wingL`, `wingR`, `eyes`
 */
export function eagleSpec() {
  const dark = '#2f2a24';
  const darker = '#1d1a16';
  const head = '#40382e';
  const horn = '#e8b13a';

  const body = [
    { pos: [0, 0.02, 0.06], size: [0.42, 0.3, 0.62], color: dark },
    { pos: [0, 0.05, 0.46], size: [0.3, 0.09, 0.3], color: '#3a332b' },
    { pos: [0, 0.05, 0.64], size: [0.22, 0.07, 0.16], color: darker },
    { pos: [0, 0.1, -0.26], size: [0.26, 0.24, 0.18], color: dark },
    { pos: [0, 0.16, -0.4], size: [0.28, 0.26, 0.22], color: head },
    { pos: [0, 0.28, -0.44], size: [0.3, 0.06, 0.16], color: darker },
    { pos: [0, 0.12, -0.55], size: [0.12, 0.12, 0.16], color: horn },
    { pos: [0, 0.04, -0.59], size: [0.1, 0.09, 0.11], color: shade(horn, -0.15) },
  ];
  // Legs and talons, splayed for the grab.
  for (const s of [-1, 1]) {
    body.push({ pos: [s * 0.12, -0.16, 0.02], size: [0.1, 0.26, 0.1], color: shade(horn, -0.2) });
    body.push({ pos: [s * 0.12, -0.31, -0.02], size: [0.14, 0.08, 0.22], color: horn });
    body.push({ pos: [s * 0.12, -0.32, -0.14], size: [0.06, 0.05, 0.09], color: '#e8ddc4' });
    body.push({ pos: [s * 0.12, -0.32, 0.1], size: [0.06, 0.05, 0.09], color: '#e8ddc4' });
  }

  /** Build one wing in local space; `s` is +1 for the right (+X) wing. */
  const wing = (s) => [
    { pos: [s * 0.16, 0, 0], size: [0.32, 0.1, 0.48], color: dark },
    { pos: [s * 0.42, -0.01, 0.03], size: [0.24, 0.08, 0.4], color: '#3a332b' },
    // The forearm stops at ±0.58 so all three feather tips clear it; at 0.12
    // long it swallowed the middle tip whole and the wing read as a paddle.
    { pos: [s * 0.53, -0.02, 0.06], size: [0.1, 0.06, 0.3], color: dark },
    // Feather tips land on ±0.62 locally = ±0.80 in model space: 1.60 span.
    { pos: [s * 0.6, -0.02, -0.02], size: [0.04, 0.05, 0.1], color: darker },
    { pos: [s * 0.6, -0.03, 0.1], size: [0.04, 0.05, 0.12], color: darker },
    { pos: [s * 0.6, -0.04, 0.2], size: [0.04, 0.05, 0.1], color: darker },
  ];

  return {
    scale: 1,
    parts: [
      { name: 'body', boxes: body },
      { name: 'wingL', pivot: [-0.18, 0.08, 0.02], boxes: wing(-1) },
      { name: 'wingR', pivot: [0.18, 0.08, 0.02], boxes: wing(1) },
      {
        name: 'eyes',
        material: 'glow',
        castShadow: false,
        boxes: [
          { pos: [0.1, 0.22, -0.51], size: [0.06, 0.06, 0.05], color: '#ffd23a' },
          { pos: [-0.1, 0.22, -0.51], size: [0.06, 0.06, 0.05], color: '#ffd23a' },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Vehicle catalogue
 * ------------------------------------------------------------------ */

/**
 * Every road vehicle the traffic spawner can pick, with the numbers physics
 * trusts. `length`/`width` are measured against the boxes each spec emits:
 * cars are 1.70 x 0.90 (light plates at ±0.85, hubcaps at ±0.45), the truck
 * 3.00 x 0.90 and the bus 3.40 x 0.90.
 *
 * `weight` is a relative spawn weight — cars dominate, buses are a treat.
 * `speedMul` scales the lane speed: the heavier the vehicle the slower it
 * moves, from the sports car at 1.25 down to the bus at 0.8.
 *
 * @type {ReadonlyArray<{id:string, kind:string, spec:(color:string)=>object,
 *   length:number, width:number, weight:number, speedMul:number, honk:boolean}>}
 */
export const VEHICLE_TYPES = Object.freeze([
  {
    id: 'car',
    kind: 'car',
    spec: (color) => carSpec(color, 0),
    length: 1.7,
    width: ROAD_WIDTH,
    weight: 5,
    speedMul: 1.1,
    honk: true,
  },
  {
    id: 'sedan',
    kind: 'car',
    spec: (color) => carSpec(color, 1),
    length: 1.7,
    width: ROAD_WIDTH,
    weight: 4,
    speedMul: 1,
    honk: true,
  },
  {
    id: 'sports',
    kind: 'car',
    spec: (color) => carSpec(color, 2),
    length: 1.7,
    width: ROAD_WIDTH,
    weight: 2.5,
    speedMul: 1.25,
    honk: true,
  },
  {
    id: 'pickup',
    kind: 'car',
    spec: (color) => carSpec(color, 3),
    length: 1.7,
    width: ROAD_WIDTH,
    weight: 3,
    speedMul: 0.95,
    honk: true,
  },
  {
    id: 'taxi',
    kind: 'car',
    // Fixed livery: the lane colour is deliberately ignored.
    spec: () => taxiSpec(),
    length: 1.7,
    width: ROAD_WIDTH,
    weight: 2,
    speedMul: 1.05,
    honk: true,
  },
  {
    id: 'police',
    kind: 'car',
    spec: () => policeSpec(),
    length: 1.7,
    width: ROAD_WIDTH,
    weight: 1.2,
    speedMul: 1.2,
    // It has a siren; a horn on top of that is just noise.
    honk: false,
  },
  {
    id: 'truck',
    kind: 'truck',
    spec: (color) => truckSpec(color),
    length: 3,
    width: ROAD_WIDTH,
    weight: 1.6,
    speedMul: 0.85,
    honk: true,
  },
  {
    id: 'bus',
    kind: 'bus',
    spec: (color) => busSpec(color),
    length: 3.4,
    width: ROAD_WIDTH,
    weight: 1.2,
    speedMul: 0.8,
    honk: true,
  },
]);
