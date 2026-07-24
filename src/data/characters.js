/**
 * Character roster: metadata, economy and voxel models.
 *
 * Orientation contract — READ BEFORE EDITING A MODEL
 * --------------------------------------------------
 * Every character model **faces -Z**. Forward in gameplay is `+row`, and
 * `rowToZ(row) = -row`, so "away from the camera" is negative Z. That means:
 *
 *   - faces, beaks, snouts, eyes and chests live at **negative Z**;
 *   - tails, backpacks and rumps live at **positive Z**;
 *   - the model origin is the centre of the footprint at ground level, so
 *     `y = 0` is the sole of the foot and nothing dips below it.
 *
 * Every model fits inside a 0.86 x 0.86 footprint and stands 0.6 - 1.0 tall,
 * which is what the camera framing and the hop squash/stretch are tuned for.
 *
 * Part names are an animation contract. `body`, `head`, `legL` and `legR`
 * always exist. `armL`, `armR`, `tail`, `wingL`, `wingR`, `ear`, `accessory`
 * and `glow` are optional and animated only when present. Leg and arm pivots
 * sit at the **hip/shoulder** so a rotation about X swings the whole limb;
 * the head pivot sits at the **neck** so it nods instead of orbiting.
 *
 * Quadrupeds put their front legs in `armL`/`armR` — the animation code
 * already counter-swings arms against legs, which is exactly a four-legged
 * gait for free.
 */

import { PALETTE } from '../render/palette.js';
import { DEFAULT_CHARACTER } from '../core/constants.js';

/* ------------------------------------------------------------------ *
 * Spec authoring helpers
 * ------------------------------------------------------------------ */

/** Near-black used for every eye so the roster reads as one art style. */
const INK = PALETTE.tyre;

/**
 * Terse box literal. Positions are relative to the owning part's pivot.
 * @returns {{pos:number[], size:number[], color:string}}
 */
const bx = (x, y, z, w, h, d, color) => ({ pos: [x, y, z], size: [w, h, d], color });

/**
 * Two tiny eye boxes on the model's front face (negative Z).
 * @param {number} dx half-separation
 * @param {number} y height above the part pivot
 * @param {number} z front face (negative)
 */
const eyes = (dx, y, z, s = 0.05, d = 0.03, color = INK) => [
  bx(-dx, y, z, s, s, d, color),
  bx(dx, y, z, s, s, d, color),
];

/**
 * Build a mirrored pair of parts (legs, arms, wings, ears).
 * `boxes` are authored for the +X side and reflected for the -X side, so a
 * limb with an offset detail still mirrors correctly.
 */
function mirrorPair(nameL, nameR, pivot, boxes, material) {
  const [px, py, pz] = pivot;
  const make = (name, sx) => {
    const part = {
      name,
      pivot: [px * sx, py, pz],
      boxes: sx === 1 ? boxes : boxes.map((b) => bx(-b.pos[0], b.pos[1], b.pos[2], ...b.size, b.color)),
    };
    if (material) part.material = material;
    return part;
  };
  return [make(nameL, -1), make(nameR, 1)];
}

/* ------------------------------------------------------------------ *
 * Rarity tiers
 * ------------------------------------------------------------------ */

/**
 * Rarity presentation. Colours are mid-tone on purpose: each one clears 3:1
 * contrast against both the light (#f5f7fa) and dark (#161a33) UI surfaces,
 * so the shop needs no per-theme overrides.
 * @type {Readonly<Record<string, {id:string,label:string,color:string,glow:string}>>}
 */
export const RARITIES = Object.freeze({
  common: Object.freeze({
    id: 'common',
    label: 'Common',
    color: '#78889a',
    glow: 'rgba(120, 136, 154, 0.45)',
  }),
  rare: Object.freeze({
    id: 'rare',
    label: 'Rare',
    color: '#2f96da',
    glow: 'rgba(47, 150, 218, 0.5)',
  }),
  epic: Object.freeze({
    id: 'epic',
    label: 'Epic',
    color: '#9b5de5',
    glow: 'rgba(155, 93, 229, 0.5)',
  }),
  legendary: Object.freeze({
    id: 'legendary',
    label: 'Legendary',
    color: '#f0921f',
    glow: 'rgba(240, 146, 31, 0.55)',
  }),
});

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

/** Chicken — the starter. White, red comb, orange scaly legs. */
function buildChicken() {
  const BODY = '#f6f4ee';
  const SHADE = '#e2ddd0';
  const COMB = '#e5484d';
  const BEAK = '#f2a33a';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.2, 0],
        boxes: [
          bx(0, 0.16, 0.01, 0.4, 0.32, 0.36, BODY),
          bx(0, 0.08, 0.17, 0.28, 0.18, 0.05, SHADE),
        ],
      },
      ...mirrorPair('wingL', 'wingR', [0.21, 0.34, 0.01], [bx(0, 0, 0, 0.05, 0.18, 0.24, SHADE)]),
      {
        name: 'tail',
        pivot: [0, 0.42, 0.17],
        boxes: [
          bx(0, 0.02, 0.06, 0.22, 0.15, 0.1, BODY),
          bx(0, 0.11, 0.1, 0.14, 0.1, 0.08, SHADE),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.5, -0.02],
        boxes: [
          bx(0, 0.11, 0, 0.28, 0.24, 0.26, BODY),
          bx(0, 0.26, 0.01, 0.06, 0.09, 0.16, COMB), // comb
          bx(0, 0.09, -0.16, 0.09, 0.07, 0.09, BEAK),
          bx(0, 0.02, -0.13, 0.05, 0.07, 0.05, COMB), // wattle
          ...eyes(0.08, 0.15, -0.13, 0.06),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.11, 0.2, 0], [
        bx(0, -0.1, 0, 0.06, 0.2, 0.06, BEAK),
        bx(0, -0.185, -0.04, 0.1, 0.03, 0.14, '#d98c22'),
      ]),
    ],
  };
}

/** Duckling — round, yellow, flat orange bill and webbed feet. */
function buildDuck() {
  const BODY = '#ffd85e';
  const SHADE = '#f2c134';
  const FLUFF = '#ffe694';
  const BILL = '#f08a2e';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.17, 0],
        boxes: [
          bx(0, 0.15, 0.02, 0.38, 0.3, 0.36, BODY),
          bx(0, 0.05, -0.03, 0.3, 0.12, 0.28, FLUFF),
        ],
      },
      ...mirrorPair('wingL', 'wingR', [0.2, 0.32, 0.02], [bx(0, 0, 0, 0.05, 0.16, 0.22, SHADE)]),
      { name: 'tail', pivot: [0, 0.34, 0.18], boxes: [bx(0, 0.02, 0.06, 0.16, 0.1, 0.1, SHADE)] },
      {
        name: 'head',
        pivot: [0, 0.46, -0.01],
        boxes: [
          bx(0, 0.11, 0, 0.26, 0.24, 0.24, BODY),
          bx(0, 0.25, 0.02, 0.05, 0.07, 0.06, SHADE), // tuft
          bx(0, 0.06, -0.18, 0.16, 0.05, 0.14, BILL),
          ...eyes(0.075, 0.16, -0.12),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.1, 0.17, 0], [
        bx(0, -0.085, 0, 0.055, 0.17, 0.055, BILL),
        bx(0, -0.1525, -0.05, 0.13, 0.035, 0.16, '#e07a22'),
      ]),
    ],
  };
}

/** Frog — squat, splayed legs, bulging eyes that sit above the skull. */
function buildFrog() {
  const GREEN = PALETTE.leaf2;
  const DARK = PALETTE.leaf3;
  const BELLY = '#e8f2c8';
  const MOUTH = '#2f7a26';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.2, 0],
        boxes: [
          bx(0, 0.12, 0.02, 0.42, 0.26, 0.32, GREEN),
          bx(0, 0.03, -0.04, 0.32, 0.12, 0.24, BELLY),
        ],
      },
      ...mirrorPair('armL', 'armR', [0.19, 0.24, -0.09], [
        bx(0, -0.09, 0, 0.07, 0.18, 0.07, GREEN),
        bx(0, -0.185, -0.03, 0.1, 0.05, 0.11, DARK),
      ]),
      {
        name: 'head',
        pivot: [0, 0.4, -0.03],
        boxes: [
          bx(0, 0.08, -0.01, 0.34, 0.18, 0.26, GREEN),
          bx(0, 0, -0.12, 0.28, 0.03, 0.04, MOUTH), // wide grin
          bx(-0.11, 0.21, -0.02, 0.14, 0.14, 0.14, GREEN),
          bx(0.11, 0.21, -0.02, 0.14, 0.14, 0.14, GREEN),
          ...eyes(0.11, 0.23, -0.08, 0.06),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.19, 0.2, 0.03], [
        bx(0, -0.07, 0.05, 0.12, 0.14, 0.2, DARK),
        bx(0, -0.17, -0.05, 0.11, 0.06, 0.24, GREEN),
      ]),
    ],
  };
}

/** Piglet — barrel body, flat snout with two nostrils, curly tail. */
function buildPiglet() {
  const PINK = '#f4a6b8';
  const DARK = '#e08aa0';
  const SNOUT = '#ef8fa6';
  const HOOF = '#c96f88';
  const leg = [bx(0, -0.12, 0, 0.11, 0.24, 0.11, PINK), bx(0, -0.215, 0, 0.12, 0.05, 0.12, HOOF)];
  return {
    scale: 1,
    parts: [
      { name: 'body', pivot: [0, 0.24, 0], boxes: [bx(0, 0.13, 0, 0.36, 0.26, 0.42, PINK)] },
      ...mirrorPair('armL', 'armR', [0.13, 0.24, -0.12], leg),
      {
        name: 'tail',
        pivot: [0, 0.38, 0.2],
        boxes: [
          bx(0, 0.02, 0.04, 0.05, 0.05, 0.08, DARK),
          bx(0.04, 0.08, 0.07, 0.05, 0.1, 0.05, DARK),
        ],
      },
      {
        name: 'ear',
        pivot: [0, 0.6, -0.14],
        boxes: [
          bx(-0.1, 0.05, 0.02, 0.09, 0.09, 0.05, DARK),
          bx(0.1, 0.05, 0.02, 0.09, 0.09, 0.05, DARK),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.44, -0.2],
        boxes: [
          bx(0, 0.11, 0, 0.3, 0.24, 0.24, PINK),
          bx(0, 0.06, -0.14, 0.16, 0.12, 0.08, SNOUT),
          bx(-0.04, 0.06, -0.185, 0.03, 0.04, 0.02, '#a8536b'),
          bx(0.04, 0.06, -0.185, 0.03, 0.04, 0.02, '#a8536b'),
          ...eyes(0.09, 0.16, -0.11, 0.055),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.13, 0.24, 0.11], leg),
    ],
  };
}

/** Corgi — long body, stubby white-socked legs, oversized upright ears. */
function buildCorgi() {
  const COAT = '#e0913f';
  const CREAM = '#f7f1e6';
  const NOSE = '#2b2320';
  const leg = [
    bx(0, -0.075, 0, 0.1, 0.15, 0.1, COAT),
    bx(0, -0.155, -0.01, 0.11, 0.03, 0.12, CREAM),
  ];
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.17, 0],
        boxes: [
          bx(0, 0.13, 0.02, 0.34, 0.26, 0.42, COAT),
          bx(0, 0.05, -0.12, 0.3, 0.16, 0.22, CREAM),
        ],
      },
      ...mirrorPair('armL', 'armR', [0.14, 0.17, -0.14], leg),
      { name: 'tail', pivot: [0, 0.34, 0.22], boxes: [bx(0, 0.04, 0.03, 0.1, 0.12, 0.08, COAT)] },
      {
        name: 'ear',
        pivot: [0, 0.56, -0.18],
        boxes: [
          bx(-0.1, 0.06, 0, 0.09, 0.14, 0.05, COAT),
          bx(0.1, 0.06, 0, 0.09, 0.14, 0.05, COAT),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.38, -0.18],
        boxes: [
          bx(0, 0.12, 0, 0.28, 0.24, 0.24, COAT),
          bx(0, 0.07, -0.15, 0.16, 0.12, 0.1, CREAM),
          bx(0, 0.1, -0.205, 0.07, 0.05, 0.04, NOSE),
          ...eyes(0.085, 0.16, -0.115),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.14, 0.17, 0.14], leg),
    ],
  };
}

/** Penguin — upright tuxedo body with rigid flippers and orange feet. */
function buildPenguin() {
  const BLACK = '#2b3340';
  const WHITE = '#f4f6f8';
  const BEAK = '#f2a33a';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.13, 0],
        boxes: [
          bx(0, 0.2, 0.02, 0.38, 0.4, 0.34, BLACK),
          bx(0, 0.18, -0.13, 0.28, 0.34, 0.1, WHITE),
        ],
      },
      ...mirrorPair('wingL', 'wingR', [0.19, 0.36, 0.02], [bx(0, -0.04, 0, 0.05, 0.24, 0.14, BLACK)]),
      { name: 'tail', pivot: [0, 0.16, 0.17], boxes: [bx(0, 0.02, 0.05, 0.16, 0.06, 0.1, BLACK)] },
      {
        name: 'head',
        pivot: [0, 0.53, 0],
        boxes: [
          bx(0, 0.11, 0.01, 0.28, 0.24, 0.26, BLACK),
          bx(0, 0.09, -0.11, 0.2, 0.18, 0.06, WHITE),
          bx(0, 0.09, -0.17, 0.09, 0.06, 0.09, BEAK),
          ...eyes(0.07, 0.15, -0.145),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.1, 0.13, 0], [
        bx(0, -0.06, 0, 0.07, 0.12, 0.07, BEAK),
        bx(0, -0.11, -0.06, 0.13, 0.04, 0.17, '#e08a22'),
      ]),
    ],
  };
}

/** Cat — grey tabby with striped back, pink nose and a tail held high. */
function buildCat() {
  const GREY = '#8e97a3';
  const DARK = '#6f7986';
  const WHITE = '#f2f0ea';
  const NOSE = '#f08a9b';
  const INNER = '#f0a8b4';
  const leg = [bx(0, -0.085, 0, 0.09, 0.17, 0.09, GREY)];
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.17, 0],
        boxes: [
          bx(0, 0.14, 0.01, 0.3, 0.28, 0.4, GREY),
          bx(0, 0.28, 0.06, 0.24, 0.04, 0.06, DARK), // tabby stripe
          bx(0, 0.06, -0.16, 0.22, 0.14, 0.1, WHITE),
        ],
      },
      ...mirrorPair('armL', 'armR', [0.12, 0.17, -0.13], leg),
      {
        name: 'tail',
        pivot: [0, 0.36, 0.2],
        boxes: [
          bx(0, 0.06, 0.03, 0.07, 0.16, 0.07, GREY),
          bx(0, 0.2, 0.02, 0.07, 0.14, 0.07, GREY),
          bx(0, 0.29, 0.02, 0.07, 0.06, 0.07, WHITE),
        ],
      },
      {
        name: 'ear',
        pivot: [0, 0.58, -0.14],
        boxes: [
          bx(-0.09, 0.05, 0, 0.09, 0.11, 0.05, GREY),
          bx(0.09, 0.05, 0, 0.09, 0.11, 0.05, GREY),
          bx(-0.09, 0.03, -0.02, 0.05, 0.06, 0.03, INNER),
          bx(0.09, 0.03, -0.02, 0.05, 0.06, 0.03, INNER),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.4, -0.14],
        boxes: [
          bx(0, 0.12, 0, 0.26, 0.24, 0.24, GREY),
          bx(0, 0.06, -0.12, 0.14, 0.1, 0.08, WHITE),
          bx(0, 0.09, -0.165, 0.05, 0.04, 0.03, NOSE),
          ...eyes(0.08, 0.16, -0.115, 0.05, 0.04),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.12, 0.17, 0.13], leg),
    ],
  };
}

/** Fox — black-tipped ears, black socks and a fat white-tipped brush tail. */
function buildFox() {
  const ORANGE = '#e2703a';
  const WHITE = '#f6efe4';
  const BLACK = '#2a2320';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.17, 0],
        boxes: [
          bx(0, 0.14, 0.01, 0.3, 0.28, 0.4, ORANGE),
          bx(0, 0.06, -0.16, 0.22, 0.14, 0.1, WHITE),
        ],
      },
      ...mirrorPair('armL', 'armR', [0.12, 0.17, -0.13], [bx(0, -0.085, 0, 0.09, 0.17, 0.09, ORANGE)]),
      {
        name: 'tail',
        pivot: [0, 0.34, 0.18],
        boxes: [
          bx(0, 0.02, 0.06, 0.16, 0.16, 0.14, ORANGE),
          bx(0, 0.1, 0.15, 0.19, 0.19, 0.12, ORANGE),
          bx(0, 0.19, 0.21, 0.16, 0.16, 0.08, WHITE),
        ],
      },
      {
        name: 'ear',
        pivot: [0, 0.56, -0.13],
        boxes: [
          bx(-0.09, 0.06, 0, 0.09, 0.13, 0.05, ORANGE),
          bx(0.09, 0.06, 0, 0.09, 0.13, 0.05, ORANGE),
          bx(-0.09, 0.135, 0, 0.07, 0.05, 0.05, BLACK),
          bx(0.09, 0.135, 0, 0.07, 0.05, 0.05, BLACK),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.38, -0.13],
        boxes: [
          bx(0, 0.12, 0.01, 0.26, 0.23, 0.22, ORANGE),
          bx(0, 0.06, -0.13, 0.11, 0.09, 0.12, WHITE),
          bx(0, 0.085, -0.2, 0.06, 0.05, 0.04, BLACK),
          ...eyes(0.075, 0.16, -0.105),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.12, 0.17, 0.13], [
        bx(0, -0.07, 0, 0.09, 0.14, 0.09, ORANGE),
        bx(0, -0.155, 0, 0.095, 0.03, 0.095, BLACK),
      ]),
    ],
  };
}

/** Raccoon — bandit mask over a pale face, ringed tail, dark little hands. */
function buildRaccoon() {
  const GREY = '#8b93a0';
  const DARK = '#5b6470';
  const MASK = '#2f353f';
  const WHITE = '#e8ebf0';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.17, 0],
        boxes: [
          bx(0, 0.14, 0.01, 0.3, 0.28, 0.38, GREY),
          bx(0, 0.07, -0.15, 0.22, 0.16, 0.1, WHITE),
        ],
      },
      ...mirrorPair('armL', 'armR', [0.12, 0.19, -0.13], [bx(0, -0.095, 0, 0.08, 0.19, 0.08, DARK)]),
      {
        name: 'tail',
        pivot: [0, 0.3, 0.19],
        boxes: [
          bx(0, 0.02, 0.06, 0.14, 0.14, 0.1, GREY),
          bx(0, 0.08, 0.15, 0.14, 0.14, 0.09, MASK),
          bx(0, 0.15, 0.22, 0.13, 0.13, 0.08, GREY),
        ],
      },
      {
        name: 'ear',
        pivot: [0, 0.58, -0.12],
        boxes: [
          bx(-0.1, 0.04, 0, 0.08, 0.09, 0.05, GREY),
          bx(0.1, 0.04, 0, 0.08, 0.09, 0.05, GREY),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.4, -0.12],
        boxes: [
          bx(0, 0.12, 0, 0.26, 0.23, 0.23, WHITE),
          bx(0, 0.14, -0.1, 0.27, 0.11, 0.06, MASK),
          bx(0, 0.05, -0.13, 0.12, 0.09, 0.1, WHITE),
          bx(0, 0.07, -0.19, 0.05, 0.04, 0.03, '#22262c'),
          ...eyes(0.075, 0.145, -0.135),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.12, 0.17, 0.13], [bx(0, -0.085, 0, 0.09, 0.17, 0.09, DARK)]),
    ],
  };
}

/** Robot — boxy chassis, glowing visor bar, chest lamp and a bobbing antenna. */
function buildRobot() {
  const STEEL = '#9aa4b2';
  const DARK = '#5d6675';
  const BOLT = '#ff5a5a';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.28, 0],
        boxes: [
          bx(0, 0.17, 0, 0.34, 0.34, 0.26, STEEL),
          bx(0, 0.14, -0.14, 0.24, 0.2, 0.04, DARK),
          bx(0, 0.19, -0.165, 0.07, 0.07, 0.02, PALETTE.coin), // chest lamp
        ],
      },
      ...mirrorPair('armL', 'armR', [0.2, 0.52, 0], [bx(0, -0.1, 0, 0.08, 0.22, 0.08, DARK)]),
      {
        name: 'head',
        pivot: [0, 0.62, 0],
        boxes: [
          bx(0, 0.11, 0, 0.28, 0.22, 0.24, STEEL),
          bx(0, 0.01, -0.09, 0.2, 0.04, 0.08, DARK), // jaw grille
          bx(0, 0.22, 0.03, 0.03, 0.12, 0.03, DARK), // antenna rod
          ...eyes(0.07, 0.13, -0.135, 0.045),
        ],
      },
      {
        name: 'glow',
        material: 'glow',
        pivot: [0, 0.62, 0],
        boxes: [
          bx(0, 0.13, -0.125, 0.22, 0.09, 0.02, PALETTE.shield), // visor
          bx(0, 0.315, 0.03, 0.07, 0.07, 0.07, BOLT), // antenna bulb
        ],
      },
      ...mirrorPair('legL', 'legR', [0.11, 0.28, 0], [
        bx(0, -0.13, 0, 0.1, 0.24, 0.1, DARK),
        bx(0, -0.255, -0.03, 0.14, 0.05, 0.18, STEEL),
      ]),
    ],
  };
}

/** Astronaut — soft suit, life-support pack and a translucent glass helmet. */
function buildAstronaut() {
  const SUIT = '#eef1f5';
  const SHADE = '#d5dae2';
  const ACCENT = PALETTE.carBlue;
  const SKIN = '#e8b48c';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.3, 0],
        boxes: [
          bx(0, 0.16, 0, 0.32, 0.32, 0.24, SUIT),
          bx(0, 0.2, -0.125, 0.26, 0.05, 0.02, ACCENT),
          bx(0, 0.18, 0.15, 0.26, 0.28, 0.1, PALETTE.hubcap), // life-support pack
        ],
      },
      ...mirrorPair('armL', 'armR', [0.19, 0.54, 0], [
        bx(0, -0.11, 0, 0.08, 0.24, 0.08, SUIT),
        bx(0, -0.245, 0, 0.09, 0.06, 0.09, ACCENT),
      ]),
      {
        name: 'head',
        pivot: [0, 0.62, 0],
        boxes: [
          bx(0, -0.01, 0, 0.26, 0.04, 0.24, SHADE), // neck ring
          bx(0, 0.1, -0.01, 0.2, 0.2, 0.18, SKIN),
          ...eyes(0.055, 0.12, -0.105, 0.04),
        ],
      },
      // The helmet is rigid to the torso, not the head, so the face can nod
      // inside it. 'glass' is a depth-write-free transparent phong material.
      {
        name: 'accessory',
        material: 'glass',
        pivot: [0, 0.62, 0],
        boxes: [bx(0, 0.11, -0.01, 0.3, 0.3, 0.28, PALETTE.glass)],
      },
      {
        name: 'glow',
        material: 'glow',
        pivot: [0, 0.62, 0],
        boxes: [bx(0.12, 0.22, -0.05, 0.05, 0.05, 0.05, PALETTE.headlight)],
      },
      ...mirrorPair('legL', 'legR', [0.11, 0.3, 0], [
        bx(0, -0.14, 0, 0.11, 0.26, 0.11, SUIT),
        bx(0, -0.275, -0.03, 0.13, 0.05, 0.16, ACCENT),
      ]),
    ],
  };
}

/** Ninja — hooded, red headband with trailing ties, katana slung on the back. */
function buildNinja() {
  const CLOTH = '#2b3550';
  const CLOTH2 = '#1f273b';
  const SKIN = '#e8b48c';
  const BAND = PALETTE.carRed;
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.26, 0],
        boxes: [
          bx(0, 0.16, 0, 0.3, 0.32, 0.22, CLOTH),
          bx(0, 0.06, 0, 0.31, 0.06, 0.23, BAND), // sash
        ],
      },
      ...mirrorPair('armL', 'armR', [0.18, 0.5, 0], [
        bx(0, -0.1, 0, 0.07, 0.22, 0.07, CLOTH),
        bx(0, -0.225, 0, 0.08, 0.05, 0.08, SKIN),
      ]),
      {
        name: 'accessory',
        pivot: [0, 0.44, 0.13],
        boxes: [
          bx(0, 0.1, 0.02, 0.03, 0.34, 0.03, '#c9d2dc'), // blade
          bx(0, -0.04, 0.02, 0.08, 0.02, 0.08, PALETTE.dirt), // guard
          bx(0, -0.1, 0.02, 0.035, 0.1, 0.035, '#3a2b1c'), // hilt
        ],
      },
      // Headband ties live on 'tail' so the existing tail flutter animates them.
      {
        name: 'tail',
        pivot: [0, 0.74, 0.1],
        boxes: [
          bx(0.05, -0.02, 0.06, 0.03, 0.03, 0.14, BAND),
          bx(0.1, -0.08, 0.13, 0.03, 0.03, 0.12, BAND),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.58, 0],
        boxes: [
          bx(0, 0.11, 0, 0.26, 0.22, 0.24, CLOTH),
          bx(0, 0.19, 0, 0.27, 0.05, 0.25, BAND),
          bx(0, 0.13, -0.115, 0.2, 0.07, 0.03, SKIN), // eye slit
          ...eyes(0.06, 0.13, -0.132, 0.045, 0.02),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.11, 0.26, 0], [
        bx(0, -0.13, 0, 0.1, 0.24, 0.1, CLOTH2),
        bx(0, -0.24, -0.03, 0.11, 0.04, 0.14, '#171d2c'),
      ]),
    ],
  };
}

/** Dino — heavy hind legs, comedy arms, toothy snout, orange back plates. */
function buildDino() {
  const GREEN = '#5aa84a';
  const DARK = '#41903a';
  const BELLY = '#dfe89a';
  const PLATE = '#f2a33a';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.3, 0],
        boxes: [
          bx(0, 0.14, 0.02, 0.32, 0.3, 0.36, GREEN),
          bx(0, 0.06, -0.1, 0.24, 0.16, 0.16, BELLY),
        ],
      },
      ...mirrorPair('armL', 'armR', [0.15, 0.46, -0.06], [bx(0, -0.06, 0, 0.05, 0.13, 0.05, GREEN)]),
      {
        name: 'tail',
        pivot: [0, 0.4, 0.18],
        boxes: [
          bx(0, -0.02, 0.06, 0.16, 0.14, 0.12, GREEN),
          bx(0, -0.08, 0.16, 0.11, 0.1, 0.1, GREEN),
          bx(0, -0.13, 0.23, 0.07, 0.07, 0.08, DARK),
        ],
      },
      {
        name: 'accessory',
        pivot: [0, 0.3, 0],
        boxes: [
          bx(0, 0.33, -0.1, 0.05, 0.11, 0.08, PLATE),
          bx(0, 0.35, 0, 0.05, 0.13, 0.08, PLATE),
          bx(0, 0.32, 0.1, 0.05, 0.1, 0.08, PLATE),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.56, -0.06],
        boxes: [
          bx(0, 0.1, -0.04, 0.26, 0.2, 0.26, GREEN),
          bx(0, 0.05, -0.2, 0.2, 0.13, 0.12, GREEN),
          bx(0, -0.015, -0.2, 0.18, 0.03, 0.11, '#f7f7f2'), // teeth
          bx(0, 0.2, -0.13, 0.24, 0.04, 0.1, DARK), // brow
          ...eyes(0.085, 0.155, -0.16),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.13, 0.3, 0.03], [
        bx(0, -0.13, 0.01, 0.14, 0.26, 0.16, GREEN),
        bx(0, -0.275, -0.05, 0.14, 0.05, 0.2, DARK),
      ]),
    ],
  };
}

/** Dragon — membrane wings, cream horns, gold belly and a spaded tail. */
function buildDragon() {
  const RED = '#cf4436';
  const DARK = '#a33328';
  const BELLY = '#f2c34a';
  const HORN = '#f3e6cf';
  const MEMB = '#8a2d3a';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.24, 0],
        boxes: [
          bx(0, 0.14, 0.02, 0.3, 0.28, 0.34, RED),
          bx(0, 0.06, -0.1, 0.22, 0.14, 0.18, BELLY),
        ],
      },
      ...mirrorPair('wingL', 'wingR', [0.16, 0.42, 0.06], [
        bx(0.08, 0.12, 0, 0.04, 0.3, 0.2, MEMB),
        bx(0.16, 0.2, 0.02, 0.04, 0.2, 0.14, MEMB),
      ]),
      {
        name: 'tail',
        pivot: [0, 0.32, 0.16],
        boxes: [
          bx(0, 0, 0.06, 0.12, 0.12, 0.12, RED),
          bx(0, -0.04, 0.15, 0.08, 0.08, 0.09, RED),
          bx(0, -0.02, 0.22, 0.1, 0.1, 0.06, BELLY), // spade
        ],
      },
      {
        name: 'ear',
        pivot: [0, 0.62, 0.02],
        boxes: [
          bx(-0.09, 0.09, 0, 0.05, 0.14, 0.05, HORN),
          bx(0.09, 0.09, 0, 0.05, 0.14, 0.05, HORN),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.5, -0.06],
        boxes: [
          bx(0, 0.11, -0.02, 0.24, 0.2, 0.24, RED),
          bx(0, 0.06, -0.18, 0.17, 0.12, 0.14, RED),
          bx(0, 0, -0.18, 0.15, 0.03, 0.13, HORN), // fangs
          ...eyes(0.08, 0.16, -0.135),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.12, 0.24, 0.06], [
        bx(0, -0.11, 0, 0.11, 0.22, 0.13, RED),
        bx(0, -0.215, -0.05, 0.12, 0.05, 0.16, DARK),
      ]),
    ],
  };
}

/** Yeti — shaggy shoulder mantle, long knuckle-dragging arms, blue face. */
function buildYeti() {
  const FUR = '#eaf2f7';
  const FUR2 = '#d3e2ec';
  const FACE = '#a8cfe6';
  const MOUTH = '#6f9cbe';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.24, 0],
        boxes: [
          bx(0, 0.2, 0, 0.38, 0.4, 0.28, FUR),
          bx(0, 0.14, -0.13, 0.26, 0.24, 0.06, FUR2),
        ],
      },
      {
        name: 'accessory',
        pivot: [0, 0.24, 0],
        boxes: [
          bx(0, 0.42, 0, 0.46, 0.09, 0.32, FUR), // shaggy mantle
          bx(-0.21, 0.33, 0.02, 0.1, 0.12, 0.24, FUR2),
          bx(0.21, 0.33, 0.02, 0.1, 0.12, 0.24, FUR2),
        ],
      },
      ...mirrorPair('armL', 'armR', [0.22, 0.52, 0], [
        bx(0, -0.14, 0, 0.1, 0.3, 0.1, FUR),
        bx(0, -0.32, -0.01, 0.13, 0.1, 0.13, FUR2),
      ]),
      {
        name: 'head',
        pivot: [0, 0.72, 0],
        boxes: [
          bx(0, 0.09, 0, 0.3, 0.22, 0.26, FUR),
          bx(0, 0.06, -0.12, 0.22, 0.16, 0.06, FACE),
          bx(0, 0.16, -0.12, 0.26, 0.05, 0.07, FUR2), // heavy brow
          bx(0, 0, -0.12, 0.14, 0.04, 0.05, MOUTH),
          ...eyes(0.07, 0.09, -0.15),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.14, 0.24, 0], [
        bx(0, -0.11, 0, 0.15, 0.22, 0.15, FUR),
        bx(0, -0.215, -0.04, 0.17, 0.05, 0.21, FACE),
      ]),
    ],
  };
}

/** Phoenix — three-plume glowing crest and a fan of glowing tail feathers. */
function buildPhoenix() {
  const FIRE = '#ff7a2a';
  const FIRE2 = '#ffb347';
  const BEAK = '#ffd98a';
  const TALON = '#e8a02a';
  return {
    scale: 1,
    parts: [
      {
        name: 'body',
        pivot: [0, 0.2, 0],
        boxes: [
          bx(0, 0.17, 0.01, 0.34, 0.32, 0.32, FIRE),
          bx(0, 0.1, -0.13, 0.24, 0.2, 0.08, FIRE2),
        ],
      },
      ...mirrorPair('wingL', 'wingR', [0.19, 0.4, 0.02], [bx(0.03, 0.02, 0, 0.05, 0.26, 0.22, FIRE2)]),
      {
        name: 'tail',
        material: 'glow',
        pivot: [0, 0.34, 0.17],
        boxes: [
          bx(0, 0.02, 0.08, 0.1, 0.08, 0.16, PALETTE.coin),
          bx(-0.09, 0.1, 0.13, 0.07, 0.07, 0.16, PALETTE.jetpack),
          bx(0.09, 0.1, 0.13, 0.07, 0.07, 0.16, PALETTE.jetpack),
        ],
      },
      {
        name: 'accessory',
        material: 'glow',
        pivot: [0, 0.52, -0.01],
        boxes: [
          bx(0, 0.26, 0.03, 0.05, 0.14, 0.06, PALETTE.coin),
          bx(0, 0.32, -0.04, 0.05, 0.1, 0.06, PALETTE.jetpack),
          bx(0, 0.22, -0.1, 0.05, 0.09, 0.05, PALETTE.coin),
        ],
      },
      {
        name: 'head',
        pivot: [0, 0.52, -0.01],
        boxes: [
          bx(0, 0.1, 0, 0.24, 0.22, 0.22, FIRE),
          bx(0, 0.06, -0.15, 0.09, 0.07, 0.1, BEAK),
          ...eyes(0.07, 0.14, -0.1),
        ],
      },
      ...mirrorPair('legL', 'legR', [0.1, 0.2, 0], [
        bx(0, -0.1, 0, 0.06, 0.2, 0.06, TALON),
        bx(0, -0.185, -0.05, 0.1, 0.03, 0.14, '#c9821f'),
      ]),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */

/**
 * The full roster, in shop order (cheapest first).
 *
 * Prices are balanced against ~1 coin per pickup and 15-40 coins for a decent
 * run, so the first unlock lands after a couple of runs and the legendaries
 * are a long-tail goal rather than a grind wall.
 *
 * Perks are deliberately sparse and tiny (±15%): the roster is mostly
 * cosmetic, and a run should never be won by the shop. Perk value units:
 * `coinBonus`/`magnetRadius`/`hopSpeed`/`riverGrip` are multipliers,
 * `eagleGrace` is extra seconds, `startShield` is a boolean.
 *
 * @type {Array<{id:string, name:string, rarity:string, price:number,
 *   description:string, hopSound:{baseFreq:number, type:OscillatorType},
 *   perk:null|{id:string, label:string, value:number|boolean},
 *   build:() => object}>}
 */
export const CHARACTERS = [
  {
    id: 'chicken',
    name: 'Chicken',
    rarity: 'common',
    price: 0,
    description: 'The original road-crosser: fearless, featherbrained and free.',
    hopSound: { baseFreq: 640, type: 'triangle' },
    perk: null,
    build: buildChicken,
  },
  {
    id: 'duck',
    name: 'Duckling',
    rarity: 'common',
    price: 30,
    description: 'Waddles like it owns the river, and honestly it might.',
    hopSound: { baseFreq: 560, type: 'triangle' },
    perk: null,
    build: buildDuck,
  },
  {
    id: 'frog',
    name: 'Frog',
    rarity: 'common',
    price: 45,
    description: 'Born for the water rows; the traffic is the awkward part.',
    hopSound: { baseFreq: 240, type: 'square' },
    perk: null,
    build: buildFrog,
  },
  {
    id: 'piglet',
    name: 'Piglet',
    rarity: 'common',
    price: 60,
    description: 'Small, pink and entirely unbothered by oncoming trucks.',
    hopSound: { baseFreq: 380, type: 'sawtooth' },
    perk: null,
    build: buildPiglet,
  },
  {
    id: 'corgi',
    name: 'Corgi',
    rarity: 'common',
    price: 85,
    description: 'Low centre of gravity, extremely high centre of enthusiasm.',
    hopSound: { baseFreq: 430, type: 'triangle' },
    perk: { id: 'magnetRadius', label: 'Keen Nose: +8% coin pull', value: 1.08 },
    build: buildCorgi,
  },
  {
    id: 'penguin',
    name: 'Penguin',
    rarity: 'rare',
    price: 110,
    description: 'Slides through the frost rows like the logs owe it money.',
    hopSound: { baseFreq: 500, type: 'triangle' },
    perk: { id: 'riverGrip', label: 'Ice Feet: +15% footing on platforms', value: 1.15 },
    build: buildPenguin,
  },
  {
    id: 'cat',
    name: 'Cat',
    rarity: 'rare',
    price: 140,
    description: 'Naps until the eagle loses interest, then strolls across.',
    hopSound: { baseFreq: 700, type: 'sine' },
    perk: { id: 'eagleGrace', label: 'Cat Nap: +1s before the eagle stirs', value: 1 },
    build: buildCat,
  },
  {
    id: 'fox',
    name: 'Fox',
    rarity: 'rare',
    price: 170,
    description: 'Quick paws, quicker exits, tail like a victory flag.',
    hopSound: { baseFreq: 620, type: 'triangle' },
    perk: { id: 'hopSpeed', label: 'Quick Paws: 8% faster hops', value: 0.92 },
    build: buildFox,
  },
  {
    id: 'raccoon',
    name: 'Raccoon',
    rarity: 'rare',
    price: 210,
    description: 'Turns up wherever coins are being poorly guarded.',
    hopSound: { baseFreq: 470, type: 'triangle' },
    perk: { id: 'coinBonus', label: 'Sticky Fingers: +10% coin value', value: 1.1 },
    build: buildRaccoon,
  },
  {
    id: 'robot',
    name: 'Robot',
    rarity: 'epic',
    price: 280,
    description: 'Chassis-mounted magnet; the coins simply stop resisting.',
    hopSound: { baseFreq: 330, type: 'square' },
    perk: { id: 'magnetRadius', label: 'Magnetic Chassis: +15% coin pull', value: 1.15 },
    build: buildRobot,
  },
  {
    id: 'astronaut',
    name: 'Astronaut',
    rarity: 'epic',
    price: 340,
    description: 'Trained for zero gravity, currently employed dodging buses.',
    hopSound: { baseFreq: 400, type: 'sine' },
    perk: null,
    build: buildAstronaut,
  },
  {
    id: 'ninja',
    name: 'Ninja',
    rarity: 'epic',
    price: 400,
    description: 'Two hops ahead and gone before the horn finishes sounding.',
    hopSound: { baseFreq: 520, type: 'sine' },
    perk: { id: 'hopSpeed', label: 'Shadow Step: 10% faster hops', value: 0.9 },
    build: buildNinja,
  },
  {
    id: 'dino',
    name: 'Dino',
    rarity: 'epic',
    price: 480,
    description: 'Tiny arms, enormous confidence, spectacular back plates.',
    hopSound: { baseFreq: 190, type: 'sawtooth' },
    perk: null,
    build: buildDino,
  },
  {
    id: 'dragon',
    name: 'Dragon',
    rarity: 'legendary',
    price: 620,
    description: 'Counts every coin twice and remembers exactly where you dropped it.',
    hopSound: { baseFreq: 180, type: 'sawtooth' },
    perk: { id: 'coinBonus', label: "Hoarder's Instinct: +15% coin value", value: 1.15 },
    build: buildDragon,
  },
  {
    id: 'yeti',
    name: 'Yeti',
    rarity: 'legendary',
    price: 760,
    description: 'Three hundred kilos of politely inconvenienced snow.',
    hopSound: { baseFreq: 200, type: 'square' },
    perk: null,
    build: buildYeti,
  },
  {
    id: 'phoenix',
    name: 'Phoenix',
    rarity: 'legendary',
    price: 900,
    description: 'Starts every run already on fire, in the good way.',
    hopSound: { baseFreq: 760, type: 'triangle' },
    perk: { id: 'startShield', label: 'Reborn: begin each run shielded', value: true },
    build: buildPhoenix,
  },
];

const BY_ID = new Map(CHARACTERS.map((c) => [c.id, c]));
const STARTER = BY_ID.get(DEFAULT_CHARACTER) ?? CHARACTERS[0];

/** Built specs, keyed by character id. Models are immutable, so one is enough. */
const specCache = new Map();

/**
 * Look up a roster entry.
 *
 * Never returns null: an unknown id (stale save, hand-edited profile) resolves
 * to the starter so nothing downstream has to null-check a character.
 *
 * @param {string} id
 * @returns {object} the character entry
 */
export function getCharacter(id) {
  return BY_ID.get(id) ?? STARTER;
}

/**
 * Voxel spec for a character, built once and memoised.
 *
 * Callers may pass the spec to `recolorSpec`/`extendSpec` (both of which copy)
 * but must not mutate the returned object — it is shared by every consumer.
 *
 * @param {string} id
 * @returns {object} voxel spec, see `src/render/voxel.js`
 */
export function characterSpec(id) {
  const character = getCharacter(id);
  let spec = specCache.get(character.id);
  if (!spec) {
    spec = character.build();
    specCache.set(character.id, spec);
  }
  return spec;
}
