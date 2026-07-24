/**
 * Particle effects.
 *
 * One InstancedMesh of small cubes covers every burst in the game — coin
 * pickups, splashes, crash debris, landing dust, power-up pops. Instances are
 * recycled from a free list so a long run never allocates.
 */

import * as THREE from '../../vendor/three/three.module.js';

const MAX_PARTICLES = 320;
const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _euler = new THREE.Euler();
const _color = new THREE.Color();

export class Particles {
  /** @param {THREE.Scene} scene */
  constructor(scene, count = MAX_PARTICLES) {
    this.count = count;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ transparent: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    // Flat parallel arrays: no per-particle objects, no GC churn.
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.vx = new Float32Array(count);
    this.vy = new Float32Array(count);
    this.vz = new Float32Array(count);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.size = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.spin = new Float32Array(count);
    this.rot = new Float32Array(count);
    this.alive = new Uint8Array(count);

    this._free = [];
    for (let i = count - 1; i >= 0; i--) this._free.push(i);

    // Park every instance far away and fully collapsed until used.
    _scale.set(0, 0, 0);
    _pos.set(0, -999, 0);
    _quat.identity();
    for (let i = 0; i < count; i++) {
      _matrix.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _matrix);
      this.mesh.setColorAt(i, _color.set('#ffffff'));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /**
   * @param {number} x @param {number} y @param {number} z
   * @param {object} [opts]
   * @param {number} [opts.count]
   * @param {string|number} [opts.color]
   * @param {number} [opts.speed]   initial speed magnitude
   * @param {number} [opts.spread]  lateral spread multiplier
   * @param {number} [opts.up]      upward bias
   * @param {number} [opts.gravity]
   * @param {number} [opts.life]
   * @param {number} [opts.size]
   */
  burst(x, y, z, opts = {}) {
    const n = Math.min(opts.count ?? 10, this._free.length);
    const speed = opts.speed ?? 2.4;
    const spread = opts.spread ?? 1;
    const up = opts.up ?? 1.6;
    const life = opts.life ?? 0.55;
    const size = opts.size ?? 0.1;
    const gravity = opts.gravity ?? 9;
    _color.set(opts.color ?? '#ffffff');

    for (let k = 0; k < n; k++) {
      const i = this._free.pop();
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * speed * spread;
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = Math.cos(a) * r;
      this.vz[i] = Math.sin(a) * r;
      this.vy[i] = up * (0.5 + Math.random());
      this.life[i] = life * (0.7 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.size[i] = size * (0.7 + Math.random() * 0.7);
      this.gravity[i] = gravity;
      this.spin[i] = (Math.random() - 0.5) * 14;
      this.rot[i] = Math.random() * Math.PI;
      this.alive[i] = 1;
      this.mesh.setColorAt(i, _color);
    }
    if (n > 0 && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Ring of droplets for a water entry. */
  splash(x, y, z, color = '#cfe9ff') {
    this.burst(x, y, z, { count: 16, color, speed: 2.2, up: 2.6, life: 0.7, size: 0.09, gravity: 11 });
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;
      dirty = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alive[i] = 0;
        this._free.push(i);
        _scale.set(0, 0, 0);
        _pos.set(0, -999, 0);
        _quat.identity();
        _matrix.compose(_pos, _quat, _scale);
        this.mesh.setMatrixAt(i, _matrix);
        continue;
      }

      this.vy[i] -= this.gravity[i] * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      this.rot[i] += this.spin[i] * dt;

      // Bounce once off the ground so debris settles instead of vanishing.
      if (this.py[i] < 0.03 && this.vy[i] < 0) {
        this.py[i] = 0.03;
        this.vy[i] *= -0.32;
        this.vx[i] *= 0.7;
        this.vz[i] *= 0.7;
      }

      const t = this.life[i] / this.maxLife[i];
      const s = this.size[i] * (0.35 + t * 0.65);
      _pos.set(this.px[i], this.py[i], this.pz[i]);
      _euler.set(this.rot[i], this.rot[i] * 0.7, 0);
      _quat.setFromEuler(_euler);
      _scale.set(s, s, s);
      _matrix.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(i, _matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset() {
    for (let i = 0; i < this.count; i++) {
      if (!this.alive[i]) continue;
      this.alive[i] = 0;
      this._free.push(i);
    }
    _scale.set(0, 0, 0);
    _pos.set(0, -999, 0);
    _quat.identity();
    _matrix.compose(_pos, _quat, _scale);
    for (let i = 0; i < this.count; i++) this.mesh.setMatrixAt(i, _matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.removeFromParent();
  }
}
