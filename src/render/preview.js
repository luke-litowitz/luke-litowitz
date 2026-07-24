/**
 * Character preview.
 *
 * A tiny second WebGL context mounted into the character-select screen. It
 * renders on demand only — starting when the screen opens and stopping when it
 * closes — so it never competes with the game for frame time.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { buildVoxelModel, specBounds } from './voxel.js';
import { characterSpec, getCharacter } from '../data/characters.js';
import { RARITIES } from '../data/characters.js';
import { PALETTE } from './palette.js';

export class CharacterPreview {
  /** @param {HTMLElement} mount */
  constructor(mount) {
    this.mount = mount;
    this.enabled = false;
    this._raf = 0;
    this._time = 0;
    this._last = 0;
    this._currentId = null;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'char-preview__canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    mount.appendChild(this.canvas);

    let renderer = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    } catch {
      // No second WebGL context available (older mobile): degrade silently.
      this.canvas.remove();
      this.unavailable = true;
      return;
    }
    this.renderer = renderer;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
    this.camera.position.set(0, 1.15, 3.3);
    this.camera.lookAt(0, 0.45, 0);

    this.scene.add(new THREE.HemisphereLight(0xdff2ff, 0x6cc34a, 1.05));
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(2.4, 3.6, 2.8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9ec8ff, 0.5);
    rim.position.set(-2.5, 1.5, -2);
    this.scene.add(rim);

    this.pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.82, 0.14, 28),
      new THREE.MeshLambertMaterial({ color: PALETTE.grassMid }),
    );
    this.pedestal.position.y = -0.07;
    this.scene.add(this.pedestal);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.model = null;
    this._tick = this._tick.bind(this);
    this._onResize = () => this.resize();
  }

  /** @param {string} id character id */
  setCharacter(id) {
    if (this.unavailable || this._currentId === id) return;
    const character = getCharacter(id);
    if (!character) return;
    this._currentId = id;

    if (this.model) {
      this.model.traverse((o) => o.geometry?.dispose());
      this.pivot.remove(this.model);
    }
    const spec = characterSpec(id);
    this.model = buildVoxelModel(spec, { castShadow: false });
    this.pivot.add(this.model);

    // Frame the model regardless of how tall the character is.
    const b = specBounds(spec);
    const height = Math.max(0.4, b.size[1]);
    this.camera.position.set(0, height * 0.85 + 0.35, height * 2.3 + 1.5);
    this.camera.lookAt(0, height * 0.45, 0);

    const rarity = RARITIES?.[character.rarity];
    if (rarity?.color) this.pedestal.material.color.set(rarity.color);
  }

  start() {
    if (this.unavailable || this.enabled) return;
    this.enabled = true;
    this._last = performance.now();
    this.resize();
    window.addEventListener('resize', this._onResize);
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    if (!this.enabled) return;
    this.enabled = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
  }

  resize() {
    if (this.unavailable) return;
    const rect = this.mount.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _tick(now) {
    if (!this.enabled) return;
    this._raf = requestAnimationFrame(this._tick);
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this._time += dt;

    this.pivot.rotation.y = this._time * 0.7;
    if (this.model) {
      this.model.position.y = Math.sin(this._time * 2.6) * 0.05;
      const parts = this.model.parts;
      if (parts) {
        const swing = Math.sin(this._time * 5.2) * 0.28;
        if (parts.legL) parts.legL.rotation.x = swing;
        if (parts.legR) parts.legR.rotation.x = -swing;
        if (parts.wingL) parts.wingL.rotation.z = -0.2 + Math.sin(this._time * 4) * 0.2;
        if (parts.wingR) parts.wingR.rotation.z = 0.2 - Math.sin(this._time * 4) * 0.2;
        if (parts.tail) parts.tail.rotation.y = Math.sin(this._time * 3) * 0.2;
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    if (this.unavailable) return;
    if (this.model) this.model.traverse((o) => o.geometry?.dispose());
    this.pedestal.geometry.dispose();
    this.pedestal.material.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
