/**
 * Active power-up runtime.
 *
 * `src/data/powerups.js` owns what a power-up *is*; this owns what it *does*
 * while a run is in progress. Effects are queried, not pushed, so the rest of
 * the game never has to know which power-ups exist.
 */

import { getPowerup } from '../data/powerups.js';
import { COIN_MAGNET_RADIUS, COIN_MAGNET_BASE } from '../core/constants.js';
import { clamp } from '../core/math.js';

export class PowerupSystem {
  /** @param {(id:string)=>void} [onExpire] */
  constructor(onExpire) {
    /** @type {Map<string, {id:string, def:object, remaining:number, duration:number}>} */
    this.active = new Map();
    this.onExpire = onExpire;
    this._hud = [];
    this.magnetMultiplier = 1;
  }

  reset() {
    this.active.clear();
    this._hud.length = 0;
  }

  /**
   * @param {string} id
   * @returns {boolean} true when the power-up was applied
   */
  activate(id) {
    const def = getPowerup(id);
    if (!def) return false;
    const existing = this.active.get(id);
    if (existing) {
      // Re-collecting refreshes rather than stacking, so timers stay readable.
      existing.remaining = def.duration;
      return true;
    }
    this.active.set(id, { id, def, remaining: def.duration, duration: def.duration });
    return true;
  }

  has(id) {
    return this.active.has(id);
  }

  remaining(id) {
    return this.active.get(id)?.remaining ?? 0;
  }

  /** Spend the shield. @returns {boolean} true if a shield was available. */
  consumeShield() {
    if (!this.active.has('shield')) return false;
    this.active.delete('shield');
    this.onExpire?.('shield');
    return true;
  }

  clear(id) {
    if (this.active.delete(id)) this.onExpire?.(id);
  }

  /**
   * @param {number} dt real (unscaled) seconds — power-up timers are not
   *   slowed by their own slow-motion effect.
   * @param {(id:string)=>boolean} [hold] veto expiry, e.g. keep the jetpack
   *   burning until the player is over ground they can land on.
   */
  fixedUpdate(dt, hold) {
    if (this.active.size === 0) return;
    for (const entry of this.active.values()) {
      entry.remaining -= dt;
      if (entry.remaining > 0) continue;
      if (hold && hold(entry.id)) {
        entry.remaining = 0.05; // keep it alive one more beat
        continue;
      }
      this.active.delete(entry.id);
      this.onExpire?.(entry.id);
    }
  }

  /* ---------------------------------------------------------------- *
   * Derived effects
   * ---------------------------------------------------------------- */

  /** World time scale. Slow-mo affects hazards, never the UI or timers. */
  get timeScale() {
    return this.has('slowmo') ? 0.55 : 1;
  }

  get coinMultiplier() {
    return this.has('doubler') ? 2 : 1;
  }

  /** Coins always drift toward the player a little; the power-up widens it. */
  get magnetRadius() {
    return (this.has('magnet') ? COIN_MAGNET_RADIUS : COIN_MAGNET_BASE) * this.magnetMultiplier;
  }

  get flying() {
    return this.has('jetpack');
  }

  get invulnerable() {
    return this.has('jetpack');
  }

  /** Stable array for the HUD. Reused to avoid per-frame allocation. */
  hudList() {
    this._hud.length = 0;
    for (const e of this.active.values()) {
      this._hud.push({
        id: e.id,
        icon: e.def.icon,
        color: e.def.color,
        name: e.def.name,
        remaining: Math.max(0, e.remaining),
        duration: e.duration,
        progress: clamp(e.remaining / e.duration, 0, 1),
      });
    }
    return this._hud;
  }
}
