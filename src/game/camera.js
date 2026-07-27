/**
 * Isometric follow camera.
 *
 * Orthographic, because the flat parallel look is what makes a voxel grid
 * readable — a perspective camera hides hazards behind props. The frustum is
 * sized to guarantee a minimum visible world area on *any* aspect ratio, so a
 * tall phone shows the same amount of road as a wide desktop.
 */

import * as THREE from '../../vendor/three/three.module.js';
import {
  CAMERA_OFFSET,
  CAMERA_LOOK_AHEAD,
  CAMERA_FOLLOW_SPEED,
} from '../core/constants.js';
import { rowToZ, damp, clamp } from '../core/math.js';

/** Minimum world area that must always be on screen (in the ground plane). */
const MIN_VISIBLE_WIDTH = 15.5;
const MIN_VISIBLE_DEPTH = 12.5;

export class GameCamera {
  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 120);
    this.focus = new THREE.Vector3(0, 0, 0);
    this.target = new THREE.Vector3(0, 0, 0);
    this._shake = 0;
    this._shakeSeed = Math.random() * 100;
    this.enabled = true;
    this.zoom = 1;
    this.resize(16 / 9);
    this.reset(0, 0);
  }

  /** @param {number} aspect width / height */
  resize(aspect) {
    this.aspect = aspect || 1;
    this._applyFrustum();
  }

  _applyFrustum() {
    // The camera looks down a 45-degree-ish diagonal, so the ground footprint
    // is roughly sqrt(2) larger than the raw frustum in the depth direction.
    const needW = MIN_VISIBLE_WIDTH * 0.5;
    const needH = (MIN_VISIBLE_DEPTH * 0.5) / 1.35;
    let halfW = Math.max(needW, needH * this.aspect);
    let halfH = halfW / this.aspect;
    if (halfH < needH) {
      halfH = needH;
      halfW = halfH * this.aspect;
    }
    halfW /= this.zoom;
    halfH /= this.zoom;

    const c = this.camera;
    c.left = -halfW;
    c.right = halfW;
    c.top = halfH;
    c.bottom = -halfH;
    c.updateProjectionMatrix();
  }

  setZoom(z) {
    this.zoom = clamp(z, 0.6, 1.6);
    this._applyFrustum();
  }

  reset(row, x) {
    this.target.set(x * 0.4, 0, rowToZ(row + CAMERA_LOOK_AHEAD));
    this.focus.copy(this.target);
    this._shake = 0;
    this._place();
  }

  /**
   * @param {number} dt real frame time
   * @param {{x:number, rowF:number}} player
   * @param {number} [lead] extra forward lead, e.g. while flying
   */
  update(dt, player, lead = 0) {
    // Follow X loosely so side-stepping does not swing the whole world.
    this.target.set(
      player.x * 0.42,
      0,
      rowToZ(player.rowF + CAMERA_LOOK_AHEAD + lead),
    );

    this.focus.x = damp(this.focus.x, this.target.x, CAMERA_FOLLOW_SPEED * 0.75, dt);
    this.focus.z = damp(this.focus.z, this.target.z, CAMERA_FOLLOW_SPEED, dt);

    if (this._shake > 0) this._shake = Math.max(0, this._shake - dt * 2.6);
    this._place(dt);
  }

  _place(dt = 0) {
    const c = this.camera;
    let sx = 0;
    let sy = 0;
    if (this._shake > 0 && this.enabled) {
      this._shakeSeed += dt * 60;
      const a = this._shake * 0.34;
      sx = Math.sin(this._shakeSeed * 1.7) * a;
      sy = Math.cos(this._shakeSeed * 2.3) * a;
    }
    c.position.set(
      this.focus.x + CAMERA_OFFSET.x + sx,
      CAMERA_OFFSET.y + sy,
      this.focus.z + CAMERA_OFFSET.z,
    );
    c.lookAt(this.focus.x + sx * 0.4, 0, this.focus.z);
    c.updateMatrixWorld();
  }

  /** @param {number} amount 0..1 */
  shake(amount) {
    if (!this.enabled) return;
    this._shake = Math.min(1.4, this._shake + amount);
  }

  /** Screen-space bounds of the ground plane, used to cull decorations. */
  get viewDepth() {
    return (this.camera.top - this.camera.bottom) * 1.35;
  }
}
