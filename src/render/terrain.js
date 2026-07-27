/**
 * Terrain kit: the shared geometry + material set every row is built from.
 *
 * Rows are the most numerous object in the scene, so they are deliberately
 * cheap: geometry is created once per row *type* and shared, and biome
 * re-tinting happens by changing a handful of material colours rather than
 * rebuilding anything. A row is at most two draw calls (base + detail).
 *
 * Base geometries bake only *luminance* into their vertex colours; the hue
 * comes from `material.color`, which is what makes a free biome swap possible.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { buildBoxesGeometry, getVoxelMaterial } from './voxel.js';
import { PALETTE } from './palette.js';
import {
  COL_COUNT,
  COL_MIN,
  COL_MAX,
  TILE,
  ROAD_SINK,
  WATER_SINK,
  RAIL_SINK,
} from '../core/constants.js';
import { hash01 } from '../core/math.js';

const WIDTH = COL_COUNT * TILE;

/**
 * Terrain extends well past the playable columns.
 *
 * The camera pans with the player (`focus.x = player.x * 0.42`), so at an
 * outer column on a wide display the frustum reaches beyond the last column
 * and you see the world end in a cliff with sky underneath. Widening the
 * ground is aspect-ratio-proof in a way that clamping the camera is not: it
 * costs two boxes a row and nothing at all in gameplay, since the hedges still
 * mark where play stops.
 */
const APRON = 16 * TILE;
const FULL_WIDTH = WIDTH + 2 * APRON;
/** Centre of each apron slab, left and right of the playable strip. */
const APRON_X = WIDTH / 2 + APRON / 2;

/* ------------------------------------------------------------------ *
 * Geometry builders
 * ------------------------------------------------------------------ */

function grassGeometry(tint) {
  const boxes = [];
  const base = tint === 0 ? 1 : 0.93;
  for (let c = COL_MIN; c <= COL_MAX; c++) {
    // Per-column luminance jitter reads as mown grass without a texture.
    const j = base * (0.94 + hash01(c, tint) * 0.09);
    const v = Math.round(Math.min(1, j) * 255);
    boxes.push({
      pos: [c * TILE, -0.2, 0],
      size: [TILE, 0.4, TILE],
      color: `rgb(${v},${v},${v})`,
    });
  }
  const apron = Math.round((tint === 0 ? 1 : 0.93) * 0.97 * 255);
  for (const side of [-1, 1]) {
    boxes.push({
      pos: [side * APRON_X, -0.2, 0],
      size: [APRON, 0.4, TILE],
      color: `rgb(${apron},${apron},${apron})`,
    });
  }
  return buildBoxesGeometry(boxes);
}

function roadGeometry() {
  const boxes = [
    { pos: [0, -0.22 - ROAD_SINK, 0], size: [FULL_WIDTH, 0.4, TILE], color: '#ffffff' },
  ];
  return buildBoxesGeometry(boxes);
}

/** Dashed lane divider running along the row's -Z (forward) edge. */
function roadDashGeometry(edge) {
  const boxes = [];
  const z = edge === 'front' ? -TILE / 2 : TILE / 2;
  const dashFrom = Math.floor(-FULL_WIDTH / 2);
  const dashTo = Math.ceil(FULL_WIDTH / 2);
  for (let c = dashFrom; c <= dashTo; c += 2) {
    boxes.push({
      pos: [c * TILE, -ROAD_SINK - 0.008, z],
      size: [TILE * 0.62, 0.02, 0.075],
      color: PALETTE.roadLine,
    });
  }
  return buildBoxesGeometry(boxes);
}

function railBaseGeometry() {
  return buildBoxesGeometry([
    { pos: [0, -0.22 - RAIL_SINK, 0], size: [FULL_WIDTH, 0.4, TILE], color: '#ffffff' },
  ]);
}

function railDetailGeometry() {
  const boxes = [];
  const from = Math.floor(-FULL_WIDTH / 2);
  const to = Math.ceil(FULL_WIDTH / 2);
  for (let c = from; c <= to; c++) {
    boxes.push({
      pos: [c * TILE, -RAIL_SINK + 0.03, 0],
      size: [TILE * 0.9, 0.07, 0.62],
      color: PALETTE.sleeper,
    });
  }
  for (const z of [-0.22, 0.22]) {
    boxes.push({
      pos: [0, -RAIL_SINK + 0.085, z],
      size: [FULL_WIDTH, 0.07, 0.1],
      color: PALETTE.rail,
    });
  }
  return buildBoxesGeometry(boxes);
}

function waterGeometry() {
  return buildBoxesGeometry([
    { pos: [0, -WATER_SINK - 0.3, 0], size: [FULL_WIDTH, 0.6, TILE], color: '#ffffff' },
  ]);
}

function waterFoamGeometry() {
  const boxes = [];
  for (const z of [-TILE / 2 + 0.03, TILE / 2 - 0.03]) {
    boxes.push({
      pos: [0, -WATER_SINK + 0.005, z],
      size: [FULL_WIDTH, 0.02, 0.06],
      color: PALETTE.waterFoam,
    });
  }
  return buildBoxesGeometry(boxes);
}

/**
 * The hedge wall that closes off both sides of the playfield.
 * Built as one long strip covering `rows` tiles, repositioned in whole-tile
 * steps so its bumps always line up with the grid.
 */
function boundaryGeometry(rows) {
  const boxes = [];
  const half = rows / 2;
  for (let i = -half; i < half; i++) {
    const z = i * TILE;
    for (const side of [-1, 1]) {
      const x = side * (COL_MAX + 1) * TILE;
      const h = 0.7 + hash01(i, side) * 0.45;
      const lum = 0.72 + hash01(i, side + 7) * 0.2;
      const v = Math.round(lum * 255);
      boxes.push({
        pos: [x, h / 2 - 0.1, z],
        size: [TILE * 1.05, h, TILE],
        color: `rgb(${v},${v},${v})`,
      });
      // A second, offset block breaks the silhouette so it doesn't read as a wall.
      if (hash01(i, side + 31) > 0.55) {
        boxes.push({
          pos: [x + side * 0.42, h * 0.42 - 0.1, z + (hash01(i, side + 3) - 0.5) * 0.4],
          size: [TILE * 0.55, h * 0.72, TILE * 0.7],
          color: `rgb(${Math.round(lum * 0.86 * 255)},${Math.round(lum * 0.86 * 255)},${Math.round(
            lum * 0.86 * 255,
          )})`,
        });
      }
    }
  }
  return buildBoxesGeometry(boxes);
}

/* ------------------------------------------------------------------ *
 * Procedural water ripple texture
 * ------------------------------------------------------------------ */

function makeRippleTexture() {
  if (typeof document === 'undefined') return null;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Layered sine bands give a cheap, tileable caustic shimmer.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * Math.PI * 2;
      const v = (y / size) * Math.PI * 2;
      const n =
        Math.sin(u * 2 + Math.sin(v * 3) * 0.6) * 0.5 +
        Math.sin(v * 4 + Math.cos(u * 2) * 0.4) * 0.3 +
        Math.sin((u + v) * 3) * 0.2;
      const lum = Math.round(226 + n * 26);
      const i = (y * size + x) * 4;
      d[i] = lum;
      d[i + 1] = lum;
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(0.35, 0.35);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ *
 * Kit
 * ------------------------------------------------------------------ */

export class TerrainKit {
  constructor() {
    this.geo = {
      grass: [grassGeometry(0), grassGeometry(1)],
      road: roadGeometry(),
      roadDashFront: roadDashGeometry('front'),
      roadDashBack: roadDashGeometry('back'),
      railBase: railBaseGeometry(),
      railDetail: railDetailGeometry(),
      water: waterGeometry(),
      waterFoam: waterFoamGeometry(),
    };

    this.rippleTexture = makeRippleTexture();

    this.mat = {
      grass: new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.grassMid }),
      road: new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.road }),
      roadAlt: new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.roadAlt }),
      rail: new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.gravel }),
      water: new THREE.MeshLambertMaterial({
        vertexColors: true,
        color: PALETTE.water,
        map: this.rippleTexture || undefined,
        transparent: true,
        opacity: 0.94,
      }),
      hedge: new THREE.MeshLambertMaterial({ vertexColors: true, color: PALETTE.bush }),
      detail: getVoxelMaterial('lambert', 1),
    };

    this._boundaryRows = 96;
    this._boundaryGeo = null;
    this._time = 0;
    /**
     * Row meshes are recycled alongside the rows themselves. Geometry and
     * materials are already shared, so this only saves the Mesh wrappers —
     * but rows are created continuously while playing, and that is exactly
     * the steady-state garbage a fixed-timestep loop does not want.
     * @type {Map<string, THREE.Mesh[]>}
     */
    this._meshPool = new Map();
  }

  /** @private */
  _takeMesh(key, geometry, material) {
    const pool = this._meshPool.get(key);
    const mesh = pool && pool.length ? pool.pop() : new THREE.Mesh(geometry, material);
    mesh.geometry = geometry;
    mesh.material = material;
    mesh.userData.poolKey = key;
    mesh.visible = true;
    return mesh;
  }

  /**
   * Hand a row's meshes back for reuse.
   * @param {THREE.Mesh|null} base
   * @param {THREE.Mesh|null} detail
   */
  releaseRowMeshes(base, detail) {
    for (const mesh of [base, detail]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      const key = mesh.userData.poolKey;
      if (!key) continue;
      let pool = this._meshPool.get(key);
      if (!pool) this._meshPool.set(key, (pool = []));
      if (pool.length < 64) pool.push(mesh);
    }
  }

  /** @param {object} biome entry from palette.js BIOMES */
  applyBiome(biome) {
    this.mat.grass.color.set(biome.grass[0]);
    this.mat.water.color.set(biome.water);
    // Roads and gravel pick up a touch of the sky so night rows do not glow.
    const roadTint = biome.id === 'night' ? '#2f333d' : biome.id === 'frost' ? '#5e646f' : PALETTE.road;
    this.mat.road.color.set(roadTint);
    this.mat.roadAlt.color.set(biome.id === 'night' ? '#363b46' : PALETTE.roadAlt);
    this.mat.rail.color.set(biome.id === 'frost' ? '#a7aeb6' : PALETTE.gravel);
    this.mat.hedge.color.set(biome.grass[2] || biome.grass[0]);
  }

  /** Scroll the water so it always looks alive. */
  update(dt) {
    this._time += dt;
    if (this.rippleTexture) {
      this.rippleTexture.offset.x = (this._time * 0.035) % 1;
      this.rippleTexture.offset.y = (this._time * 0.055) % 1;
    }
  }

  /**
   * Build the mesh set for one row plan.
   * @param {object} plan
   * @param {{dashFront?:boolean, dashBack?:boolean}} neighbours
   * @returns {{base: THREE.Mesh, detail: THREE.Mesh|null}}
   */
  createRowMeshes(plan, neighbours = {}) {
    let base;
    let detail = null;

    switch (plan.type) {
      case 'road': {
        base = this._takeMesh('road', this.geo.road, plan.tint === 0 ? this.mat.road : this.mat.roadAlt);
        if (neighbours.dashFront) {
          detail = this._takeMesh('dashF', this.geo.roadDashFront, this.mat.detail);
        } else if (neighbours.dashBack) {
          detail = this._takeMesh('dashB', this.geo.roadDashBack, this.mat.detail);
        }
        break;
      }
      case 'rail': {
        base = this._takeMesh('rail', this.geo.railBase, this.mat.rail);
        detail = this._takeMesh('railD', this.geo.railDetail, this.mat.detail);
        break;
      }
      case 'water': {
        base = this._takeMesh('water', this.geo.water, this.mat.water);
        detail = this._takeMesh('foam', this.geo.waterFoam, this.mat.detail);
        break;
      }
      case 'grass':
      default: {
        base = this._takeMesh(`grass${plan.tint & 1}`, this.geo.grass[plan.tint & 1], this.mat.grass);
        break;
      }
    }

    base.receiveShadow = true;
    base.castShadow = false;
    base.matrixAutoUpdate = false;
    if (detail) {
      detail.receiveShadow = false;
      detail.castShadow = false;
      detail.matrixAutoUpdate = false;
    }
    return { base, detail };
  }

  /** The two side hedges. Reposition with `updateBoundary(row)`. */
  createBoundary() {
    if (!this._boundaryGeo) this._boundaryGeo = boundaryGeometry(this._boundaryRows);
    const mesh = new THREE.Mesh(this._boundaryGeo, this.mat.hedge);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Snap the hedge strip to whole tiles so its repeating bumps never shimmer.
   * @param {THREE.Mesh} mesh
   * @param {number} row centre row to cover
   */
  updateBoundary(mesh, row) {
    const z = -Math.round(row) * TILE;
    if (mesh.position.z !== z) {
      mesh.position.z = z;
      mesh.updateMatrix();
    }
  }

  dispose() {
    this._meshPool.clear();
    for (const g of Object.values(this.geo)) {
      if (Array.isArray(g)) g.forEach((x) => x.dispose());
      else g.dispose();
    }
    if (this._boundaryGeo) this._boundaryGeo.dispose();
    if (this.rippleTexture) this.rippleTexture.dispose();
    for (const m of Object.values(this.mat)) m.dispose?.();
  }
}
