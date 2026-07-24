/**
 * The player: a grid-hop state machine with continuous physics on water.
 *
 * The rules that make this feel right (and that the whole game is balanced
 * around) are spelled out in docs/ARCHITECTURE.md §5. In short:
 *
 *   - a hop is a real ballistic arc, `4t(1-t)`, of fixed duration;
 *   - landings on solid ground snap to the tile grid, so the world stays
 *     readable and obstacles can be validated before the hop even starts;
 *   - landings on water do not snap, and momentum from the platform you left
 *     is carried through the flight, because nothing pushes you sideways once
 *     you are airborne;
 *   - while riding, you move by the platform's *exact* displacement this step
 *     rather than an integrated velocity, so you can never drift off it.
 */

import {
  HOP_DURATION,
  HOP_HEIGHT,
  HOP_SQUASH,
  PLAYER_HALF_W,
  PLAYER_HALF_D,
  PLAY_COL_MIN,
  PLAY_COL_MAX,
  BOUND_X,
  TILE,
  INPUT_BUFFER_TIME,
  MAX_QUEUED_MOVES,
  PLATFORM_MOMENTUM_INHERITANCE,
  PLATFORM_GRIP_MARGIN,
} from '../core/constants.js';
import { clamp, lerp, hopArc, hopEase, colToX, rowToZ, dampAngle } from '../core/math.js';

const DIRS = {
  up: { row: 1, col: 0, yaw: 0 },
  down: { row: -1, col: 0, yaw: Math.PI },
  left: { row: 0, col: -1, yaw: Math.PI / 2 },
  right: { row: 0, col: 1, yaw: -Math.PI / 2 },
};

/** Extra altitude and speed while the jetpack is burning. */
const JETPACK_ALTITUDE = 1.05;
const JETPACK_HOP_DURATION = 0.1;

export class Player {
  constructor() {
    this.reset();
  }

  reset(character = null) {
    this.character = character;

    this.x = 0;
    this.gridRow = 0;
    this.rowF = 0; // fractional row while hopping
    this.z = 0;
    this.y = 0;
    /** Height of the surface underfoot: 0 on land, the deck of a log on water. */
    this.baseY = 0;

    this.prevX = 0;
    this.prevZ = 0;
    this.prevY = 0;
    this.prevRowF = 0;

    this.maxRow = 0;
    this.facing = 0;
    this.visualYaw = 0;

    this.hop = {
      active: false,
      t: 0,
      duration: HOP_DURATION,
      fromX: 0,
      toX: 0,
      fromY: 0,
      toY: 0,
      fromRow: 0,
      toRow: 0,
    };

    /** Platform item we are riding, or null. */
    this.carrier = null;
    this.carrierRow = 0;

    /** @type {{dir:string, at:number}[]} */
    this.queue = [];
    this.time = 0;

    this.alive = true;
    this.deathCause = null;
    this.deathTime = 0;

    this.invulnerable = 0;
    this.flying = false;

    this.idleTime = 0;
    this.hopCount = 0;
    this.bumpTimer = 0;
    this._eagleDriftX = 0;

    /* Perk-derived values, refreshed by applyCharacter(). */
    this.hopSpeedMul = 1;
    this.grip = PLATFORM_GRIP_MARGIN;
    return this;
  }

  applyCharacter(character) {
    this.character = character;
    const perk = character?.perk;
    this.hopSpeedMul = 1;
    this.grip = PLATFORM_GRIP_MARGIN;
    if (perk?.id === 'hopSpeed') this.hopSpeedMul = clamp(perk.value, 0.8, 1.2);
    if (perk?.id === 'riverGrip') this.grip = PLATFORM_GRIP_MARGIN * clamp(perk.value, 1, 3);
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  /** Queue a direction. Buffered so a press just before landing still counts. */
  requestMove(dir) {
    if (!this.alive || !DIRS[dir]) return;
    if (this.queue.length >= MAX_QUEUED_MOVES) this.queue.shift();
    this.queue.push({ dir, at: this.time });
  }

  clearQueue() {
    this.queue.length = 0;
  }

  /* ---------------------------------------------------------------- *
   * Simulation
   * ---------------------------------------------------------------- */

  /**
   * @param {number} dt
   * @param {object} ctx { world, onHop, onLand, onBlocked, onDeath }
   */
  fixedUpdate(dt, ctx) {
    this.time += dt;
    this.prevX = this.x;
    this.prevZ = this.z;
    this.prevY = this.y;
    this.prevRowF = this.rowF;

    if (this.invulnerable > 0) this.invulnerable = Math.max(0, this.invulnerable - dt);
    if (this.bumpTimer > 0) this.bumpTimer = Math.max(0, this.bumpTimer - dt);

    if (!this.alive) {
      this.deathTime += dt;
      this._integrateDeath(dt);
      return;
    }

    // Ride the platform by its exact displacement, not an integrated velocity.
    if (this.carrier && !this.hop.active) {
      const d = this.carrier.x - this.carrier.prevX;
      this.x += d;
    }

    if (this.hop.active) this._advanceHop(dt, ctx);
    else this._consumeQueue(ctx);

    // Auto-advance while the jetpack burns.
    if (this.flying && !this.hop.active) this._startHop('up', ctx, true);

    // Settle back onto the surface when the jetpack cuts out mid-stride.
    if (!this.flying && !this.hop.active && this.y > this.baseY) {
      this.y = Math.max(this.baseY, this.y - dt * 6);
    }

    this.z = rowToZ(this.rowF);
    this._trackIdle(dt);

    if (Math.abs(this.x) > BOUND_X) ctx.onDeath?.('void');
  }

  _trackIdle(dt) {
    if (this.rowF > this.maxRow) {
      this.maxRow = this.rowF;
      this.idleTime = 0;
    } else {
      this.idleTime += dt;
    }
  }

  _consumeQueue(ctx) {
    while (this.queue.length) {
      const next = this.queue[0];
      if (this.time - next.at > INPUT_BUFFER_TIME) {
        this.queue.shift();
        continue;
      }
      this.queue.shift();
      if (this._startHop(next.dir, ctx)) return;
      // A rejected move should not eat the rest of the buffer.
      return;
    }
  }

  /**
   * @returns {boolean} true when the hop actually started.
   * @private
   */
  _startHop(dir, ctx, auto = false) {
    const d = DIRS[dir];
    if (!d) return false;
    const world = ctx.world;

    const fromRow = this.gridRow;
    const toRow = fromRow + d.row;

    // Never hop into ungenerated space behind us.
    if (toRow < world.minRow + 1) {
      this._reject(ctx);
      return false;
    }

    const targetType = world.rowType(toRow);
    if (targetType === null) {
      this._reject(ctx);
      return false;
    }

    let toX;
    let toY = 0;
    if (targetType === 'water') {
      const carrierV = this.carrier ? world.rowAt(this.carrierRow)?.velocity ?? 0 : 0;
      const duration = this._hopDuration();
      toX =
        this.x +
        d.col * TILE +
        carrierV * duration * PLATFORM_MOMENTUM_INHERITANCE;
      // Sideways hops must still respect the playfield walls.
      if (d.col !== 0 && Math.abs(this.x + d.col * TILE) > (PLAY_COL_MAX + 0.5) * TILE) {
        this._reject(ctx);
        return false;
      }
    } else {
      // Clamp the departure column into the playfield first. In normal play
      // this is a no-op; it matters only when a log has carried the player
      // outside the walls, where an unclamped target would reject *every*
      // direction and strand them with no way back.
      const baseCol = clamp(Math.round(this.x / TILE), PLAY_COL_MIN, PLAY_COL_MAX);
      const toCol = baseCol + d.col;
      if (toCol < PLAY_COL_MIN || toCol > PLAY_COL_MAX) {
        this._reject(ctx);
        return false;
      }
      if (world.isBlocked(toRow, toCol)) {
        this._reject(ctx);
        return false;
      }
      toX = colToX(toCol);
    }

    if (targetType === 'water') {
      // Best estimate of the deck we are aiming at, so the arc lands level.
      // Whatever platform is actually there wins at touchdown; the platform
      // moves at most half a tile during a hop, so the correction is invisible.
      const landing = world.platformAt(toRow, toX, this.grip);
      toY = landing ? landing.surfaceY ?? 0 : 0;
    }

    const hop = this.hop;
    hop.active = true;
    hop.t = 0;
    hop.duration = this._hopDuration();
    hop.fromX = this.x;
    hop.toX = toX;
    hop.fromY = this.baseY;
    hop.toY = toY;
    hop.fromRow = fromRow;
    hop.toRow = toRow;

    this.facing = d.yaw;
    this.carrier = null;
    this.hopCount++;
    if (!auto) ctx.onHop?.(dir);
    return true;
  }

  _hopDuration() {
    if (this.flying) return JETPACK_HOP_DURATION;
    return HOP_DURATION * this.hopSpeedMul;
  }

  _reject(ctx) {
    if (this.bumpTimer > 0) return;
    this.bumpTimer = 0.22;
    ctx.onBlocked?.();
  }

  _advanceHop(dt, ctx) {
    const hop = this.hop;
    hop.t += dt;
    const p = clamp(hop.t / hop.duration, 0, 1);
    const e = hopEase(p);

    this.x = lerp(hop.fromX, hop.toX, e);
    this.rowF = lerp(hop.fromRow, hop.toRow, e);
    this.y =
      lerp(hop.fromY, hop.toY, e) +
      HOP_HEIGHT * hopArc(p) +
      (this.flying ? JETPACK_ALTITUDE : 0);

    if (p >= 1) this._land(ctx);
  }

  _land(ctx) {
    const hop = this.hop;
    hop.active = false;
    this.x = hop.toX;
    this.gridRow = hop.toRow;
    this.rowF = hop.toRow;

    const world = ctx.world;
    const row = world.rowAt(this.gridRow);

    if (row && row.type === 'water') {
      const platform = row.platformAt(this.x, this.grip);
      if (platform) {
        this.carrier = platform;
        this.carrierRow = this.gridRow;
        this.baseY = platform.surfaceY ?? 0;
      } else {
        this.baseY = 0;
        this.carrier = null;
        if (!this.flying && this.invulnerable <= 0) {
          ctx.onDeath?.('water');
          return;
        }
      }
    } else {
      this.carrier = null;
      this.baseY = 0;
    }

    this.y = this.baseY + (this.flying ? JETPACK_ALTITUDE : 0);
    ctx.onLand?.(row ? row.type : 'grass');
    if (!this.flying) this._consumeQueue(ctx);
  }

  /** Ragdoll-ish motion after death, purely cosmetic. */
  _integrateDeath(dt) {
    switch (this.deathCause) {
      case 'water':
        this.y = lerp(this.y, -0.45, Math.min(1, dt * 5));
        break;
      case 'eagle':
        this.y += dt * 6;
        this.x += this._eagleDriftX * dt;
        break;
      case 'car':
      case 'train':
        this.y = Math.max(0.02, this.y - dt * 2);
        break;
      default:
        this.y = lerp(this.y, -0.2, Math.min(1, dt * 4));
    }
    this.z = rowToZ(this.rowF);
  }

  /* ---------------------------------------------------------------- *
   * State transitions
   * ---------------------------------------------------------------- */

  kill(cause) {
    if (!this.alive) return false;
    this.alive = false;
    this.deathCause = cause;
    this.deathTime = 0;
    this.hop.active = false;
    this.carrier = null;
    this.flying = false;
    this.queue.length = 0;
    this._eagleDriftX = this.x > 0 ? 1.2 : -1.2;
    return true;
  }

  /**
   * Survive an otherwise-fatal hit (shield). Water and void deaths need the
   * player put back somewhere they can stand.
   * @param {string} cause
   * @param {object} world
   */
  survive(cause, world) {
    this.invulnerable = 1.4;
    this.queue.length = 0;

    if (cause === 'water' || cause === 'void') {
      const platform = world.platformAt(this.gridRow, this.x, this.grip * 6);
      if (platform) {
        this.carrier = platform;
        this.carrierRow = this.gridRow;
        this.baseY = platform.surfaceY ?? 0;
        this.x = clamp(this.x, platform.x - platform.halfLen, platform.x + platform.halfLen);
      } else {
        // Walk back to the last solid row we can find.
        for (let r = this.gridRow; r > world.minRow; r--) {
          const row = world.rowAt(r);
          if (row && row.type !== 'water') {
            const col = clamp(Math.round(this.x / TILE), PLAY_COL_MIN, PLAY_COL_MAX);
            const free = row.isBlocked(col) ? this._nearestFreeCol(row, col) : col;
            this.gridRow = r;
            this.rowF = r;
            this.x = colToX(free);
            this.carrier = null;
            break;
          }
        }
      }
      this.y = this.baseY;
      this.hop.active = false;
      this.z = rowToZ(this.rowF);
    }
  }

  _nearestFreeCol(row, col) {
    for (let d = 1; d <= PLAY_COL_MAX - PLAY_COL_MIN; d++) {
      if (col - d >= PLAY_COL_MIN && !row.isBlocked(col - d)) return col - d;
      if (col + d <= PLAY_COL_MAX && !row.isBlocked(col + d)) return col + d;
    }
    return col;
  }

  /* ---------------------------------------------------------------- *
   * Accessors for collision
   * ---------------------------------------------------------------- */

  get halfW() {
    return PLAYER_HALF_W;
  }

  get halfD() {
    return PLAYER_HALF_D;
  }

  get score() {
    return Math.max(0, Math.floor(this.maxRow));
  }

  get isAirborne() {
    return this.hop.active;
  }

  /* ---------------------------------------------------------------- *
   * Presentation
   * ---------------------------------------------------------------- */

  /**
   * Drive the character model.
   * @param {THREE.Object3D} model
   * @param {number} alpha interpolation between the last two sim states
   * @param {number} dt    real frame time, for damped visuals only
   */
  applyToModel(model, alpha, dt, elapsed) {
    const x = this.prevX + (this.x - this.prevX) * alpha;
    const y = this.prevY + (this.y - this.prevY) * alpha;
    const z = this.prevZ + (this.z - this.prevZ) * alpha;
    model.position.set(x, y, z);

    this.visualYaw = dampAngle(this.visualYaw, this.facing, 22, dt);
    model.rotation.y = this.visualYaw;

    const hop = this.hop;
    const p = hop.active ? clamp(hop.t / hop.duration, 0, 1) : 1;

    if (this.alive) {
      // Squash on take-off and landing, stretch at the apex.
      const stretch = hop.active ? 1 + HOP_SQUASH * (hopArc(p) - 0.5) * 1.6 : 1;
      const squash = hop.active ? 1 / Math.max(0.4, stretch) : 1;
      const bump = this.bumpTimer > 0 ? 1 - this.bumpTimer * 0.25 : 1;
      model.scale.set(squash * bump, stretch, squash * bump);
      model.rotation.z = 0;
      model.rotation.x = 0;
    } else {
      model.scale.set(1, 1, 1);
      if (this.deathCause === 'car' || this.deathCause === 'train') {
        model.scale.set(1.35, 0.16, 1.35);
      } else if (this.deathCause === 'eagle') {
        model.rotation.z = Math.sin(this.deathTime * 18) * 0.5;
        model.rotation.x = this.deathTime * 3;
      } else {
        model.rotation.x = Math.sin(this.deathTime * 6) * 0.25;
      }
    }

    // Legs pedal through the hop; ears/tails get a lazy idle sway.
    const parts = model.parts;
    if (parts) {
      const swing = hop.active ? Math.sin(p * Math.PI) * 0.9 : 0;
      if (parts.legL) parts.legL.rotation.x = swing;
      if (parts.legR) parts.legR.rotation.x = -swing;
      if (parts.armL) parts.armL.rotation.x = -swing * 0.6;
      if (parts.armR) parts.armR.rotation.x = swing * 0.6;
      const idle = Math.sin(elapsed * 2.4) * 0.08;
      if (parts.tail) parts.tail.rotation.y = idle * 2;
      if (parts.ear) parts.ear.rotation.z = idle;
      if (parts.wingL) parts.wingL.rotation.z = -0.2 - swing * 0.5;
      if (parts.wingR) parts.wingR.rotation.z = 0.2 + swing * 0.5;
      if (parts.head) parts.head.rotation.x = hop.active ? -swing * 0.25 : idle * 0.4;
    }

    // Invulnerability blink.
    if (this.invulnerable > 0) {
      model.visible = Math.sin(this.invulnerable * 40) > -0.2;
    } else {
      model.visible = true;
    }
  }
}
