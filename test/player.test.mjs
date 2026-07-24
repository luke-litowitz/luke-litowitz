/**
 * Player hop physics against a stub world.
 *
 * These lock in the rules that the whole game is balanced around: grid
 * snapping on land, continuous motion plus momentum inheritance on water,
 * exact platform carrying, and the input buffer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Player } from '../src/game/player.js';
import {
  FIXED_DT,
  HOP_DURATION,
  TILE,
  PLAY_COL_MAX,
  PLAY_COL_MIN,
  BOUND_X,
} from '../src/core/constants.js';

/* ------------------------------------------------------------------ *
 * Stub world
 * ------------------------------------------------------------------ */

function makeWorld(rows = {}) {
  const world = {
    minRow: -12,
    _rows: rows,
    rowType(i) {
      return this._rows[i]?.type ?? 'grass';
    },
    rowAt(i) {
      const r = this._rows[i] || { type: 'grass' };
      const self = this;
      return {
        type: r.type,
        index: i,
        get velocity() {
          return r.velocity || 0;
        },
        isBlocked: (col) => (r.blocked || []).includes(col),
        platformAt: (x, grip = 0) => self.platformAt(i, x, grip),
      };
    },
    isBlocked(i, col) {
      return (this._rows[i]?.blocked || []).includes(col);
    },
    platformAt(i, x, grip = 0) {
      const r = this._rows[i];
      if (!r || r.type !== 'water') return null;
      for (const p of r.platforms || []) {
        if (x >= p.x - p.halfLen - grip && x <= p.x + p.halfLen + grip) return p;
      }
      return null;
    },
  };
  return world;
}

function makeCtx(world, sink = {}) {
  return {
    world,
    onHop: () => sink.hops = (sink.hops || 0) + 1,
    onLand: (t) => (sink.lastLanding = t),
    onBlocked: () => (sink.blocked = (sink.blocked || 0) + 1),
    onDeath: (cause) => (sink.death = cause),
  };
}

/** Step the simulation for `seconds`. */
function run(player, ctx, seconds) {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) player.fixedUpdate(FIXED_DT, ctx);
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('a forward hop lands exactly one row ahead, on the grid', () => {
  const world = makeWorld();
  const sink = {};
  const p = new Player();
  const ctx = makeCtx(world, sink);

  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);

  assert.equal(p.gridRow, 1);
  assert.equal(p.x, 0);
  assert.equal(p.y, 0);
  assert.equal(p.hop.active, false);
  assert.equal(sink.lastLanding, 'grass');
});

test('the hop is a real arc: airborne in the middle, grounded at both ends', () => {
  const p = new Player();
  const ctx = makeCtx(makeWorld());
  p.requestMove('up');
  p.fixedUpdate(FIXED_DT, ctx);

  let peak = 0;
  const steps = Math.round(HOP_DURATION / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    p.fixedUpdate(FIXED_DT, ctx);
    peak = Math.max(peak, p.y);
  }
  assert.ok(peak > 0.4, `expected a real arc, peaked at ${peak}`);
  assert.ok(p.y < 0.01, `should be back on the ground, y=${p.y}`);
});

test('an obstacle rejects the hop outright — the player never leaves the tile', () => {
  const world = makeWorld({ 1: { type: 'grass', blocked: [0] } });
  const sink = {};
  const p = new Player();
  const ctx = makeCtx(world, sink);

  p.requestMove('up');
  run(p, ctx, 0.3);

  assert.equal(p.gridRow, 0, 'must not move into a blocked tile');
  assert.equal(sink.blocked, 1);
});

test('the playfield walls hold', () => {
  const p = new Player();
  const ctx = makeCtx(makeWorld());
  p.x = PLAY_COL_MAX * TILE;

  p.requestMove('right');
  run(p, ctx, 0.3);
  assert.equal(p.x, PLAY_COL_MAX * TILE);

  p.x = PLAY_COL_MIN * TILE;
  p.requestMove('left');
  run(p, ctx, 0.3);
  assert.equal(p.x, PLAY_COL_MIN * TILE);
});

test('landing in open water drowns the player', () => {
  const world = makeWorld({ 1: { type: 'water', platforms: [] } });
  const sink = {};
  const p = new Player();
  const ctx = makeCtx(world, sink);

  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);
  assert.equal(sink.death, 'water');
});

test('landing on a log attaches the player as a passenger', () => {
  const log = { x: 0, prevX: 0, halfLen: 1.5 };
  const world = makeWorld({ 1: { type: 'water', velocity: 2, platforms: [log] } });
  const p = new Player();
  const ctx = makeCtx(world, {});

  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);

  assert.equal(p.carrier, log, 'should be riding the log');
  assert.equal(p.gridRow, 1);
});

test('a rider moves by the platform’s exact displacement, never drifting off', () => {
  const log = { x: 0, prevX: 0, halfLen: 1.5 };
  const world = makeWorld({ 1: { type: 'water', velocity: 2, platforms: [log] } });
  const p = new Player();
  const ctx = makeCtx(world, {});

  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);
  assert.equal(p.carrier, log);

  const startOffset = p.x - log.x;
  // Drive the log for a second, exactly the way rows.js does.
  for (let i = 0; i < 120; i++) {
    log.prevX = log.x;
    log.x += 2 * FIXED_DT;
    p.fixedUpdate(FIXED_DT, ctx);
  }
  assert.ok(Math.abs(log.x - 2) < 1e-9, `log should have travelled 2 units, got ${log.x}`);
  assert.ok(
    Math.abs(p.x - log.x - startOffset) < 1e-9,
    `rider drifted: offset ${p.x - log.x} vs ${startOffset}`,
  );
});

test('hopping between water rows inherits the platform’s momentum', () => {
  const logA = { x: 0, prevX: 0, halfLen: 2 };
  const logB = { x: 0, prevX: 0, halfLen: 3 };
  const world = makeWorld({
    0: { type: 'water', velocity: 3, platforms: [logA] },
    1: { type: 'water', velocity: -1, platforms: [logB] },
  });
  const p = new Player();
  const ctx = makeCtx(world, {});
  p.carrier = logA;
  p.carrierRow = 0;

  p.requestMove('up');
  p.fixedUpdate(FIXED_DT, ctx);
  // Target X should be offset by the source platform's velocity * hop time.
  const expected = 0 + 3 * HOP_DURATION;
  assert.ok(
    Math.abs(p.hop.toX - expected) < 1e-9,
    `expected momentum carry to ${expected}, got ${p.hop.toX}`,
  );
});

test('landing on solid ground snaps back to the tile grid', () => {
  const world = makeWorld({
    0: { type: 'water', velocity: 2, platforms: [{ x: 0, prevX: 0, halfLen: 4 }] },
    1: { type: 'grass' },
  });
  const p = new Player();
  const ctx = makeCtx(world, {});
  p.x = 2.37; // mid-log, off-grid
  p.carrier = world._rows[0].platforms[0];
  p.carrierRow = 0;

  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);

  assert.equal(p.gridRow, 1);
  assert.equal(p.x, 2, 'x must snap to the nearest column');
  assert.equal(p.carrier, null);
});

test('drifting past the playfield edge is a void death', () => {
  const log = { x: 0, prevX: 0, halfLen: 40 };
  const world = makeWorld({ 0: { type: 'water', velocity: 6, platforms: [log] } });
  const sink = {};
  const p = new Player();
  const ctx = makeCtx(world, sink);
  p.carrier = log;
  p.carrierRow = 0;

  for (let i = 0; i < 600 && !sink.death; i++) {
    log.prevX = log.x;
    log.x += 6 * FIXED_DT;
    p.fixedUpdate(FIXED_DT, ctx);
  }
  assert.equal(sink.death, 'void');
  assert.ok(Math.abs(p.x) > BOUND_X - 0.2);
});

test('input buffered during a hop fires on landing', () => {
  const p = new Player();
  const sink = {};
  const ctx = makeCtx(makeWorld(), sink);

  p.requestMove('up');
  p.fixedUpdate(FIXED_DT, ctx);
  // Press again mid-flight.
  run(p, ctx, HOP_DURATION * 0.5);
  p.requestMove('up');
  run(p, ctx, HOP_DURATION * 0.6 + FIXED_DT);

  assert.ok(p.gridRow >= 1);
  assert.ok(p.hop.active || p.gridRow === 2, 'the buffered hop should have started');
});

test('stale buffered input is discarded', () => {
  const p = new Player();
  const ctx = makeCtx(makeWorld(), {});
  p.requestMove('up');
  p.fixedUpdate(FIXED_DT, ctx);

  p.requestMove('right');
  // Wait well past the buffer window before the hop finishes.
  p.queue[0].at -= 10;
  run(p, ctx, HOP_DURATION + FIXED_DT * 4);

  assert.equal(p.x, 0, 'a stale right-press must not fire');
});

test('score tracks the furthest row, not the current one', () => {
  const p = new Player();
  const ctx = makeCtx(makeWorld(), {});
  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);
  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);
  assert.equal(p.score, 2);

  p.requestMove('down');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);
  assert.equal(p.gridRow, 1);
  assert.equal(p.score, 2, 'retreating must not reduce the score');
});

test('the eagle idle timer only resets on real forward progress', () => {
  const p = new Player();
  const ctx = makeCtx(makeWorld(), {});
  run(p, ctx, 2);
  assert.ok(p.idleTime >= 1.9, `idle should accumulate, got ${p.idleTime}`);

  p.requestMove('up');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);
  assert.ok(p.idleTime < 0.05, 'a forward hop resets the idle timer');

  p.requestMove('right');
  run(p, ctx, HOP_DURATION + FIXED_DT * 2);
  assert.ok(p.idleTime > 0, 'a sideways hop does not');
});

test('a dead player ignores input', () => {
  const p = new Player();
  const ctx = makeCtx(makeWorld(), {});
  p.kill('car');
  p.requestMove('up');
  run(p, ctx, 0.4);
  assert.equal(p.gridRow, 0);
  assert.equal(p.deathCause, 'car');
});
