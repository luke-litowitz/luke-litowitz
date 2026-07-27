/**
 * Voxel model builder.
 *
 * Every prop, vehicle and character in the game is described as a plain data
 * spec of axis-aligned boxes. This module turns a spec into a Three.js Group
 * with one merged, vertex-coloured mesh per part, so a whole character is
 * typically 1-3 draw calls while still exposing named parts for animation.
 *
 * Spec shape
 * ----------
 * {
 *   scale?: number,                 // uniform scale on the returned group
 *   castShadow?: boolean,
 *   parts: [{
 *     name: string,                 // key on group.parts for animation
 *     pivot?: [x, y, z],            // part origin, relative to model origin
 *     material?: 'lambert' | 'basic' | 'phong' | 'glass' | 'glow',
 *     opacity?: number,
 *     visible?: boolean,
 *     boxes: [{
 *       pos: [x, y, z],             // box centre, relative to the part pivot
 *       size: [w, h, d],
 *       color: string | number,
 *       emissive?: string | number, // 'phong'/'glow' materials only
 *     }],
 *   }],
 * }
 *
 * The model origin is the point that gets placed in the world: for characters
 * and props that is the centre of their footprint at ground level (y = 0).
 */

import * as THREE from '../../vendor/three/three.module.js';

const _color = new THREE.Color();

/**
 * How far a coincident face is pushed clear of its twin.
 *
 * Two axis-aligned boxes whose faces point the same way and sit at the same
 * coordinate put two surfaces at identical depth. The GPU then has no basis to
 * choose between them, picks per pixel, and the seam shimmers as the camera
 * moves — the taxi roof sign and the boundary hedges were both doing this.
 *
 * The camera is orthographic, so depth precision is linear and uniform: this
 * is never a near/far-plane problem, only exact coincidence. 4 mm at a tile
 * size of 1 is ~0.15 px on screen — far below anything visible, and hundreds
 * of depth-buffer steps at 24-bit.
 */
const DEPTH_SEPARATION = 0.004;

/* ------------------------------------------------------------------ *
 * Geometry construction
 * ------------------------------------------------------------------ */

// Unit cube face data: 6 faces x 2 triangles, positions in [-0.5, 0.5].
const FACES = [
  { n: [1, 0, 0], v: [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]] },
  { n: [-1, 0, 0], v: [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, 1, 0], v: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { n: [0, -1, 0], v: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
  { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]] },
];

const QUAD_ORDER = [0, 1, 2, 0, 2, 3];

/**
 * Build one non-indexed BufferGeometry from a list of coloured boxes.
 * @param {Array} boxes
 * @returns {THREE.BufferGeometry}
 */
export function buildBoxesGeometry(rawBoxes) {
  const boxes = separateCoplanarFaces(rawBoxes);
  const triCount = boxes.length * 12;
  const vertCount = triCount * 3;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  // Planar XZ mapping. Only the terrain uses it (scrolling water ripples);
  // it costs 8 bytes a vertex and keeps every mesh in one vertex layout.
  const uvs = new Float32Array(vertCount * 2);

  let p = 0;
  let q = 0;
  for (const box of boxes) {
    const [cx, cy, cz] = box.pos || [0, 0, 0];
    const [sx, sy, sz] = box.size;
    _color.set(box.color === undefined ? 0xffffff : box.color);
    const cr = _color.r;
    const cg = _color.g;
    const cb = _color.b;

    for (const face of FACES) {
      for (const idx of QUAD_ORDER) {
        const v = face.v[idx];
        positions[p] = cx + v[0] * sx;
        positions[p + 1] = cy + v[1] * sy;
        positions[p + 2] = cz + v[2] * sz;
        normals[p] = face.n[0];
        normals[p + 1] = face.n[1];
        normals[p + 2] = face.n[2];
        colors[p] = cr;
        colors[p + 1] = cg;
        colors[p + 2] = cb;
        uvs[q] = positions[p];
        uvs[q + 1] = positions[p + 2];
        p += 3;
        q += 2;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/* ------------------------------------------------------------------ *
 * Materials
 * ------------------------------------------------------------------ */

const materialCache = new Map();

/**
 * Shared vertex-colour materials. Cached by kind+opacity so the whole game
 * runs on a handful of material instances (keeps shader recompiles at zero).
 */
export function getVoxelMaterial(kind = 'lambert', opacity = 1) {
  const key = `${kind}|${opacity.toFixed(3)}`;
  const hit = materialCache.get(key);
  if (hit) return hit;

  const transparent = opacity < 1;
  let mat;
  switch (kind) {
    case 'basic':
      mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent, opacity });
      break;
    case 'phong':
      mat = new THREE.MeshPhongMaterial({
        vertexColors: true,
        transparent,
        opacity,
        shininess: 55,
        specular: 0x333333,
      });
      break;
    case 'glass':
      mat = new THREE.MeshPhongMaterial({
        vertexColors: true,
        transparent: true,
        opacity: Math.min(opacity, 0.55),
        shininess: 90,
        specular: 0x8899aa,
        depthWrite: false,
      });
      break;
    case 'glow':
      mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent,
        opacity,
        toneMapped: false,
      });
      break;
    case 'lambert':
    default:
      mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent, opacity });
      break;
  }
  materialCache.set(key, mat);
  return mat;
}

export function disposeMaterialCache() {
  for (const m of materialCache.values()) m.dispose();
  materialCache.clear();
}


/**
 * Nudge same-facing coincident faces apart so nothing z-fights.
 *
 * Faces that merely touch back-to-back are left alone — culling already
 * resolves those. When a real conflict is found the *smaller* box moves
 * outward, which is almost always the decorative one (a sign on a roof, trim
 * on a body), so it ends up sitting fractionally proud rather than sunk.
 *
 * @param {Array} boxes
 * @returns {Array} a new list; the input is not modified
 */
export function separateCoplanarFaces(boxes, passes = 8) {
  let current = boxes;
  for (let pass = 0; pass < passes; pass++) {
    const next = separateOnce(current);
    if (next === current) break; // nothing left to resolve
    current = next;
  }
  return current;
}

const EPS = 1e-6;
/** Overlap smaller than this is a hairline the eye will never resolve. */
const MIN_OVERLAP = 0.02;

/** @private One resolution pass; returns the input unchanged when clean. */
function separateOnce(boxes) {
  const n = boxes.length;
  if (n < 2) return boxes;

  const lo = [];
  const hi = [];
  const area = [];
  for (const b of boxes) {
    const [cx, cy, cz] = b.pos || [0, 0, 0];
    const [sx, sy, sz] = b.size;
    lo.push([cx - sx / 2, cy - sy / 2, cz - sz / 2]);
    hi.push([cx + sx / 2, cy + sy / 2, cz + sz / 2]);
    area.push([sy * sz, sx * sz, sx * sy]); // cross-section per axis
  }

  const overlaps = (i, j, ax) => {
    const u = (ax + 1) % 3;
    const w = (ax + 2) % 3;
    return (
      Math.min(hi[i][u], hi[j][u]) - Math.max(lo[i][u], lo[j][u]) >= MIN_OVERLAP &&
      Math.min(hi[i][w], hi[j][w]) - Math.max(lo[i][w], lo[j][w]) >= MIN_OVERLAP
    );
  };

  // shift[i][axis] = [outwardOnMin, outwardOnMax]
  const shift = boxes.map(() => [
    [0, 0],
    [0, 0],
    [0, 0],
  ]);
  let dirty = false;

  for (let ax = 0; ax < 3; ax++) {
    for (const side of [0, 1]) {
      const coord = side === 0 ? lo : hi;

      // Group every box that shares this face coordinate. Handling the whole
      // group at once matters: with three boxes on one plane, deciding pair by
      // pair moves two of them by the same amount and they stay coincident.
      const groups = new Map();
      for (let i = 0; i < n; i++) {
        const key = Math.round(coord[i][ax] / EPS);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
      }

      for (const group of groups.values()) {
        if (group.length < 2) continue;
        if (!group.some((i, k) => group.slice(k + 1).some((j) => overlaps(i, j, ax)))) continue;

        // Largest face holds the plane; the rest step outward by distinct
        // amounts, so no two of them can land on the same coordinate.
        const ranked = group.slice().sort((i, j) => area[j][ax] - area[i][ax] || i - j);
        for (let k = 1; k < ranked.length; k++) {
          shift[ranked[k]][ax][side] = k * DEPTH_SEPARATION;
          dirty = true;
        }
      }
    }
  }

  if (!dirty) return boxes;

  return boxes.map((b, i) => {
    const sh = shift[i];
    if (!sh.some((axis) => axis[0] || axis[1])) return b;
    const min = lo[i].slice();
    const max = hi[i].slice();
    for (let ax = 0; ax < 3; ax++) {
      min[ax] -= sh[ax][0];
      max[ax] += sh[ax][1];
    }
    return {
      ...b,
      pos: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    };
  });
}

/**
 * Run the coplanar pass over every part at once, in model space.
 *
 * Parts carry their own pivot, so boxes are lifted into model space, resolved
 * together, then pushed back down into each part's local frame.
 *
 * @param {Array} partList
 * @returns {Map<object, Array>} part -> adjusted boxes
 * @private
 */
function separateAcrossParts(partList) {
  const flat = [];
  const owner = [];
  for (const part of partList) {
    const [px, py, pz] = part.pivot || [0, 0, 0];
    for (const b of part.boxes || []) {
      const [cx, cy, cz] = b.pos || [0, 0, 0];
      flat.push({ ...b, pos: [px + cx, py + cy, pz + cz] });
      owner.push(part);
    }
  }

  const fixed = separateCoplanarFaces(flat);
  const out = new Map();
  for (let i = 0; i < fixed.length; i++) {
    const part = owner[i];
    const [px, py, pz] = part.pivot || [0, 0, 0];
    const [cx, cy, cz] = fixed[i].pos;
    if (!out.has(part)) out.set(part, []);
    out.get(part).push({ ...fixed[i], pos: [cx - px, cy - py, cz - pz] });
  }
  return out;
}

/**
 * Build a model from a spec.
 * @param {object} spec
 * @param {{castShadow?:boolean, receiveShadow?:boolean}} [opts]
 * @returns {THREE.Group} group with `.parts` — a name -> Object3D map.
 */
export function buildVoxelModel(spec, opts = {}) {
  const group = new THREE.Group();
  const parts = Object.create(null);
  const castShadow = opts.castShadow ?? spec.castShadow ?? true;
  const receiveShadow = opts.receiveShadow ?? spec.receiveShadow ?? false;

  // Resolve coincident faces across the *whole* model, not part by part: a
  // taxi's roof sign and the trim it sits on live in different parts, and
  // that pair was one of the visible offenders.
  const separated = separateAcrossParts(spec.parts || []);

  for (const part of spec.parts || []) {
    if (!part.boxes || part.boxes.length === 0) continue;
    const geo = buildBoxesGeometry(separated.get(part) || part.boxes);
    const mat = getVoxelMaterial(part.material || 'lambert', part.opacity ?? 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = part.name || 'part';
    const pivot = part.pivot || [0, 0, 0];
    mesh.position.set(pivot[0], pivot[1], pivot[2]);
    mesh.castShadow = part.castShadow ?? castShadow;
    mesh.receiveShadow = part.receiveShadow ?? receiveShadow;
    if (part.visible === false) mesh.visible = false;
    if (part.renderOrder !== undefined) mesh.renderOrder = part.renderOrder;
    mesh.userData.restPosition = mesh.position.clone();
    group.add(mesh);
    parts[mesh.name] = mesh;
  }

  if (spec.scale && spec.scale !== 1) group.scale.setScalar(spec.scale);
  group.parts = parts;
  group.userData.spec = spec;
  return group;
}

/**
 * Bounding box of a spec in model space, without building geometry.
 * @returns {{min:[number,number,number], max:[number,number,number], size:[number,number,number]}}
 */
export function specBounds(spec) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const part of spec.parts || []) {
    const [px, py, pz] = part.pivot || [0, 0, 0];
    for (const box of part.boxes || []) {
      const [cx, cy, cz] = box.pos || [0, 0, 0];
      const [sx, sy, sz] = box.size;
      minX = Math.min(minX, px + cx - sx / 2);
      maxX = Math.max(maxX, px + cx + sx / 2);
      minY = Math.min(minY, py + cy - sy / 2);
      maxY = Math.max(maxY, py + cy + sy / 2);
      minZ = Math.min(minZ, pz + cz - sz / 2);
      maxZ = Math.max(maxZ, pz + cz + sz / 2);
    }
  }
  const s = spec.scale ?? 1;
  return {
    min: [minX * s, minY * s, minZ * s],
    max: [maxX * s, maxY * s, maxZ * s],
    size: [(maxX - minX) * s, (maxY - minY) * s, (maxZ - minZ) * s],
  };
}

/* ------------------------------------------------------------------ *
 * Spec helpers
 * ------------------------------------------------------------------ */

/** Shallow-clone a spec with every box colour remapped through `fn`. */
export function recolorSpec(spec, fn) {
  return {
    ...spec,
    parts: (spec.parts || []).map((part) => ({
      ...part,
      boxes: (part.boxes || []).map((b) => ({ ...b, color: fn(b.color, b, part) })),
    })),
  };
}

/** Merge extra parts onto a base spec (used for hats, accessories, trails). */
export function extendSpec(spec, ...extraParts) {
  return { ...spec, parts: [...(spec.parts || []), ...extraParts.flat()] };
}

/* ------------------------------------------------------------------ *
 * Disposal
 * ------------------------------------------------------------------ */

/** Recursively dispose geometries of a subtree. Shared materials are kept. */
export function disposeObject3D(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
  });
  if (root.parent) root.parent.remove(root);
}
