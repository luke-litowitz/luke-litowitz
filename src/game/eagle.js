/**
 * The eagle: the anti-camping predator.
 *
 * Two triggers, both about refusing to move forward — idling too long, or
 * retreating too far behind the furthest row reached. The player always gets a
 * telegraphed warning, and real forward progress during that warning calls it
 * off, so it punishes stalling rather than hesitation.
 */

import * as THREE from '../../vendor/three/three.module.js';
import {
  EAGLE_IDLE_LIMIT,
  EAGLE_TRAIL_LIMIT,
  EAGLE_WARNING,
} from '../core/constants.js';
import { rowToZ, clamp, lerp } from '../core/math.js';

const STATE = { IDLE: 0, WARNING: 1, DIVING: 2, CARRYING: 3 };

export class Eagle {
  /**
   * @param {THREE.Scene} scene
   * @param {import('../render/props.js').PropFactory} props
   */
  constructor(scene, props) {
    this.scene = scene;
    this.props = props;
    this.model = null;

    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.02;
    this.shadow.visible = false;
    this.shadow.renderOrder = 2;
    scene.add(this.shadow);

    this.reset();
  }

  reset() {
    this.state = STATE.IDLE;
    this.timer = 0;
    this.targetX = 0;
    this.targetRow = 0;
    this.markRow = 0;
    this.x = 0;
    this.y = 8;
    this.z = 0;
    this.prevY = 8;
    if (this.model) {
      this.props.release(this.model);
      this.model = null;
    }
    this.shadow.visible = false;
    this.shadow.material.opacity = 0;
  }

  get active() {
    return this.state !== STATE.IDLE;
  }

  /** Call off an in-progress warning or dive (the player died some other way). */
  standDown() {
    if (this.state === STATE.CARRYING) return;
    this.reset();
  }

  /** Seconds until the grab, for the HUD warning. 0 when not warning. */
  get countdown() {
    return this.state === STATE.WARNING ? Math.max(0, EAGLE_WARNING - this.timer) : 0;
  }

  /**
   * @param {number} dt
   * @param {import('./player.js').Player} player
   * @param {object} ctx { onWarn, onStrike, graceBonus }
   */
  fixedUpdate(dt, player, ctx) {
    // A dead player calls off a stalking eagle — but not one already carrying
    // them away, which still has to fly off screen and clean itself up.
    if (!player.alive && this.state !== STATE.CARRYING) {
      if (this.state !== STATE.IDLE) this.reset();
      return;
    }

    switch (this.state) {
      case STATE.IDLE: {
        const idleLimit = EAGLE_IDLE_LIMIT + (ctx.graceBonus || 0);
        const stalled = player.idleTime > idleLimit;
        const retreated = player.rowF < player.maxRow - EAGLE_TRAIL_LIMIT;
        if (stalled || retreated) this._beginWarning(player, ctx);
        break;
      }

      case STATE.WARNING: {
        this.timer += dt;
        // Genuine forward progress calls the eagle off.
        if (player.maxRow > this.markRow + 0.5) {
          this.state = STATE.IDLE;
          this.shadow.visible = false;
          player.idleTime = 0;
          return;
        }
        this.targetX = player.x;
        this.targetRow = player.rowF;
        if (this.timer >= EAGLE_WARNING) {
          this.state = STATE.DIVING;
          this.timer = 0;
          this._spawnModel();
        }
        break;
      }

      case STATE.DIVING: {
        this.timer += dt;
        this.targetX = player.x;
        this.targetRow = player.rowF;
        const p = clamp(this.timer / 0.32, 0, 1);
        this.prevY = this.y;
        this.y = lerp(7.5, 0.55, p * p);
        this.x = lerp(this.x, this.targetX, Math.min(1, dt * 18));
        this.z = lerp(this.z, rowToZ(this.targetRow), Math.min(1, dt * 18));
        if (p >= 1) {
          this.state = STATE.CARRYING;
          this.timer = 0;
          ctx.onStrike?.();
        }
        break;
      }

      case STATE.CARRYING: {
        this.timer += dt;
        this.prevY = this.y;
        this.y += dt * 6;
        this.x += (this.x > 0 ? 1.2 : -1.2) * dt;
        if (this.timer > 2.2) this.reset();
        break;
      }
    }
  }

  _beginWarning(player, ctx) {
    this.state = STATE.WARNING;
    this.timer = 0;
    this.markRow = player.maxRow;
    this.targetX = player.x;
    this.targetRow = player.rowF;
    this.x = player.x;
    this.z = rowToZ(player.rowF);
    this.y = 7.5;
    this.shadow.visible = true;
    ctx.onWarn?.();
  }

  _spawnModel() {
    if (this.model) return;
    this.model = this.props.eagle();
    this.model.position.set(this.x, this.y, this.z);
    // Pooled props run with matrixAutoUpdate off, so a moved object keeps its
    // old matrix until it is told otherwise — without this the eagle renders
    // frozen at the world origin.
    this.model.updateMatrix();
    this.scene.add(this.model);
  }

  render(alpha, elapsed) {
    if (this.state === STATE.IDLE) {
      if (this.shadow.visible) this.shadow.visible = false;
      return;
    }

    if (this.state === STATE.WARNING) {
      const p = clamp(this.timer / EAGLE_WARNING, 0, 1);
      this.shadow.visible = true;
      this.shadow.position.set(this.targetX, 0.02, rowToZ(this.targetRow));
      // Shadow tightens and darkens as the strike approaches.
      const s = lerp(1.9, 0.75, p) * (1 + Math.sin(elapsed * 18) * 0.05);
      this.shadow.scale.set(s, s, s);
      this.shadow.material.opacity = lerp(0.1, 0.42, p);
      return;
    }

    const y = this.prevY + (this.y - this.prevY) * alpha;
    if (this.model) {
      this.model.position.set(this.x, y, this.z);
      this.model.updateMatrix();
      const flap = Math.sin(elapsed * 22) * 0.7;
      if (this.model.parts?.wingL) this.model.parts.wingL.rotation.z = -0.25 + flap;
      if (this.model.parts?.wingR) this.model.parts.wingR.rotation.z = 0.25 - flap;
    }
    this.shadow.visible = this.state === STATE.DIVING;
    if (this.shadow.visible) {
      this.shadow.position.set(this.x, 0.02, this.z);
      const s = clamp(1.6 - y * 0.14, 0.6, 1.8);
      this.shadow.scale.set(s, s, s);
      this.shadow.material.opacity = 0.42;
    }
  }

  dispose() {
    this.reset();
    this.shadow.geometry.dispose();
    this.shadow.material.dispose();
    this.shadow.removeFromParent();
  }
}
