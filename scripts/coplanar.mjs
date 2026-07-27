#!/usr/bin/env node
/**
 * Find z-fighting before it reaches the screen.
 *
 * Everything in the game is axis-aligned boxes. Two boxes whose faces point
 * the *same* way and sit at the *same* coordinate, overlapping in the other
 * two axes, put two surfaces at identical depth — the GPU then picks a winner
 * per pixel and the seam shimmers as the camera moves. (Faces that merely
 * touch back-to-back are fine: backface culling drops the hidden one.)
 *
 * An orthographic camera has linear depth precision, so this is never a
 * precision problem that a tighter near/far plane would fix. It is always
 * exact coincidence, and it is cheap to detect.
 *
 *   node scripts/coplanar.mjs
 */

import { CHARACTERS, characterSpec } from '../src/data/characters.js';
import { POWERUPS } from '../src/data/powerups.js';
import * as models from '../src/render/models.js';
import { SeededRNG } from '../src/core/math.js';
import { separateCoplanarFaces } from '../src/render/voxel.js';

const EPS = 1e-6;
/** Overlap smaller than this is a hairline the eye will never resolve. */
const MIN_OVERLAP = 0.02;

/**
 * Flatten a spec's parts into model-space boxes, *after* the same separation
 * pass the renderer applies — otherwise this measures the source data rather
 * than what actually reaches the screen.
 */
function boxesOf(spec) {
  const flat = [];
  const names = [];
  for (const part of spec.parts || []) {
    const [px, py, pz] = part.pivot || [0, 0, 0];
    for (const b of part.boxes || []) {
      const [cx, cy, cz] = b.pos || [0, 0, 0];
      flat.push({ ...b, pos: [px + cx, py + cy, pz + cz] });
      names.push(part.name);
    }
  }

  return separateCoplanarFaces(flat).map((b, i) => {
    const [cx, cy, cz] = b.pos;
    const [sx, sy, sz] = b.size;
    return {
      part: names[i],
      min: [cx - sx / 2, cy - sy / 2, cz - sz / 2],
      max: [cx + sx / 2, cy + sy / 2, cz + sz / 2],
    };
  });
}

const AXIS = ['x', 'y', 'z'];

/** Overlap length of two intervals, negative when they are apart. */
const span = (aMin, aMax, bMin, bMax) => Math.min(aMax, bMax) - Math.max(aMin, bMin);

function findCoplanar(spec) {
  const boxes = boxesOf(spec);
  const hits = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      for (let ax = 0; ax < 3; ax++) {
        const u = (ax + 1) % 3;
        const v = (ax + 2) % 3;
        const ou = span(a.min[u], a.max[u], b.min[u], b.max[u]);
        const ov = span(a.min[v], a.max[v], b.min[v], b.max[v]);
        if (ou < MIN_OVERLAP || ov < MIN_OVERLAP) continue;

        // Same-facing coplanar pairs only. min==max between the two boxes is
        // a back-to-back touch, which culling resolves.
        for (const side of ['min', 'max']) {
          if (Math.abs(a[side][ax] - b[side][ax]) < EPS) {
            hits.push({
              axis: AXIS[ax],
              side,
              at: +a[side][ax].toFixed(4),
              parts: [a.part, b.part],
              overlap: +Math.min(ou, ov).toFixed(3),
            });
          }
        }
      }
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ */

const rng = new SeededRNG(1);
const subjects = [];

for (const c of CHARACTERS) subjects.push([`character:${c.id}`, characterSpec(c.id)]);
for (const p of POWERUPS) subjects.push([`powerup:${p.id}`, p.build()]);

for (const [name, spec] of [
  ['car:0', models.carSpec('#e8453c', 0)],
  ['car:1', models.carSpec('#3d7de8', 1)],
  ['car:2', models.carSpec('#f5c542', 2)],
  ['car:3', models.carSpec('#2fbfa8', 3)],
  ['truck', models.truckSpec('#e34b4b')],
  ['bus', models.busSpec('#f2b32e')],
  ['train:engine', models.trainCarSpec('engine')],
  ['train:car', models.trainCarSpec('car')],
  ['log:1', models.logSpec(1)],
  ['log:3', models.logSpec(3)],
  ['lilypad', models.lilypadSpec(true)],
  ['coin', models.coinSpec()],
  ['signal', models.signalSpec()],
  ['eagle', models.eagleSpec()],
  ['crate', models.crateSpec('#ffffff')],
]) {
  subjects.push([name, spec]);
}
for (const t of models.VEHICLE_TYPES) {
  if (typeof t.spec === 'function') subjects.push([`vehicle:${t.id}`, t.spec('#e8453c')]);
}
for (let v = 0; v < 3; v++) subjects.push([`tree:${v}`, models.treeSpec(v, rng.reset(1000 + v))]);
subjects.push(['rock', models.rockSpec(rng.reset(2000))]);
subjects.push(['bush', models.bushSpec(rng.reset(3000))]);

let total = 0;
const offenders = [];
for (const [name, spec] of subjects) {
  const hits = findCoplanar(spec);
  if (!hits.length) continue;
  total += hits.length;
  offenders.push([name, hits]);
}

if (offenders.length === 0) {
  console.log(`no coplanar faces in ${subjects.length} models`);
} else {
  console.log(`${total} coplanar face pair(s) across ${offenders.length} model(s):\n`);
  for (const [name, hits] of offenders) {
    console.log(`  ${name}`);
    for (const h of hits.slice(0, 6)) {
      console.log(
        `    ${h.side} ${h.axis} = ${h.at}  ${h.parts.join(' / ')}  (overlap ${h.overlap})`,
      );
    }
    if (hits.length > 6) console.log(`    …and ${hits.length - 6} more`);
  }
  process.exitCode = 1;
}
