/**
 * World generation.
 *
 * Produces an endless sequence of *row plans* — plain data describing what a
 * row contains. Rows themselves (meshes, entities, pooling) live in rows.js.
 *
 * Two guarantees this module is responsible for:
 *
 *  1. **Lateral reachability.** Obstacles on grass rows are validated with an
 *     incremental flood fill, so the player can never be sealed into a pocket.
 *  2. **Temporal solvability.** Traffic, logs and trains are laid out on a
 *     wrapping cycle whose gaps are derived from speed (see config.js), so a
 *     survivable window always exists.
 */

import { SeededRNG, clamp, lerp } from '../core/math.js';
import {
  PLAY_COL_MIN,
  PLAY_COL_MAX,
  COL_MAX,
  SAFE_ROWS,
  TILE,
  TRAIN_CAR_LENGTH,
} from '../core/constants.js';
import {
  difficultyAt,
  minSafeGap,
  TRAFFIC_SPAN,
  LOG_GAP,
  MIN_WATER_VELOCITY_DELTA,
  MAX_VEHICLE_SPEED,
  MAX_TRAIN_SPEED,
  UNLOCK_SCORE,
} from './config.js';
import { pickVehicle } from './vehicles.js';
import { rollPowerup, powerupSpawnChance } from '../data/powerups.js';

const ALL_COLS = [];
for (let c = PLAY_COL_MIN; c <= PLAY_COL_MAX; c++) ALL_COLS.push(c);

/* ------------------------------------------------------------------ *
 * Cycle builder
 * ------------------------------------------------------------------ */

/**
 * Lay out items around a wrapping cycle of length `span`.
 *
 * Returns `[{ offset, length, ...meta }]` where `offset` is the leading edge
 * position within the cycle. Because the cycle length equals the full travel
 * span, an item that leaves one side re-enters on the other with no seam and
 * no allocation at runtime.
 *
 * @param {SeededRNG} rng
 * @param {object} opts
 * @param {number} opts.span
 * @param {number} opts.minGap      hard minimum clear distance between items
 * @param {number} [opts.maxGap]    soft maximum; more items are added to respect it
 * @param {number} [opts.coverage]  minimum fraction of the span covered by items
 * @param {(maxLength:number)=>({length:number}|null)} opts.makeItem
 *   Receives the space actually left in the cycle. Honouring it lets a
 *   generator emit a shorter item instead of stalling the pack, which is what
 *   keeps the coverage floor reachable on an unlucky draw.
 */
export function buildCycle(rng, { span, minGap, maxGap = Infinity, coverage = 0, makeItem }) {
  const items = [];
  let used = 0; // sum of item lengths

  /** Space a new item could occupy, once its own gap is reserved. */
  const roomForNext = () => span - used - (items.length + 1) * minGap;

  // Seed with as many items as comfortably fit at a relaxed spacing.
  const probe = makeItem(span);
  const nominal = probe.length + minGap + Math.min(maxGap, minGap * 1.5) * 0.5;
  const target = Math.max(1, Math.floor(span / Math.max(0.5, nominal)));

  for (let i = 0; i < target; i++) {
    const room = roomForNext();
    if (room <= 0) break;
    const item = makeItem(room);
    if (!item || item.length > room) break;
    items.push(item);
    used += item.length;
  }
  if (items.length === 0) {
    // Span is tiny relative to the item — fall back to a single clamped item.
    const item = makeItem(span * 0.5) || { length: span * 0.5 };
    item.length = Math.min(item.length, span * 0.5);
    items.push(item);
    used = item.length;
  }

  // Grow until the coverage and maxGap constraints are satisfied.
  // Bounded by the span itself: every iteration either adds length or stops.
  let guard = 0;
  while (guard++ < 256) {
    const gaps = items.length;
    const slack = span - used - gaps * minGap;
    const avgGap = minGap + (gaps > 0 ? slack / gaps : 0);
    const needMoreForCoverage = used / span < coverage;
    const needMoreForMaxGap = avgGap > maxGap;
    if (!needMoreForCoverage && !needMoreForMaxGap) break;

    const room = roomForNext();
    if (room <= 0) break;
    const item = makeItem(room);
    if (!item || item.length > room) break;
    items.push(item);
    used += item.length;
  }

  // Distribute the leftover space across the gaps with random weights so the
  // pattern reads as organic while every gap stays >= minGap.
  const n = items.length;
  let slack = Math.max(0, span - used - n * minGap);
  const weights = new Array(n);
  let wsum = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = 0.25 + rng.next();
    wsum += weights[i];
  }

  const gaps = new Array(n);
  for (let i = 0; i < n; i++) {
    gaps[i] = minGap + (slack * weights[i]) / wsum;
  }

  // Clamp oversized gaps and hand the excess back to the tighter ones.
  if (Number.isFinite(maxGap)) {
    let excess = 0;
    for (let i = 0; i < n; i++) {
      if (gaps[i] > maxGap) {
        excess += gaps[i] - maxGap;
        gaps[i] = maxGap;
      }
    }
    if (excess > 0) {
      const room = [];
      let roomTotal = 0;
      for (let i = 0; i < n; i++) {
        const r = maxGap - gaps[i];
        room.push(r);
        roomTotal += r;
      }
      if (roomTotal > 1e-6) {
        for (let i = 0; i < n; i++) gaps[i] += (excess * room[i]) / roomTotal;
      } else {
        // Nowhere to put it: stretch every gap evenly (span invariant wins).
        for (let i = 0; i < n; i++) gaps[i] += excess / n;
      }
    }
  }

  // Normalise so the offsets exactly tile `span` — this is what makes the
  // modular wrap seamless.
  let total = 0;
  for (let i = 0; i < n; i++) total += items[i].length + gaps[i];
  const correction = span - total;
  if (Math.abs(correction) > 1e-9) {
    for (let i = 0; i < n; i++) gaps[i] += correction / n;
  }

  let cursor = rng.range(0, span); // random phase so lanes are not aligned
  for (let i = 0; i < n; i++) {
    items[i].offset = cursor % span;
    cursor += items[i].length + gaps[i];
  }

  return { span, items, coverage: used / span };
}

/* ------------------------------------------------------------------ *
 * Generator
 * ------------------------------------------------------------------ */

export class WorldGenerator {
  /** @param {number} seed */
  constructor(seed = 1) {
    this.rng = new SeededRNG(seed);
    this.reset(seed);
  }

  reset(seed = this.rng.seed, startIndex = 0) {
    this.rng.reset(seed);
    this.index = startIndex;
    this.runType = 'grass';
    this.runLeft = 0;
    this.lastType = 'grass';
    this.sinceWater = 99;
    this.sinceRail = 99;
    /** Columns the player can stand on in the most recently generated row. */
    this.reachable = new Set(ALL_COLS);
    /** Signed velocity of the previous water row, for the drift guarantee. */
    this.lastWaterVelocity = null;
    this.rowsSinceCoin = 0;
    this.rowsSincePowerup = 0;
  }

  /**
   * Generate the plan for the next row.
   * @param {number} score current score, drives difficulty
   * @returns {object} row plan
   */
  next(score) {
    const index = this.index++;
    const diff = difficultyAt(Math.max(score, index));

    // Opening stretch is always safe ground so the player can orient.
    if (index < SAFE_ROWS) {
      return this._grass(index, diff, { forceEmpty: index >= 0, sparse: true });
    }

    if (this.runLeft <= 0) this._chooseRun(index, diff);
    this.runLeft--;

    switch (this.runType) {
      case 'road':
        return this._road(index, diff);
      case 'water':
        return this._water(index, diff);
      case 'rail':
        return this._rail(index, diff);
      case 'grass':
      default:
        return this._grass(index, diff, {});
    }
  }

  /* -------------------------------------------------------------- *
   * Run selection
   * -------------------------------------------------------------- */

  _chooseRun(index, diff) {
    const rng = this.rng;
    const w = diff.weights;

    // Grass always separates hazard runs, so we alternate: hazard, grass, ...
    if (this.lastType !== 'grass') {
      this.runType = 'grass';
      this.runLeft = rng.int(diff.grassRun[0], diff.grassRun[1]);
      this.lastType = 'grass';
      return;
    }

    const options = [
      { id: 'road', weight: w.road },
      {
        id: 'water',
        weight: index >= UNLOCK_SCORE.water ? w.water * (this.sinceWater < 3 ? 0.25 : 1) : 0,
      },
      {
        id: 'rail',
        weight: index >= UNLOCK_SCORE.rail ? w.rail * (this.sinceRail < 5 ? 0.2 : 1) : 0,
      },
      { id: 'grass', weight: w.grass * 0.5 },
    ];

    const pick = rng.weighted(options);
    this.runType = pick.id;

    switch (pick.id) {
      case 'road':
        this.runLeft = rng.int(1, diff.maxRoadRun);
        break;
      case 'water':
        this.runLeft = rng.int(1, diff.maxWaterRun);
        this.sinceWater = 0;
        break;
      case 'rail':
        this.runLeft = rng.int(1, diff.maxRailRun);
        this.sinceRail = 0;
        break;
      default:
        this.runLeft = rng.int(1, 2);
    }

    this.lastType = pick.id;
    this.sinceWater++;
    this.sinceRail++;
    if (pick.id !== 'water') this.lastWaterVelocity = null;
  }

  /* -------------------------------------------------------------- *
   * Grass
   * -------------------------------------------------------------- */

  _grass(index, diff, { forceEmpty = false, sparse = false } = {}) {
    const rng = this.rng;
    const tint = index % 2 === 0 ? 0 : 1;

    let obstacles = [];
    if (!forceEmpty) {
      const density = sparse ? diff.obstacleDensity * 0.4 : diff.obstacleDensity;
      obstacles = this._placeObstacles(density, rng);
    }

    const blocked = new Set(obstacles.map((o) => o.col));
    const free = ALL_COLS.filter((c) => !blocked.has(c));
    this.reachable = this._floodReachable(free);

    const openCols = free.filter((c) => this.reachable.has(c));
    return {
      type: 'grass',
      index,
      tint,
      obstacles,
      coins: this._rollCoins(diff, openCols, rng),
      powerup: this._rollPowerup(index, diff, openCols, rng),
    };
  }

  /**
   * Try a few obstacle layouts, keeping the first one that leaves the row
   * reachable from the previous row. Falls back to an empty row — a boring
   * row is always better than an impossible one.
   */
  _placeObstacles(density, rng) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const obstacles = [];
      const blocked = new Set();
      for (const col of ALL_COLS) {
        if (!rng.chance(density)) continue;
        obstacles.push({
          col,
          kind: rng.weighted([
            { id: 'tree', weight: 0.62 },
            { id: 'rock', weight: 0.2 },
            { id: 'bush', weight: 0.18 },
          ]).id,
          variant: rng.int(0, 2),
          rot: rng.range(0, Math.PI * 2),
          seed: rng.int(0, 1 << 20),
        });
        blocked.add(col);
      }
      if (blocked.size >= ALL_COLS.length - 1) continue;

      const free = ALL_COLS.filter((c) => !blocked.has(c));
      if (this._floodReachable(free).size > 0) return obstacles;
    }
    return [];
  }

  /**
   * Split a column set into contiguous runs. A run is exactly the set of
   * positions a standing player can slide between without moving forward.
   * @param {Set<number>} set
   * @returns {number[][]}
   */
  _runs(set) {
    const cols = [...set].sort((a, b) => a - b);
    const runs = [];
    let cur = null;
    for (const c of cols) {
      if (cur && c === cur[cur.length - 1] + 1) cur.push(c);
      else {
        cur = [c];
        runs.push(cur);
      }
    }
    return runs;
  }

  /**
   * Columns of the new row the player can actually occupy.
   *
   * The invariant is stronger than "a path exists": *every* contiguous run of
   * currently-reachable columns must contain at least one column that is free
   * in the new row. Only checking that the row is reachable somewhere would
   * still let a player slide into an isolated pocket — one free tile walled in
   * on both sides — and then find the way forward blocked, with nothing to do
   * but retreat or wait for the eagle.
   *
   * @returns {Set<number>} empty when the layout must be re-rolled
   */
  _floodReachable(free) {
    const freeSet = new Set(free);

    for (const run of this._runs(this.reachable)) {
      let hasExit = false;
      for (const c of run) {
        if (freeSet.has(c)) {
          hasExit = true;
          break;
        }
      }
      if (!hasExit) return new Set();
    }

    const landing = [];
    for (const c of this.reachable) if (freeSet.has(c)) landing.push(c);
    if (landing.length === 0) return new Set();

    const out = new Set();
    for (const start of landing) {
      if (out.has(start)) continue;
      for (let c = start; c >= PLAY_COL_MIN && freeSet.has(c); c--) out.add(c);
      for (let c = start; c <= PLAY_COL_MAX && freeSet.has(c); c++) out.add(c);
    }
    return out;
  }

  /* -------------------------------------------------------------- *
   * Road
   * -------------------------------------------------------------- */

  _road(index, diff) {
    const rng = this.rng;
    const dir = rng.chance(0.5) ? 1 : -1;
    const score = index;

    // A lane sticks to one vehicle kind most of the time; mixed lanes are a
    // treat, not the norm, because uniform lanes are far easier to read.
    const laneKind = rng.chance(0.75) ? pickVehicle(rng, score).kind : null;
    const baseType = pickVehicle(rng, score, laneKind);

    const speed = clamp(
      rng.range(diff.carSpeed[0], diff.carSpeed[1]) * baseType.speedMul,
      1.2,
      MAX_VEHICLE_SPEED,
    );

    const gap = minSafeGap(speed, diff.t) + rng.range(diff.gapSlack[0], diff.gapSlack[1]);

    const cycle = buildCycle(rng, {
      span: TRAFFIC_SPAN,
      minGap: gap,
      maxGap: gap * 2.6,
      makeItem: (room) => {
        const type = pickVehicle(rng, score, laneKind);
        // Vehicles are rigid; if this one will not fit, end the pack rather
        // than emit a stretched or clipped car.
        if (type.length > room) return null;
        return {
          length: type.length,
          typeId: type.id,
          colorIndex: rng.int(0, 7),
          honks: type.honk && rng.chance(diff.honkChance),
        };
      },
    });

    const openCols = ALL_COLS.slice();
    this.reachable = new Set(openCols);

    return {
      type: 'road',
      index,
      dir,
      speed,
      cycle,
      tint: index % 2 === 0 ? 0 : 1,
      coins: rng.chance(0.4) ? this._rollCoins(diff, openCols, rng, 2) : [],
      powerup: null,
    };
  }

  /* -------------------------------------------------------------- *
   * Water
   * -------------------------------------------------------------- */

  _water(index, diff) {
    const rng = this.rng;

    let dir = rng.chance(0.5) ? 1 : -1;
    let speed = rng.range(diff.logSpeed[0], diff.logSpeed[1]);
    let velocity = dir * speed;

    // Adjacent water rows must drift relative to each other, otherwise a
    // rider could be permanently stranded with no landing window.
    if (this.lastWaterVelocity !== null) {
      let guard = 0;
      while (Math.abs(velocity - this.lastWaterVelocity) < MIN_WATER_VELOCITY_DELTA && guard++ < 12) {
        dir = -dir;
        speed = rng.range(diff.logSpeed[0], diff.logSpeed[1]);
        velocity = dir * speed;
      }
      if (Math.abs(velocity - this.lastWaterVelocity) < MIN_WATER_VELOCITY_DELTA) {
        // Deterministic fallback: flip and push clear of the threshold.
        velocity = this.lastWaterVelocity > 0
          ? this.lastWaterVelocity - MIN_WATER_VELOCITY_DELTA - 0.2
          : this.lastWaterVelocity + MIN_WATER_VELOCITY_DELTA + 0.2;
        dir = Math.sign(velocity) || 1;
        speed = Math.abs(velocity);
      }
    }
    this.lastWaterVelocity = velocity;

    const useLily = rng.chance(diff.lilyChance);
    const cycle = buildCycle(rng, {
      span: TRAFFIC_SPAN,
      minGap: LOG_GAP[0],
      maxGap: LOG_GAP[1],
      coverage: diff.logCoverage,
      makeItem: (room) => {
        const fits = Math.floor(room / TILE);
        if (fits < 1) return null;
        if (useLily && rng.chance(0.5)) {
          return { length: 1 * TILE, kind: 'lily', withFlower: rng.chance(0.4) };
        }
        const maxTiles = Math.min(diff.logLength[1], fits);
        const tiles = rng.int(Math.min(diff.logLength[0], maxTiles), maxTiles);
        return { length: tiles * TILE, kind: 'log', tiles };
      },
    });

    this.reachable = new Set(ALL_COLS);

    return {
      type: 'water',
      index,
      dir,
      speed,
      velocity,
      cycle,
      coins: [],
      powerup: null,
    };
  }

  /* -------------------------------------------------------------- *
   * Rail
   * -------------------------------------------------------------- */

  _rail(index, diff) {
    const rng = this.rng;

    const dir = rng.chance(0.5) ? 1 : -1;
    const speed = clamp(diff.trainSpeed * rng.range(0.9, 1.1), 8, MAX_TRAIN_SPEED);
    const cars = rng.int(diff.trainCars[0], diff.trainCars[1]);
    const warnTime = clamp(2.4 - diff.t * 0.6, 1.4, 2.4);

    // One train per cycle. The gap is sized so the track is clear at any
    // given column for at least `trainWindow` seconds.
    const trainLength = cars * TRAIN_CAR_LENGTH;
    const minGap = Math.max(diff.trainWindow * speed, trainLength * 0.6);

    // The cycle must also be long enough that a train re-entering the travel
    // window is fully off-screen *and* still has its whole warning time left
    // to run. The window is centred on x = 0, so half of it has to cover the
    // train's own length, the off-screen margin and the approach.
    const entryClearance = (COL_MAX + 1.2) * TILE;
    // A quarter second of headroom so the signal is already lit when the
    // warning window opens, rather than starting at the exact same instant.
    const spanForWarning = trainLength + 2 * (entryClearance + (warnTime + 0.25) * speed);
    const span = Math.max(
      TRAFFIC_SPAN,
      trainLength + minGap + speed * 1.5,
      spanForWarning,
    );

    const cycle = buildCycle(rng, {
      span,
      minGap,
      makeItem: () => ({ length: trainLength, cars }),
    });
    // Keep exactly one train so the warning signal has a single subject.
    cycle.items.length = 1;

    this.reachable = new Set(ALL_COLS);

    return {
      type: 'rail',
      index,
      dir,
      speed,
      cycle,
      cars,
      signal: true,
      warnTime,
      coins: [],
      powerup: null,
    };
  }

  /* -------------------------------------------------------------- *
   * Pickups
   * -------------------------------------------------------------- */

  _rollCoins(diff, openCols, rng, maxCount = 4) {
    if (openCols.length === 0) return [];
    this.rowsSinceCoin++;
    // Pity timer: guarantee a coin if the player has gone a long dry spell.
    const chance = this.rowsSinceCoin > 8 ? 0.9 : diff.coinChance;
    if (!rng.chance(chance)) return [];
    this.rowsSinceCoin = 0;

    // Spread several coins across the row rather than one. A single coin is
    // almost always in a column the player is not in.
    const count = Math.min(maxCount, rng.int(2, 4));
    return rng.shuffle(openCols.slice()).slice(0, count);
  }

  _rollPowerup(index, diff, openCols, rng) {
    if (index < UNLOCK_SCORE.powerups || openCols.length === 0) return null;
    this.rowsSincePowerup++;
    if (this.rowsSincePowerup < 12) return null;
    if (!rng.chance(powerupSpawnChance(index))) return null;
    this.rowsSincePowerup = 0;
    return { col: rng.pick(openCols), id: rollPowerup(rng, index) };
  }
}

/**
 * Wrap a cycle offset into a world X position at a given time.
 *
 * The travel window is always centred on the playfield: `[-span/2, +span/2]`.
 * That matters because rail rows use a much longer cycle than roads do (one
 * train plus a multi-second gap), and anchoring every row to the road-sized
 * window would put a rail wrap point *inside* the playfield — a train would
 * blink into existence with its nose already on screen.
 *
 * @param {number} offset item offset within the cycle
 * @param {number} span   cycle length
 * @param {number} dir    +1 or -1
 * @param {number} speed  units per second (unsigned)
 * @param {number} time   seconds since the row was created
 */
export function cyclePosition(offset, span, dir, speed, time) {
  const u = (((offset + speed * time) % span) + span) % span;
  const startX = -span / 2;
  return dir > 0 ? startX + u : startX + span - u;
}

export { ALL_COLS };
