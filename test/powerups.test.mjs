/**
 * Power-up runtime: timers, effect stacking, and the jetpack's landing veto.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PowerupSystem } from '../src/game/powerups.js';
import { POWERUPS, getPowerup, rollPowerup, powerupSpawnChance } from '../src/data/powerups.js';
import { SeededRNG } from '../src/core/math.js';
import {
  COIN_MAGNET_RADIUS,
  COIN_MAGNET_BASE,
  DIFFICULTY_MAX_SCORE,
} from '../src/core/constants.js';

const step = (sys, seconds, hold) => {
  const dt = 1 / 120;
  for (let i = 0; i < Math.round(seconds / dt); i++) sys.fixedUpdate(dt, hold);
};

test('every documented power-up exists with a usable definition', () => {
  const ids = POWERUPS.map((p) => p.id).sort();
  assert.deepEqual(ids, ['doubler', 'jetpack', 'magnet', 'shield', 'slowmo']);
  for (const p of POWERUPS) {
    assert.ok(p.name && p.icon && p.color, `${p.id} is missing presentation fields`);
    assert.ok(p.duration > 0, `${p.id} has no duration`);
    assert.equal(typeof p.build, 'function');
    const spec = p.build();
    const names = spec.parts.map((x) => x.name);
    assert.ok(names.includes('core'), `${p.id} crate is missing a 'core' part`);
    assert.ok(names.includes('shell'), `${p.id} crate is missing a 'shell' part`);
  }
});

test('getPowerup is total over known ids and safe on unknown ones', () => {
  for (const p of POWERUPS) assert.equal(getPowerup(p.id).id, p.id);
  assert.ok(!getPowerup('nonsense'));
});

test('rollPowerup is deterministic and only returns real ids', () => {
  const a = new SeededRNG(9);
  const b = new SeededRNG(9);
  const known = new Set(POWERUPS.map((p) => p.id));
  for (let i = 0; i < 500; i++) {
    const x = rollPowerup(a, i);
    assert.equal(x, rollPowerup(b, i));
    assert.ok(known.has(x), `unknown id ${x}`);
  }
});

test('the jetpack stays rare at every score', () => {
  for (const score of [0, 50, 150, 320, 1000]) {
    const rng = new SeededRNG(4);
    let jet = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (rollPowerup(rng, score) === 'jetpack') jet++;
    assert.ok(jet / N < 0.15, `jetpack rate ${(jet / N).toFixed(3)} at score ${score}`);
  }
});

test('survival tools get more common as the run gets harder', () => {
  const rate = (score, id) => {
    const rng = new SeededRNG(21);
    let n = 0;
    for (let i = 0; i < 4000; i++) if (rollPowerup(rng, score) === id) n++;
    return n / 4000;
  };
  assert.ok(rate(DIFFICULTY_MAX_SCORE, 'shield') > rate(0, 'shield'));
  assert.ok(rate(DIFFICULTY_MAX_SCORE, 'slowmo') > rate(0, 'slowmo'));
});

test('spawn chance eases up with score and stays bounded', () => {
  const lo = powerupSpawnChance(0);
  const hi = powerupSpawnChance(DIFFICULTY_MAX_SCORE);
  assert.ok(lo > 0.02 && lo < 0.08, `low end ${lo}`);
  assert.ok(hi > lo && hi < 0.2, `high end ${hi}`);
  assert.equal(powerupSpawnChance(99999) <= hi + 1e-9, true, 'must not run away past the cap');
});

test('activating a power-up applies its effect, then expires', () => {
  const expired = [];
  const sys = new PowerupSystem((id) => expired.push(id));

  sys.activate('doubler');
  assert.equal(sys.coinMultiplier, 2);
  step(sys, getPowerup('doubler').duration + 0.2);
  assert.equal(sys.coinMultiplier, 1);
  assert.deepEqual(expired, ['doubler']);
});

test('effects stack independently', () => {
  const sys = new PowerupSystem();
  sys.activate('doubler');
  sys.activate('magnet');
  sys.activate('slowmo');
  assert.equal(sys.coinMultiplier, 2);
  assert.ok(sys.magnetRadius > 0);
  assert.ok(sys.timeScale < 1);
  assert.equal(sys.hudList().length, 3);
});

test('re-collecting refreshes the timer instead of stacking it', () => {
  const sys = new PowerupSystem();
  sys.activate('magnet');
  step(sys, 3);
  const mid = sys.remaining('magnet');
  sys.activate('magnet');
  assert.equal(sys.remaining('magnet'), getPowerup('magnet').duration);
  assert.ok(sys.remaining('magnet') > mid);
  assert.equal(sys.hudList().length, 1, 'a refresh must not create a second entry');
});

test('the shield is consumed once and only once', () => {
  const expired = [];
  const sys = new PowerupSystem((id) => expired.push(id));
  sys.activate('shield');
  assert.equal(sys.consumeShield(), true);
  assert.equal(sys.consumeShield(), false, 'a spent shield cannot absorb a second hit');
  assert.deepEqual(expired, ['shield']);
});

test('coins sit still until the magnet power-up is picked up', () => {
  const sys = new PowerupSystem();
  assert.equal(sys.magnetRadius, COIN_MAGNET_BASE);
  assert.equal(COIN_MAGNET_BASE, 0, 'coins drifting toward the player reads as a bug');
  sys.activate('magnet');
  assert.equal(sys.magnetRadius, COIN_MAGNET_RADIUS);
  assert.ok(COIN_MAGNET_RADIUS > 2, 'the power-up has to be worth picking up');
});

test('the magnet radius honours a character perk multiplier', () => {
  const sys = new PowerupSystem();
  sys.magnetMultiplier = 1.15;
  sys.activate('magnet');
  assert.ok(Math.abs(sys.magnetRadius - COIN_MAGNET_RADIUS * 1.15) < 1e-9);
});

test('the jetpack refuses to expire over open water', () => {
  const sys = new PowerupSystem();
  sys.activate('jetpack');
  let overWater = true;
  const hold = (id) => id === 'jetpack' && overWater;

  step(sys, getPowerup('jetpack').duration + 4, hold);
  assert.equal(sys.flying, true, 'dropping the player into a river would be unfair');

  overWater = false;
  step(sys, 0.5, hold);
  assert.equal(sys.flying, false, 'it must end once there is ground to land on');
});

test('the hold veto only applies to the power-up that asked for it', () => {
  const sys = new PowerupSystem();
  sys.activate('jetpack');
  sys.activate('magnet');
  const hold = (id) => id === 'jetpack';
  step(sys, Math.max(getPowerup('magnet').duration, getPowerup('jetpack').duration) + 1, hold);
  assert.equal(sys.has('magnet'), false);
  assert.equal(sys.has('jetpack'), true);
});

test('timers run on real time, so slow-motion cannot extend itself', () => {
  const sys = new PowerupSystem();
  sys.activate('slowmo');
  const d = getPowerup('slowmo').duration;
  step(sys, d - 0.1);
  assert.equal(sys.has('slowmo'), true);
  step(sys, 0.3);
  assert.equal(sys.has('slowmo'), false);
});

test('reset clears everything', () => {
  const sys = new PowerupSystem();
  sys.activate('shield');
  sys.activate('magnet');
  sys.reset();
  assert.equal(sys.hudList().length, 0);
  assert.equal(sys.magnetRadius, COIN_MAGNET_BASE, 'reset leaves no lingering pull');
  assert.equal(sys.timeScale, 1);
  assert.equal(sys.consumeShield(), false);
});

test('the HUD list carries what the HUD needs', () => {
  const sys = new PowerupSystem();
  sys.activate('shield');
  step(sys, 1);
  const [entry] = sys.hudList();
  assert.equal(entry.id, 'shield');
  assert.ok(entry.icon);
  assert.ok(entry.color);
  assert.ok(entry.remaining > 0 && entry.remaining < entry.duration);
  assert.ok(entry.progress > 0 && entry.progress < 1);
});
