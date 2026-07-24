/**
 * Prop factory + object pool.
 *
 * Every prop is built once per unique key and then cloned. Three.js clones
 * share geometry and material, so a hundred cars cost one geometry upload.
 * Released props go back to a per-key pool, which keeps gameplay allocation
 * free — no GC pauses mid-hop.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { buildVoxelModel } from './voxel.js';
import { VEHICLE_COLORS } from './palette.js';
import {
  carSpec,
  truckSpec,
  busSpec,
  trainCarSpec,
  logSpec,
  lilypadSpec,
  treeSpec,
  rockSpec,
  bushSpec,
  coinSpec,
  signalSpec,
  eagleSpec,
} from './models.js';
import { getPowerup, POWERUPS } from '../data/powerups.js';
import { vehicleById } from '../game/vehicles.js';
import { SeededRNG } from '../core/math.js';

/** Rebuild the `parts` lookup on a cloned model so animation still works. */
export function relinkParts(root) {
  const parts = Object.create(null);
  for (const child of root.children) parts[child.name] = child;
  root.parts = parts;
  return root;
}

/** Deep-clone a voxel model and restore its part map. */
export function cloneModel(template) {
  return relinkParts(template.clone(true));
}

/** Seeded rng bucket: keeps the template cache small while staying varied. */
const VARIANT_BUCKETS = 6;

export class PropFactory {
  constructor() {
    /** @type {Map<string, THREE.Group>} */
    this._templates = new Map();
    /** @type {Map<string, THREE.Group[]>} */
    this._pools = new Map();
    this._specRng = new SeededRNG(1);
  }

  /** @private */
  _template(key, makeSpec, opts) {
    let t = this._templates.get(key);
    if (!t) {
      t = buildVoxelModel(makeSpec(), opts);
      t.matrixAutoUpdate = false;
      this._templates.set(key, t);
    }
    return t;
  }

  /**
   * Take a prop from the pool (or clone a fresh one).
   * @returns {THREE.Group} with `.userData.poolKey` set for release()
   */
  acquire(key, makeSpec, opts) {
    const pool = this._pools.get(key);
    if (pool && pool.length) {
      const obj = pool.pop();
      obj.visible = true;
      return obj;
    }
    const obj = cloneModel(this._template(key, makeSpec, opts));
    obj.userData.poolKey = key;
    return obj;
  }

  /** Return a prop to its pool. Safe to call with anything. */
  release(obj) {
    if (!obj) return;
    const key = obj.userData?.poolKey;
    if (!key) return;
    obj.visible = false;
    obj.removeFromParent();
    obj.position.set(0, 0, 0);
    obj.scale.set(1, 1, 1);
    obj.rotation.set(0, 0, 0);
    obj.updateMatrix();
    let pool = this._pools.get(key);
    if (!pool) this._pools.set(key, (pool = []));
    // A hard cap stops a long session from hoarding memory.
    if (pool.length < 48) pool.push(obj);
  }

  /* ---------------------------------------------------------------- *
   * Concrete props
   * ---------------------------------------------------------------- */

  vehicle(typeId, colorIndex) {
    const type = vehicleById(typeId);
    const color = VEHICLE_COLORS[colorIndex % VEHICLE_COLORS.length];
    const key = `veh:${type.id}:${colorIndex % VEHICLE_COLORS.length}`;
    return this.acquire(key, () => {
      if (type.spec) return type.spec(color);
      if (type.kind === 'truck') return truckSpec(color);
      if (type.kind === 'bus') return busSpec(color);
      return carSpec(color, 0);
    });
  }

  trainCar(kind) {
    return this.acquire(`train:${kind}`, () => trainCarSpec(kind));
  }

  log(tiles) {
    const n = Math.max(1, Math.min(4, Math.round(tiles)));
    return this.acquire(`log:${n}`, () => logSpec(n));
  }

  lilypad(withFlower) {
    return this.acquire(`lily:${withFlower ? 1 : 0}`, () => lilypadSpec(!!withFlower), {
      castShadow: false,
    });
  }

  tree(variant, seed) {
    const b = seed % VARIANT_BUCKETS;
    return this.acquire(`tree:${variant}:${b}`, () =>
      treeSpec(variant, this._specRng.reset(1000 + variant * 31 + b)),
    );
  }

  rock(seed) {
    const b = seed % VARIANT_BUCKETS;
    return this.acquire(`rock:${b}`, () => rockSpec(this._specRng.reset(2000 + b)));
  }

  bush(seed) {
    const b = seed % VARIANT_BUCKETS;
    return this.acquire(`bush:${b}`, () => bushSpec(this._specRng.reset(3000 + b)), {
      castShadow: false,
    });
  }

  obstacle(kind, variant, seed) {
    switch (kind) {
      case 'rock':
        return this.rock(seed);
      case 'bush':
        return this.bush(seed);
      case 'tree':
      default:
        return this.tree(variant, seed);
    }
  }

  coin() {
    return this.acquire('coin', () => coinSpec(), { castShadow: false });
  }

  powerupCrate(id) {
    const def = getPowerup(id) || POWERUPS[0];
    return this.acquire(`pu:${def.id}`, () => def.build(), { castShadow: false });
  }

  signal() {
    return this.acquire('signal', () => signalSpec());
  }

  eagle() {
    return this.acquire('eagle', () => eagleSpec());
  }

  dispose() {
    for (const t of this._templates.values()) {
      t.traverse((o) => o.geometry?.dispose());
    }
    this._templates.clear();
    this._pools.clear();
  }
}
