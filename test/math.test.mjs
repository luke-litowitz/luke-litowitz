/**
 * Physics primitives. These are the functions every collision in the game
 * funnels through, so they get exhaustive coverage.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  lerp,
  smoothstep,
  damp,
  angleDelta,
  makeAABB,
  aabbOverlap,
  sweptAABB,
  hopArc,
  hopEase,
  SeededRNG,
  colToX,
  rowToZ,
  xToCol,
  zToRow,
  hash01,
} from '../src/core/math.js';

test('clamp / lerp / smoothstep behave at the edges', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(lerp(0, 10, 0.25), 2.5);
  assert.equal(smoothstep(0, 1, 0), 0);
  assert.equal(smoothstep(0, 1, 1), 1);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
});

test('damp is frame-rate independent', () => {
  // Two half-steps must land in the same place as one full step.
  const one = damp(0, 1, 5, 0.2);
  let two = damp(0, 1, 5, 0.1);
  two = damp(two, 1, 5, 0.1);
  assert.ok(Math.abs(one - two) < 1e-12, `${one} vs ${two}`);
});

test('angleDelta takes the short way round', () => {
  assert.ok(Math.abs(angleDelta(0.1, Math.PI * 2 - 0.1) - -0.2) < 1e-9);
  assert.ok(Math.abs(angleDelta(0, Math.PI / 2) - Math.PI / 2) < 1e-9);
});

test('grid conversion round-trips', () => {
  for (let c = -9; c <= 9; c++) assert.equal(xToCol(colToX(c)), c);
  for (let r = -5; r <= 30; r++) assert.equal(zToRow(rowToZ(r)), r);
  assert.equal(rowToZ(3), -3, 'forward rows go toward -Z');
});

test('hop arc is a true parabola with matched take-off and landing', () => {
  assert.equal(hopArc(0), 0);
  assert.equal(hopArc(1), 0);
  assert.equal(hopArc(0.5), 1);
  // Symmetric about the apex.
  for (let t = 0; t <= 0.5; t += 0.05) {
    assert.ok(Math.abs(hopArc(t) - hopArc(1 - t)) < 1e-12);
  }
});

test('hop easing is monotonic and spans exactly 0..1', () => {
  assert.equal(hopEase(0), 0);
  assert.equal(hopEase(1), 1);
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const v = hopEase(t);
    assert.ok(v >= prev - 1e-12, `not monotonic at ${t}`);
    prev = v;
  }
});

test('aabbOverlap is exclusive at touching edges', () => {
  const a = makeAABB(0, 0, 0.5, 0.5);
  const b = makeAABB(1, 0, 0.5, 0.5);
  assert.equal(aabbOverlap(a, b), false, 'edge contact is not an overlap');
  const c = makeAABB(0.99, 0, 0.5, 0.5);
  assert.equal(aabbOverlap(a, c), true);
});

test('sweptAABB finds the exact time of first contact', () => {
  const player = makeAABB(0, 0, 0.5, 0.5);
  const wall = makeAABB(5, 0, 0.5, 0.5);
  const hit = sweptAABB(player, 10, 0, wall);
  assert.ok(hit, 'should hit');
  // Faces meet when the player has travelled 4 of its 10 units.
  assert.ok(Math.abs(hit.t - 0.4) < 1e-9, `t=${hit.t}`);
  assert.equal(hit.nx, -1);
});

test('sweptAABB does not tunnel at high speed', () => {
  const player = makeAABB(0, 0, 0.3, 0.3);
  const car = makeAABB(20, 0, 0.85, 0.45);
  // A single step that skips clean over the car without sweeping.
  const hit = sweptAABB(player, 40, 0, car);
  assert.ok(hit, 'swept test must catch the pass-through');
  assert.ok(hit.t > 0 && hit.t < 1);
});

test('sweptAABB misses when the boxes never share an axis span', () => {
  const player = makeAABB(0, 0, 0.3, 0.3);
  const car = makeAABB(5, 3, 0.85, 0.45);
  assert.equal(sweptAABB(player, 10, 0, car), null);
});

test('sweptAABB reports an existing overlap as immediate contact', () => {
  const a = makeAABB(0, 0, 0.5, 0.5);
  const b = makeAABB(0.2, 0, 0.5, 0.5);
  const hit = sweptAABB(a, 1, 0, b);
  assert.ok(hit);
  assert.equal(hit.t, 0);
});

test('sweptAABB ignores objects moving away', () => {
  const a = makeAABB(0, 0, 0.5, 0.5);
  const b = makeAABB(5, 0, 0.5, 0.5);
  assert.equal(sweptAABB(a, -10, 0, b), null);
});

test('relative-motion sweep catches a car driving into a stationary player', () => {
  const player = makeAABB(0, 0, 0.3, 0.3);
  const car = makeAABB(-6, 0, 0.85, 0.45);
  const dt = 1 / 120;
  const carV = 8;
  // Advance the car frame by frame; the player never moves.
  let hitFrame = -1;
  let carX = -6;
  for (let i = 0; i < 200; i++) {
    const b = makeAABB(carX, 0, 0.85, 0.45);
    const rel = -carV * dt; // player displacement minus car displacement
    if (sweptAABB(player, rel, 0, b)) {
      hitFrame = i;
      break;
    }
    carX += carV * dt;
  }
  assert.ok(hitFrame > 0, 'the car must eventually hit');
  // Contact should happen right as the faces meet: 6 - 0.85 - 0.3 = 4.85 units.
  const travelled = hitFrame * carV * dt;
  assert.ok(Math.abs(travelled - 4.85) < 0.15, `travelled ${travelled}`);
});

test('SeededRNG is deterministic and uniform enough', () => {
  const a = new SeededRNG(12345);
  const b = new SeededRNG(12345);
  for (let i = 0; i < 100; i++) assert.equal(a.next(), b.next());

  const r = new SeededRNG(7);
  let sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / N - 0.5) < 0.02, `mean ${sum / N}`);
});

test('SeededRNG.int covers the inclusive range and never escapes it', () => {
  const r = new SeededRNG(99);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = r.int(1, 4);
    assert.ok(Number.isInteger(v));
    assert.ok(v >= 1 && v <= 4, `out of range: ${v}`);
    seen.add(v);
  }
  assert.equal(seen.size, 4, 'every value in the range should appear');
});

test('SeededRNG.weighted respects zero weights', () => {
  const r = new SeededRNG(3);
  const entries = [
    { id: 'never', weight: 0 },
    { id: 'always', weight: 1 },
  ];
  for (let i = 0; i < 200; i++) assert.equal(r.weighted(entries).id, 'always');
});

test('SeededRNG.reset replays the same stream', () => {
  const r = new SeededRNG(42);
  const first = [r.next(), r.next(), r.next()];
  r.reset(42);
  assert.deepEqual([r.next(), r.next(), r.next()], first);
});

test('hash01 is stable and in range', () => {
  for (let i = -50; i < 50; i++) {
    const v = hash01(i, 3);
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, hash01(i, 3));
  }
});
