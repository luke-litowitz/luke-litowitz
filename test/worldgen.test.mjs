/**
 * World generation invariants.
 *
 * These are the tests that make "the level is always beatable" a property of
 * the code rather than a hope. They run thousands of generated rows across
 * many seeds and assert the two guarantees from docs/ARCHITECTURE.md §5.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldGenerator, buildCycle, cyclePosition, ALL_COLS } from '../src/game/worldgen.js';
import { difficultyAt, minSafeGap, TRAFFIC_SPAN, LOG_GAP, MIN_WATER_VELOCITY_DELTA } from '../src/game/config.js';
import { SeededRNG } from '../src/core/math.js';
import { PLAY_COL_MIN, PLAY_COL_MAX, SAFE_ROWS, PLAYER_HALF_W, HOP_DURATION } from '../src/core/constants.js';

const SEEDS = [1, 7, 42, 1337, 90210, 555, 8675309, 2024];
const ROWS = 500;

/* ------------------------------------------------------------------ *
 * buildCycle
 * ------------------------------------------------------------------ */

test('buildCycle tiles the span exactly, so wrapping is seamless', () => {
  const rng = new SeededRNG(5);
  for (let i = 0; i < 60; i++) {
    const cycle = buildCycle(rng, {
      span: 35,
      minGap: 2 + rng.next() * 3,
      maxGap: 9,
      makeItem: () => ({ length: 1 + rng.next() * 3 }),
    });
    const items = cycle.items.slice().sort((a, b) => a.offset - b.offset);
    // Total of every item plus every gap must be the span.
    let total = 0;
    for (let k = 0; k < items.length; k++) {
      const next = items[(k + 1) % items.length];
      const raw = next.offset - (items[k].offset + items[k].length);
      const gap = ((raw % 35) + 35) % 35;
      total += items[k].length + gap;
    }
    assert.ok(Math.abs(total - 35) < 1e-6, `cycle does not tile: ${total}`);
  }
});

test('buildCycle never violates its minimum gap', () => {
  const rng = new SeededRNG(11);
  for (let i = 0; i < 80; i++) {
    const minGap = 1.5 + rng.next() * 4;
    const cycle = buildCycle(rng, {
      span: TRAFFIC_SPAN,
      minGap,
      maxGap: minGap * 3,
      makeItem: () => ({ length: 1.4 + rng.next() * 2 }),
    });
    const items = cycle.items.slice().sort((a, b) => a.offset - b.offset);
    for (let k = 0; k < items.length; k++) {
      const next = items[(k + 1) % items.length];
      const raw = next.offset - (items[k].offset + items[k].length);
      const gap = ((raw % TRAFFIC_SPAN) + TRAFFIC_SPAN) % TRAFFIC_SPAN;
      assert.ok(gap >= minGap - 1e-6, `gap ${gap} < minGap ${minGap}`);
    }
  }
});

test('buildCycle meets its coverage floor', () => {
  const rng = new SeededRNG(23);
  for (const want of [0.45, 0.55, 0.66]) {
    const cycle = buildCycle(rng, {
      span: TRAFFIC_SPAN,
      minGap: LOG_GAP[0],
      maxGap: LOG_GAP[1],
      coverage: want,
      makeItem: () => ({ length: 1 + Math.floor(rng.next() * 4) }),
    });
    assert.ok(cycle.coverage >= want - 0.02, `coverage ${cycle.coverage} < ${want}`);
  }
});

test('cyclePosition wraps without a seam and respects direction', () => {
  const span = 35;
  const startX = -span / 2;
  // Forward lane: position increases with time, then wraps to the far side.
  const a = cyclePosition(0, span, 1, 5, 0, startX);
  const b = cyclePosition(0, span, 1, 5, 1, startX);
  assert.ok(Math.abs(b - a - 5) < 1e-9);
  const wrapped = cyclePosition(0, span, 1, 5, span / 5, startX);
  assert.ok(Math.abs(wrapped - a) < 1e-9, 'one full period returns to the start');

  // Reverse lane travels the other way.
  const c = cyclePosition(0, span, -1, 5, 0, startX);
  const d = cyclePosition(0, span, -1, 5, 1, startX);
  assert.ok(d < c, 'reverse lanes must move in -X');
});

/* ------------------------------------------------------------------ *
 * Generator invariants
 * ------------------------------------------------------------------ */

test('grass rows never seal the player into a pocket', () => {
  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    // The generator's own reachable set is the authority; mirror it here
    // independently so a bug in one is caught by the other.
    let reachable = new Set(ALL_COLS);

    for (let i = 0; i < ROWS; i++) {
      const plan = gen.next(i);
      if (plan.type !== 'grass') {
        reachable = new Set(ALL_COLS);
        continue;
      }
      const blocked = new Set(plan.obstacles.map((o) => o.col));
      const free = ALL_COLS.filter((c) => !blocked.has(c));
      const landing = free.filter((c) => reachable.has(c));
      assert.ok(
        landing.length > 0,
        `seed ${seed} row ${plan.index}: no reachable landing column`,
      );

      const next = new Set();
      for (const start of landing) {
        for (let c = start; c >= PLAY_COL_MIN && !blocked.has(c); c--) next.add(c);
        for (let c = start; c <= PLAY_COL_MAX && !blocked.has(c); c++) next.add(c);
      }
      assert.ok(next.size > 0);
      reachable = next;
    }
  }
});

test('no reachable position is ever a dead end', () => {
  // Stronger than "a path exists": from every tile the player could possibly
  // be standing on, some forward move must be available after sliding within
  // the run they are in. Otherwise a pocket can trap them.
  const runsOf = (set) => {
    const cols = [...set].sort((a, b) => a - b);
    const runs = [];
    let cur = null;
    for (const c of cols) {
      if (cur && c === cur.at(-1) + 1) cur.push(c);
      else runs.push((cur = [c]));
    }
    return runs;
  };

  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    let reachable = new Set(ALL_COLS);

    for (let i = 0; i < ROWS; i++) {
      const plan = gen.next(i);
      if (plan.type !== 'grass') {
        reachable = new Set(ALL_COLS);
        continue;
      }
      const blocked = new Set(plan.obstacles.map((o) => o.col));
      const free = new Set(ALL_COLS.filter((c) => !blocked.has(c)));

      for (const run of runsOf(reachable)) {
        const exits = run.filter((c) => free.has(c));
        assert.ok(
          exits.length > 0,
          `seed ${seed} row ${plan.index}: a player anywhere in columns ` +
            `[${run[0]}..${run.at(-1)}] has no forward move — that is a soft lock`,
        );
      }

      const next = new Set();
      for (const c of reachable) {
        if (!free.has(c)) continue;
        for (let k = c; k >= PLAY_COL_MIN && free.has(k); k--) next.add(k);
        for (let k = c; k <= PLAY_COL_MAX && free.has(k); k++) next.add(k);
      }
      reachable = next;
    }
  }
});

test('every road lane leaves a survivable window', () => {
  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    for (let i = 0; i < ROWS; i++) {
      const plan = gen.next(i);
      if (plan.type !== 'road') continue;

      const diff = difficultyAt(Math.max(i, plan.index));
      const required = minSafeGap(plan.speed, diff.t);
      const items = plan.cycle.items.slice().sort((a, b) => a.offset - b.offset);
      const span = plan.cycle.span;

      for (let k = 0; k < items.length; k++) {
        const next = items[(k + 1) % items.length];
        const raw = next.offset - (items[k].offset + items[k].length);
        const gap = ((raw % span) + span) % span;
        assert.ok(
          gap >= required - 1e-6,
          `seed ${seed} row ${plan.index}: gap ${gap.toFixed(2)} < required ${required.toFixed(2)}`,
        );
        // And the window that gap buys must actually fit a hop.
        const window = (gap - 2 * PLAYER_HALF_W) / plan.speed;
        assert.ok(
          window > HOP_DURATION,
          `seed ${seed} row ${plan.index}: window ${window.toFixed(3)}s is shorter than a hop`,
        );
      }
    }
  }
});

test('water rows always carry enough platforms, with reachable gaps', () => {
  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    for (let i = 0; i < ROWS; i++) {
      const plan = gen.next(i);
      if (plan.type !== 'water') continue;

      const diff = difficultyAt(Math.max(i, plan.index));
      assert.ok(
        plan.cycle.coverage >= diff.logCoverage - 1e-6,
        `seed ${seed} row ${plan.index}: coverage ${plan.cycle.coverage.toFixed(2)}`,
      );

      const items = plan.cycle.items.slice().sort((a, b) => a.offset - b.offset);
      const span = plan.cycle.span;
      for (let k = 0; k < items.length; k++) {
        const next = items[(k + 1) % items.length];
        const raw = next.offset - (items[k].offset + items[k].length);
        const gap = ((raw % span) + span) % span;
        assert.ok(
          gap <= LOG_GAP[1] + 1e-6,
          `seed ${seed} row ${plan.index}: gap ${gap.toFixed(2)} exceeds the jumpable maximum`,
        );
      }
    }
  }
});

test('adjacent water rows always drift relative to each other', () => {
  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    let prev = null;
    for (let i = 0; i < ROWS; i++) {
      const plan = gen.next(i);
      if (plan.type !== 'water') {
        prev = null;
        continue;
      }
      if (prev !== null) {
        const delta = Math.abs(plan.velocity - prev);
        assert.ok(
          delta >= MIN_WATER_VELOCITY_DELTA - 1e-9,
          `seed ${seed} row ${plan.index}: velocity delta ${delta.toFixed(2)} — a rider could be stranded`,
        );
      }
      prev = plan.velocity;
    }
  }
});

test('rail rows leave a clear track window and carry a warning signal', () => {
  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    for (let i = 0; i < ROWS; i++) {
      const plan = gen.next(i);
      if (plan.type !== 'rail') continue;
      assert.equal(plan.cycle.items.length, 1, 'exactly one train per cycle');
      assert.ok(plan.signal, 'rail rows must be signalled');
      assert.ok(plan.warnTime >= 1.4);

      const train = plan.cycle.items[0];
      const clear = plan.cycle.span - train.length;
      const window = clear / plan.speed;
      const diff = difficultyAt(Math.max(i, plan.index));
      assert.ok(
        window >= diff.trainWindow - 1e-6,
        `seed ${seed} row ${plan.index}: only ${window.toFixed(2)}s of clear track`,
      );
    }
  }
});

test('the opening rows are always safe ground', () => {
  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    for (let i = 0; i < SAFE_ROWS + 12; i++) {
      const plan = gen.next(i);
      if (plan.index < 0) continue;
      if (plan.index < SAFE_ROWS) {
        assert.equal(plan.type, 'grass', `row ${plan.index} should be safe grass`);
        assert.equal(plan.obstacles.length, 0, `row ${plan.index} should be clear`);
      }
    }
  }
});

test('generation is deterministic for a seed', () => {
  const a = new WorldGenerator(4242);
  const b = new WorldGenerator(4242);
  for (let i = 0; i < 300; i++) {
    const pa = a.next(i);
    const pb = b.next(i);
    assert.equal(pa.type, pb.type);
    assert.equal(pa.index, pb.index);
    assert.equal(pa.speed ?? 0, pb.speed ?? 0);
    assert.equal(pa.cycle?.items.length ?? 0, pb.cycle?.items.length ?? 0);
  }
});

test('hazard runs stay within their difficulty caps and are separated by grass', () => {
  for (const seed of SEEDS) {
    const gen = new WorldGenerator(seed);
    let run = 0;
    let runType = null;
    for (let i = 0; i < ROWS; i++) {
      const plan = gen.next(i);
      if (plan.type === runType) run++;
      else {
        runType = plan.type;
        run = 1;
      }
      const diff = difficultyAt(Math.max(i, plan.index));
      const cap = {
        road: diff.maxRoadRun,
        water: diff.maxWaterRun,
        rail: diff.maxRailRun,
        grass: 99,
      }[plan.type];
      assert.ok(run <= cap, `seed ${seed}: ${plan.type} run of ${run} exceeds cap ${cap}`);
    }
  }
});

test('a long run generates a healthy mix of every row type', () => {
  const counts = { grass: 0, road: 0, water: 0, rail: 0 };
  const gen = new WorldGenerator(31337);
  for (let i = 0; i < 3000; i++) counts[gen.next(i).type]++;
  for (const [type, n] of Object.entries(counts)) {
    assert.ok(n > 60, `only ${n} ${type} rows in 3000 — generation is lopsided`);
  }
});
