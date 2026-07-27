/**
 * Colour palette and biome themes.
 *
 * Everything visual pulls from here so the whole game stays tonally
 * consistent and a theme swap is one object away.
 */

export const PALETTE = {
  /* Terrain */
  grassLight: '#7fd45a',
  grassMid: '#6cc34a',
  grassDark: '#5cae3d',
  grassEdge: '#4c9a32',
  dirt: '#8a6a44',

  road: '#4a4e57',
  roadAlt: '#535863',
  roadLine: '#e8e2c8',
  roadShoulder: '#3b3f47',
  curb: '#9aa0aa',

  water: '#3a8ee0',
  waterDeep: '#2a6fbb',
  waterFoam: '#cfe9ff',
  lily: '#3f9b57',
  lilyFlower: '#f2a0d0',

  gravel: '#7c7368',
  sleeper: '#5b4636',
  rail: '#b9c0c8',
  railSignal: '#ff3b30',
  railSignalOff: '#5a2320',

  /* Props */
  trunk: '#7a5230',
  trunkDark: '#5f3f24',
  leaf1: '#2f8f43',
  leaf2: '#3aa851',
  leaf3: '#268238',
  rock: '#9096a0',
  rockDark: '#767c86',
  bush: '#3d9a4c',

  /* Vehicles */
  carRed: '#e8453c',
  carBlue: '#3d7de8',
  carYellow: '#f5c542',
  carPurple: '#9b59d0',
  carTeal: '#2fbfa8',
  carOrange: '#f28321',
  carWhite: '#f2f2f2',
  carLime: '#a3d93b',
  glass: '#bfe6ff',
  tyre: '#22252b',
  hubcap: '#b8bec7',
  headlight: '#fff8d0',
  taillight: '#ff4433',

  truckCab: '#e34b4b',
  truckBody: '#dfe3e8',
  busBody: '#f2b32e',

  trainBody: '#c0392b',
  trainDark: '#7d2820',
  trainWindow: '#2a3340',
  trainLight: '#fff2b0',

  log: '#8a5a33',
  logDark: '#6f4526',
  logRing: '#a9784a',

  /* UI / effects */
  coin: '#ffd24a',
  coinDark: '#e0a91f',
  shield: '#59d8ff',
  magnet: '#ff5a5a',
  jetpack: '#ffa23a',
  slowmo: '#b58bff',
  doubler: '#ffe27a',
  shadow: '#000000',
};

/**
 * Biomes cycle as the player progresses, changing sky, fog and grass tint.
 * `from` is the score at which the biome starts.
 */
export const BIOMES = [
  {
    id: 'meadow',
    name: 'Meadow',
    from: 0,
    sky: '#8fd6ff',
    fog: '#bfe8ff',
    grass: ['#7fd45a', '#6cc34a', '#75cc52'],
    water: '#3a8ee0',
    hemiSky: '#cfefff',
    hemiGround: '#6cc34a',
    sunColor: '#fff6e0',
    sunIntensity: 1.5,
    ambient: 0.55,
  },
  {
    id: 'sunset',
    name: 'Sunset Flats',
    from: 90,
    sky: '#ffb26b',
    fog: '#ffd2a1',
    grass: ['#8fbf58', '#7cae4a', '#86b752'],
    water: '#4a86c8',
    hemiSky: '#ffd9b0',
    hemiGround: '#8a6a44',
    sunColor: '#ffcf9a',
    sunIntensity: 1.45,
    ambient: 0.55,
  },
  {
    id: 'dusk',
    name: 'Dusk Valley',
    from: 190,
    sky: '#4a5aa8',
    fog: '#6b73b8',
    grass: ['#4f9a5f', '#448a53', '#4a9159'],
    water: '#2f5fa8',
    hemiSky: '#9aa6e8',
    hemiGround: '#3a4a6a',
    sunColor: '#c9d4ff',
    sunIntensity: 1.1,
    ambient: 0.62,
  },
  {
    id: 'night',
    name: 'Neon Night',
    from: 300,
    sky: '#161a33',
    fog: '#252c52',
    grass: ['#2f7a52', '#28684a', '#2c7150'],
    water: '#1d3f80',
    hemiSky: '#5d6bb0',
    hemiGround: '#1a2340',
    sunColor: '#aab6ff',
    sunIntensity: 0.85,
    ambient: 0.7,
  },
  {
    id: 'frost',
    name: 'Frostline',
    from: 430,
    sky: '#cfe9f7',
    fog: '#e4f2fb',
    grass: ['#dceaf0', '#cfe0e8', '#d6e6ee'],
    water: '#6fb6e8',
    hemiSky: '#eaf7ff',
    hemiGround: '#c3d6df',
    sunColor: '#ffffff',
    sunIntensity: 1.35,
    ambient: 0.65,
  },
];

export function biomeForScore(score) {
  let picked = BIOMES[0];
  for (const b of BIOMES) if (score >= b.from) picked = b;
  return picked;
}

/** Blend factor toward the next biome, for smooth crossfades. */
export function biomeBlend(score) {
  const idx = BIOMES.reduce((acc, b, i) => (score >= b.from ? i : acc), 0);
  const cur = BIOMES[idx];
  const next = BIOMES[idx + 1];
  if (!next) return { from: cur, to: cur, t: 0 };
  const span = Math.max(1, next.from - cur.from);
  const t = Math.min(1, Math.max(0, (score - (next.from - 18)) / 18));
  return { from: cur, to: next, t: span > 0 ? t : 0 };
}

export const VEHICLE_COLORS = [
  PALETTE.carRed,
  PALETTE.carBlue,
  PALETTE.carYellow,
  PALETTE.carPurple,
  PALETTE.carTeal,
  PALETTE.carOrange,
  PALETTE.carWhite,
  PALETTE.carLime,
];
