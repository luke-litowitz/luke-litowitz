/**
 * Row runtime: turns row *plans* from worldgen.js into live scene content and
 * owns everything that lives on a row — traffic, platforms, trains, coins,
 * obstacles and pickups.
 *
 * Positions of moving hazards are analytic functions of the row's age, laid
 * out on a wrapping cycle. That means:
 *   - no spawn/despawn bookkeeping and zero allocation while playing,
 *   - perfectly seamless recycling,
 *   - and a hazard's previous position is always exactly recoverable, which
 *     is what the swept collision needs.
 */

import * as THREE from '../../vendor/three/three.module.js';
import {
  TILE,
  COL_MAX,
  ROWS_AHEAD,
  ROWS_BEHIND,
  PLAYER_HALF_W,
  PLAYER_HALF_D,
  LOG_TOP_Y,
  LILYPAD_TOP_Y,
  COIN_PICKUP_RADIUS,
  PLATFORM_GRIP_MARGIN,
} from '../core/constants.js';
import { rowToZ, colToX, makeAABB, sweptAABB, clamp, hash01 } from '../core/math.js';
import { cyclePosition, CYCLE_START_X, WorldGenerator } from './worldgen.js';
import { vehicleById } from './vehicles.js';

const COIN_Y = 0.42;
const CRATE_Y = 0.34;
const TRAIN_CAR_LENGTH = 4.6;

/** Scratch AABBs — reused so collision never allocates. */
const _boxA = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
const _boxB = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

function setBox(box, cx, cz, hw, hd) {
  box.minX = cx - hw;
  box.maxX = cx + hw;
  box.minZ = cz - hd;
  box.maxZ = cz + hd;
  return box;
}

/* ================================================================== *
 * Row
 * ================================================================== */

export class Row {
  /** @param {World} world */
  constructor(world) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;

    this.plan = null;
    this.index = 0;
    this.type = 'grass';
    this.time = 0;

    /** @type {Array} moving hazards / platforms */
    this.items = [];
    /** @type {Array} coins on this row */
    this.coins = [];
    /** @type {object|null} */
    this.crate = null;
    /** @type {Set<number>} blocked columns (grass only) */
    this.blocked = new Set();
    /** @type {THREE.Object3D[]} static decorations to release */
    this._statics = [];

    this.base = null;
    this.detail = null;

    /* Rail-specific */
    this.signals = [];
    this.warningOn = false;
    this.warningPrev = false;
    this.hornPlayed = false;
  }

  /* ---------------------------------------------------------------- */

  init(plan, neighbours) {
    this.plan = plan;
    this.index = plan.index;
    this.type = plan.type;
    this.time = 0;
    this.warningOn = false;
    this.warningPrev = false;
    this.hornPlayed = false;

    this.group.position.set(0, 0, rowToZ(plan.index));
    this.group.updateMatrix();

    const { terrain, props } = this.world;
    const meshes = terrain.createRowMeshes(plan, neighbours);
    this.base = meshes.base;
    this.detail = meshes.detail;
    this.base.updateMatrix();
    this.group.add(this.base);
    if (this.detail) {
      this.detail.updateMatrix();
      this.group.add(this.detail);
    }

    switch (plan.type) {
      case 'grass':
        this._initGrass(plan, props);
        break;
      case 'road':
        this._initRoad(plan, props);
        break;
      case 'water':
        this._initWater(plan, props);
        break;
      case 'rail':
        this._initRail(plan, props);
        break;
    }

    this._initPickups(plan, props);
    return this;
  }

  _initGrass(plan, props) {
    for (const ob of plan.obstacles) {
      const mesh = props.obstacle(ob.kind, ob.variant, ob.seed);
      mesh.position.set(colToX(ob.col), 0, (hash01(ob.seed, 1) - 0.5) * 0.18);
      mesh.rotation.y = ob.rot;
      mesh.updateMatrix();
      this.group.add(mesh);
      this._statics.push(mesh);
      this.blocked.add(ob.col);
    }
  }

  _initRoad(plan, props) {
    for (const it of plan.cycle.items) {
      const type = vehicleById(it.typeId);
      const mesh = props.vehicle(it.typeId, it.colorIndex);
      // Model space faces +X; mirror for lanes travelling the other way.
      mesh.rotation.y = plan.dir > 0 ? 0 : Math.PI;
      this.group.add(mesh);
      this.items.push({
        kind: 'vehicle',
        offset: it.offset + it.length / 2,
        length: it.length,
        halfLen: type.halfLength,
        halfWid: type.halfWidth,
        honks: it.honks,
        honkCooldown: hash01(plan.index, it.offset) * 6,
        mesh,
        x: 0,
        prevX: 0,
      });
    }
  }

  _initWater(plan, props) {
    for (const it of plan.cycle.items) {
      const isLily = it.kind === 'lily';
      const mesh = isLily ? props.lilypad(it.withFlower) : props.log(it.tiles);
      this.group.add(mesh);
      this.items.push({
        kind: isLily ? 'lily' : 'log',
        offset: it.offset + it.length / 2,
        length: it.length,
        halfLen: it.length / 2,
        halfWid: 0.45,
        surfaceY: isLily ? LILYPAD_TOP_Y : LOG_TOP_Y,
        bobPhase: hash01(plan.index, Math.round(it.offset * 10)) * Math.PI * 2,
        mesh,
        x: 0,
        prevX: 0,
      });
    }
  }

  _initRail(plan, props) {
    for (const it of plan.cycle.items) {
      const cars = [];
      for (let i = 0; i < it.cars; i++) {
        const mesh = props.trainCar(i === 0 ? 'engine' : 'car');
        mesh.rotation.y = plan.dir > 0 ? 0 : Math.PI;
        this.group.add(mesh);
        cars.push(mesh);
      }
      this.items.push({
        kind: 'train',
        offset: it.offset + it.length / 2,
        length: it.length,
        halfLen: it.length / 2,
        halfWid: 0.62,
        cars,
        mesh: null,
        x: 0,
        prevX: 0,
      });
    }

    for (const side of [-1, 1]) {
      const post = props.signal();
      post.position.set(side * (COL_MAX + 0.15) * TILE, 0, 0.18);
      post.rotation.y = side > 0 ? Math.PI : 0;
      post.updateMatrix();
      this.group.add(post);
      this.signals.push(post);
      this._statics.push(post);
    }
  }

  _initPickups(plan, props) {
    const { props: factory } = this.world;
    for (const col of plan.coins || []) {
      const mesh = factory.coin();
      const x = colToX(col);
      mesh.position.set(x, COIN_Y, 0);
      this.group.add(mesh);
      this.coins.push({ x, y: COIN_Y, homeX: x, mesh, taken: false, spin: hash01(plan.index, col) * 6 });
    }
    if (plan.powerup) {
      const mesh = factory.powerupCrate(plan.powerup.id);
      const x = colToX(plan.powerup.col);
      mesh.position.set(x, CRATE_Y, 0);
      this.group.add(mesh);
      this.crate = { id: plan.powerup.id, x, y: CRATE_Y, mesh, taken: false };
    }
    void props;
  }

  /* ---------------------------------------------------------------- *
   * Simulation
   * ---------------------------------------------------------------- */

  fixedUpdate(dt) {
    const plan = this.plan;
    if (!plan) return;
    this.time += dt;

    if (this.items.length === 0) return;
    const { span } = plan.cycle;
    const dir = plan.dir;
    const speed = plan.speed;
    const t = this.time;

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      it.prevX = it.x;
      it.x = cyclePosition(it.offset, span, dir, speed, t, CYCLE_START_X);
      // A wrap makes prevX meaningless for sweeping; treat it as continuous.
      if (Math.abs(it.x - it.prevX) > span * 0.5) it.prevX = it.x;
    }

    if (this.type === 'rail') this._updateWarning(dt);
  }

  _updateWarning(dt) {
    const train = this.items[0];
    if (!train) return;
    const plan = this.plan;
    const lead = train.x + plan.dir * train.halfLen;
    const tail = train.x - plan.dir * train.halfLen;
    const edge = (COL_MAX + 1.2) * TILE;

    const approaching =
      plan.dir > 0 ? lead < -edge && -edge - lead < plan.warnTime * plan.speed
                   : lead > edge && lead - edge < plan.warnTime * plan.speed;
    const onScreen = Math.abs(train.x) < edge + train.halfLen;
    const leaving = plan.dir > 0 ? tail > edge : tail < -edge;

    this.warningPrev = this.warningOn;
    this.warningOn = approaching || (onScreen && !leaving);
    if (!this.warningOn) this.hornPlayed = false;
    void dt;
  }

  /* ---------------------------------------------------------------- *
   * Queries
   * ---------------------------------------------------------------- */

  /** @returns {boolean} true when a static obstacle occupies `col`. */
  isBlocked(col) {
    return this.blocked.has(col);
  }

  /**
   * Find the platform supporting world-X `x`, if any.
   * @param {number} x
   * @param {number} grip extra forgiveness at the platform ends
   * @returns {object|null}
   */
  platformAt(x, grip = PLATFORM_GRIP_MARGIN) {
    if (this.type !== 'water') return null;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (x >= it.x - it.halfLen - grip && x <= it.x + it.halfLen + grip) return it;
    }
    return null;
  }

  /** Signed velocity of the row's moving items. */
  get velocity() {
    return this.plan ? this.plan.dir * this.plan.speed : 0;
  }

  /**
   * Swept collision against every hazard on this row.
   *
   * @param {number} px previous player X
   * @param {number} pz previous player Z
   * @param {number} dx player displacement this step
   * @param {number} dz player displacement this step
   * @param {number} hw player half width
   * @param {number} hd player half depth
   * @returns {{cause:string, item:object}|null}
   */
  hitTest(px, pz, dx, dz, hw, hd) {
    if (this.type !== 'road' && this.type !== 'rail') return null;
    const rowZ = rowToZ(this.index);
    setBox(_boxA, px, pz, hw, hd);

    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const vdx = it.x - it.prevX;
      setBox(_boxB, it.prevX, rowZ, it.halfLen, it.halfWid);
      const hit = sweptAABB(_boxA, dx - vdx, dz, _boxB);
      if (hit) return { cause: this.type === 'rail' ? 'train' : 'car', item: it };
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Presentation
   * ---------------------------------------------------------------- */

  render(alpha, elapsed) {
    const plan = this.plan;
    if (!plan) return;

    // Interpolate hazard positions between the last two simulation states.
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const x = it.prevX + (it.x - it.prevX) * alpha;
      if (it.kind === 'train') {
        const dir = plan.dir;
        for (let c = 0; c < it.cars.length; c++) {
          const mesh = it.cars[c];
          const off = it.halfLen - TRAIN_CAR_LENGTH * (c + 0.5);
          mesh.position.x = x + dir * off;
          mesh.updateMatrix();
        }
        continue;
      }
      const mesh = it.mesh;
      mesh.position.x = x;
      if (it.kind === 'log' || it.kind === 'lily') {
        mesh.position.y = Math.sin(elapsed * 1.7 + it.bobPhase) * 0.022;
        mesh.rotation.z = Math.sin(elapsed * 1.1 + it.bobPhase) * 0.012;
      }
      mesh.updateMatrix();
    }

    for (let i = 0; i < this.coins.length; i++) {
      const coin = this.coins[i];
      if (coin.taken) continue;
      coin.mesh.position.x = coin.x;
      coin.mesh.position.y = coin.y + Math.sin(elapsed * 3 + coin.spin) * 0.06;
      coin.mesh.rotation.y = elapsed * 2.6 + coin.spin;
      coin.mesh.updateMatrix();
    }

    if (this.crate && !this.crate.taken) {
      const m = this.crate.mesh;
      m.position.y = this.crate.y + Math.sin(elapsed * 2.2) * 0.07;
      m.rotation.y = elapsed * 1.1;
      if (m.parts?.core) {
        m.parts.core.rotation.y = -elapsed * 2.4;
        const s = 1 + Math.sin(elapsed * 5) * 0.08;
        m.parts.core.scale.setScalar(s);
      }
      m.updateMatrix();
    }

    if (this.type === 'rail' && this.signals.length) {
      const on = this.warningOn && Math.sin(elapsed * 14) > 0;
      for (const post of this.signals) {
        const lamp = post.parts?.lamp;
        if (lamp) lamp.visible = on;
      }
    }
  }

  /* ---------------------------------------------------------------- */

  release() {
    const props = this.world.props;
    for (const it of this.items) {
      if (it.cars) for (const c of it.cars) props.release(c);
      else props.release(it.mesh);
    }
    this.items.length = 0;

    for (const c of this.coins) props.release(c.mesh);
    this.coins.length = 0;

    if (this.crate) {
      props.release(this.crate.mesh);
      this.crate = null;
    }

    for (const s of this._statics) props.release(s);
    this._statics.length = 0;

    if (this.base) this.group.remove(this.base);
    if (this.detail) this.group.remove(this.detail);
    this.base = null;
    this.detail = null;

    this.signals.length = 0;
    this.blocked.clear();
    this.group.removeFromParent();
    this.plan = null;
    return this;
  }
}

/* ================================================================== *
 * World
 * ================================================================== */

export class World {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {import('../render/terrain.js').TerrainKit} deps.terrain
   * @param {import('../render/props.js').PropFactory} deps.props
   */
  constructor({ scene, terrain, props }) {
    this.scene = scene;
    this.terrain = terrain;
    this.props = props;

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.generator = new WorldGenerator(1);
    /** @type {Map<number, Row>} */
    this.rows = new Map();
    /** @type {Row[]} */
    this._pool = [];

    this.boundary = terrain.createBoundary();
    this.root.add(this.boundary);

    this.minRow = 0;
    this.maxRow = -1;
    this.elapsed = 0;
    this._lastPlan = null;
  }

  reset(seed) {
    for (const row of this.rows.values()) this._recycle(row);
    this.rows.clear();
    this.generator.reset(seed, -ROWS_BEHIND);
    this.minRow = -ROWS_BEHIND;
    this.maxRow = -ROWS_BEHIND - 1;
    this.elapsed = 0;
    this._lastPlan = null;
    this.ensure(0, 0);
  }

  /** @returns {Row|null} */
  rowAt(index) {
    return this.rows.get(index) || null;
  }

  rowType(index) {
    const r = this.rows.get(index);
    return r ? r.type : null;
  }

  isBlocked(index, col) {
    const r = this.rows.get(index);
    return r ? r.isBlocked(col) : false;
  }

  platformAt(index, x, grip) {
    const r = this.rows.get(index);
    return r ? r.platformAt(x, grip) : null;
  }

  /* ---------------------------------------------------------------- */

  /** Generate ahead of and recycle behind the player. */
  ensure(playerRow, score) {
    const wantMax = Math.ceil(playerRow) + ROWS_AHEAD;
    while (this.maxRow < wantMax) {
      const plan = this.generator.next(score);
      const neighbours = {
        dashBack: plan.type === 'road' && this._lastPlan?.type === 'road',
        dashFront: false,
      };
      const row = this._acquire().init(plan, neighbours);
      this.root.add(row.group);
      this.rows.set(plan.index, row);
      this.maxRow = plan.index;
      this._lastPlan = plan;
    }

    const wantMin = Math.floor(playerRow) - ROWS_BEHIND;
    while (this.minRow < wantMin) {
      const row = this.rows.get(this.minRow);
      if (row) {
        this.rows.delete(this.minRow);
        this._recycle(row);
      }
      this.minRow++;
    }

    this.terrain.updateBoundary(this.boundary, playerRow);
  }

  _acquire() {
    return this._pool.pop() || new Row(this);
  }

  _recycle(row) {
    row.release();
    if (this._pool.length < 64) this._pool.push(row);
  }

  /* ---------------------------------------------------------------- */

  fixedUpdate(dt) {
    this.elapsed += dt;
    for (const row of this.rows.values()) row.fixedUpdate(dt);
  }

  render(alpha, elapsed) {
    for (const row of this.rows.values()) row.render(alpha, elapsed);
  }

  /**
   * Swept collision of the player against every hazard row their box touches.
   *
   * @param {object} p player-like: {prevX, prevZ, x, z, halfW, halfD}
   * @returns {{cause:string, item:object, row:Row}|null}
   */
  hitTestPlayer(p) {
    const dx = p.x - p.prevX;
    const dz = p.z - p.prevZ;
    const zMin = Math.min(p.prevZ, p.z) - p.halfD;
    const zMax = Math.max(p.prevZ, p.z) + p.halfD;
    // row = -z, so the z-range maps to a reversed row range.
    const rLo = Math.floor(-zMax);
    const rHi = Math.ceil(-zMin);

    for (let r = rLo; r <= rHi; r++) {
      const row = this.rows.get(r);
      if (!row) continue;
      const hit = row.hitTest(p.prevX, p.prevZ, dx, dz, p.halfW, p.halfD);
      if (hit) return { ...hit, row };
    }
    return null;
  }

  /**
   * Coin/power-up collection with magnet support.
   *
   * @param {number} px player X
   * @param {number} prow player row (fractional while hopping)
   * @param {number} magnetRadius 0 disables attraction
   * @param {number} dt
   * @param {(type:'coin'|'powerup', payload:any)=>void} onPickup
   */
  collect(px, prow, magnetRadius, dt, onPickup) {
    const pz = -prow * TILE;
    const lo = Math.floor(prow - Math.max(1.5, magnetRadius));
    const hi = Math.ceil(prow + Math.max(1.5, magnetRadius));

    for (let r = lo; r <= hi; r++) {
      const row = this.rows.get(r);
      if (!row) continue;
      const rowZ = rowToZ(r);

      for (let i = 0; i < row.coins.length; i++) {
        const coin = row.coins[i];
        if (coin.taken) continue;
        const dx = px - coin.x;
        const dz = pz - rowZ;
        const dist = Math.hypot(dx, dz);

        if (magnetRadius > 0 && dist < magnetRadius) {
          // Ease the coin toward the player; speed rises as it closes in.
          const pull = clamp(1 - dist / magnetRadius, 0, 1);
          coin.x += dx * Math.min(1, pull * 9 * dt);
          coin.y += (0.55 - coin.y) * Math.min(1, 6 * dt);
        }

        if (dist < COIN_PICKUP_RADIUS + (magnetRadius > 0 ? 0.2 : 0)) {
          coin.taken = true;
          coin.mesh.visible = false;
          onPickup('coin', { x: coin.x, y: coin.y, z: rowZ });
        }
      }

      if (row.crate && !row.crate.taken) {
        const dx = px - row.crate.x;
        const dz = pz - rowZ;
        if (Math.hypot(dx, dz) < 0.66) {
          row.crate.taken = true;
          row.crate.mesh.visible = false;
          onPickup('powerup', { id: row.crate.id, x: row.crate.x, y: row.crate.y, z: rowZ });
        }
      }
    }
  }

  /** Rows whose train warning just switched on, for the audio layer. */
  *newWarnings() {
    for (const row of this.rows.values()) {
      if (row.type === 'rail' && row.warningOn && !row.hornPlayed) {
        row.hornPlayed = true;
        yield row;
      }
    }
  }

  dispose() {
    for (const row of this.rows.values()) row.release();
    this.rows.clear();
    this._pool.length = 0;
    this.root.removeFromParent();
  }
}

export { PLAYER_HALF_W, PLAYER_HALF_D, makeAABB };
