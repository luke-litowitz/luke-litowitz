/**
 * Stage: renderer, scene, lighting, sky and clouds.
 *
 * Kept separate from the game so quality settings, biome transitions and
 * resizing are all in one place, and so the character-preview renderer can
 * reuse the same lighting recipe.
 */

import * as THREE from '../../vendor/three/three.module.js';
import { buildVoxelModel } from './voxel.js';
import { biomeForScore } from './palette.js';
import { TILE } from '../core/constants.js';
import { hash01, clamp, damp } from '../core/math.js';

export const QUALITY = {
  low: { shadows: false, shadowMap: 512, maxDpr: 1, antialias: false, clouds: 3 },
  medium: { shadows: true, shadowMap: 1024, maxDpr: 1.5, antialias: true, clouds: 5 },
  high: { shadows: true, shadowMap: 2048, maxDpr: 2, antialias: true, clouds: 8 },
};

/** Pick a starting quality from what the device tells us about itself. */
export function detectQuality() {
  if (typeof navigator === 'undefined') return 'medium';
  const mem = navigator.deviceMemory || 4;
  const cores = navigator.hardwareConcurrency || 4;
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  if (mem <= 2 || cores <= 2) return 'low';
  if (coarse && mem <= 4) return 'medium';
  return cores >= 8 && mem >= 8 ? 'high' : 'medium';
}

function skyTexture(top, bottom) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top);
  grad.addColorStop(0.62, bottom);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function cloudSpec(seed) {
  const boxes = [];
  const n = 3 + Math.floor(hash01(seed, 1) * 4);
  for (let i = 0; i < n; i++) {
    const w = 1.4 + hash01(seed, i + 2) * 2.2;
    const h = 0.7 + hash01(seed, i + 9) * 0.6;
    boxes.push({
      pos: [(hash01(seed, i + 3) - 0.5) * 3.6, (hash01(seed, i + 4) - 0.5) * 0.5, (hash01(seed, i + 5) - 0.5) * 1.8],
      size: [w, h, w * 0.8],
      color: i % 2 === 0 ? '#ffffff' : '#eef6ff',
    });
  }
  return { parts: [{ name: 'cloud', boxes, material: 'basic' }] };
}

export class Stage {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{quality?: string}} [opts]
   */
  constructor(canvas, opts = {}) {
    this.quality = QUALITY[opts.quality] ? opts.quality : detectQuality();
    const q = QUALITY[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: q.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.renderer.setClearColor(0x8fd6ff, 1);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xbfe8ff, 26, 58);

    this.hemi = new THREE.HemisphereLight(0xcfefff, 0x6cc34a, 0.85);
    this.scene.add(this.hemi);

    this.ambient = new THREE.AmbientLight(0xffffff, 0.32);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xfff6e0, 1.5);
    this.sun.position.set(9, 16, 8);
    this.sun.castShadow = q.shadows;
    this._configureShadow(q.shadowMap);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.clouds = [];
    this._buildClouds(q.clouds);

    this._skyTex = null;
    this.biome = null;
    this._blend = { hemiSky: new THREE.Color(), fog: new THREE.Color() };
    this.applyBiome(biomeForScore(0), true);

    this._dprCap = q.maxDpr;
    this.width = 1;
    this.height = 1;
  }

  _configureShadow(size) {
    const s = this.sun.shadow;
    s.mapSize.set(size, size);
    s.camera.near = 1;
    s.camera.far = 60;
    s.camera.left = -16;
    s.camera.right = 16;
    s.camera.top = 16;
    s.camera.bottom = -16;
    s.bias = -0.0016;
    s.normalBias = 0.035;
  }

  _buildClouds(count) {
    for (const c of this.clouds) c.removeFromParent();
    this.clouds.length = 0;
    for (let i = 0; i < count; i++) {
      const mesh = buildVoxelModel(cloudSpec(i * 37 + 5), { castShadow: false });
      mesh.position.set(
        (hash01(i, 11) - 0.5) * 46,
        11 + hash01(i, 12) * 5,
        -hash01(i, 13) * 60,
      );
      mesh.userData.drift = 0.25 + hash01(i, 14) * 0.5;
      mesh.userData.slot = i;
      this.scene.add(mesh);
      this.clouds.push(mesh);
    }
  }

  /* ---------------------------------------------------------------- */

  /**
   * @param {object} biome entry from palette.js
   * @param {boolean} [immediate] skip the crossfade
   */
  applyBiome(biome, immediate = false) {
    this.biome = biome;
    this._targetFog = new THREE.Color(biome.fog);
    this._targetHemiSky = new THREE.Color(biome.hemiSky);
    this._targetHemiGround = new THREE.Color(biome.hemiGround);
    this._targetSun = new THREE.Color(biome.sunColor);
    this._targetSunIntensity = biome.sunIntensity;
    this._targetAmbient = biome.ambient * 0.42;

    if (this._skyTex) this._skyTex.dispose();
    this._skyTex = skyTexture(biome.sky, biome.fog);
    if (this._skyTex) this.scene.background = this._skyTex;
    else this.scene.background = new THREE.Color(biome.sky);
    this.renderer.setClearColor(new THREE.Color(biome.sky), 1);

    if (immediate) {
      this.scene.fog.color.copy(this._targetFog);
      this.hemi.color.copy(this._targetHemiSky);
      this.hemi.groundColor.copy(this._targetHemiGround);
      this.sun.color.copy(this._targetSun);
      this.sun.intensity = this._targetSunIntensity;
      this.ambient.intensity = this._targetAmbient;
      this.hemi.intensity = biome.ambient;
    }
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} focus camera focus point, drives shadow + clouds
   */
  update(dt, focus) {
    // Smooth the lighting so a biome change reads as dusk falling, not a cut.
    const r = 1.6;
    this.scene.fog.color.lerp(this._targetFog, clamp(dt * r, 0, 1));
    this.hemi.color.lerp(this._targetHemiSky, clamp(dt * r, 0, 1));
    this.hemi.groundColor.lerp(this._targetHemiGround, clamp(dt * r, 0, 1));
    this.sun.color.lerp(this._targetSun, clamp(dt * r, 0, 1));
    this.sun.intensity = damp(this.sun.intensity, this._targetSunIntensity, r, dt);
    this.ambient.intensity = damp(this.ambient.intensity, this._targetAmbient, r, dt);
    this.hemi.intensity = damp(this.hemi.intensity, this.biome.ambient, r, dt);

    if (focus) {
      // Keep the shadow frustum tight around the action for crisp shadows.
      this.sun.target.position.set(focus.x, 0, focus.z);
      this.sun.position.set(focus.x + 9, 16, focus.z + 8);
      this.sun.target.updateMatrixWorld();

      for (const cloud of this.clouds) {
        cloud.position.x += cloud.userData.drift * dt;
        if (cloud.position.x > 30) cloud.position.x = -30;
        // Recycle clouds that fall behind so the sky is never empty.
        if (cloud.position.z > focus.z + 24) {
          cloud.position.z = focus.z - 55 - hash01(cloud.userData.slot, 21) * 20;
          cloud.position.x = (hash01(cloud.userData.slot + 99, 22) - 0.5) * 46;
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */

  setQuality(name) {
    const q = QUALITY[name];
    if (!q) return;
    this.quality = name;
    this._dprCap = q.maxDpr;
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    this._configureShadow(q.shadowMap);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this._buildClouds(q.clouds);
    this.resize(this.width, this.height);
  }

  setShadows(on) {
    const q = QUALITY[this.quality];
    const enabled = on && q.shadows;
    this.renderer.shadowMap.enabled = enabled;
    this.sun.castShadow = enabled;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    const dpr = Math.min(window.devicePixelRatio || 1, this._dprCap);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
  }

  render(camera) {
    this.renderer.render(this.scene, camera);
  }

  dispose() {
    this._skyTex?.dispose();
    this.renderer.dispose();
  }
}

export { TILE };
