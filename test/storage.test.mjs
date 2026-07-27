/**
 * Persistence: profile migration, the coin economy and leaderboard ranking.
 *
 * A localStorage stand-in is installed before the module under test is
 * imported, because storage.js feature-detects once at load time.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ *
 * localStorage shim
 * ------------------------------------------------------------------ */

class MemoryStorage {
  constructor() {
    this.map = new Map();
    this.throwOnSet = false;
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    if (this.throwOnSet) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  key(i) {
    return [...this.map.keys()][i] ?? null;
  }
  get length() {
    return this.map.size;
  }
}

const store = new MemoryStorage();
globalThis.localStorage = store;
if (!globalThis.window) globalThis.window = globalThis;
globalThis.window.localStorage = store;

const {
  loadProfile,
  saveProfile,
  resetProfile,
  addCoins,
  spendCoins,
  unlockCharacter,
  isUnlocked,
  submitScore,
  getLeaderboard,
  clearLeaderboard,
  DEFAULT_PROFILE,
} = await import('../src/core/storage.js');

const { STORAGE_KEY, LEADERBOARD_SIZE, DEFAULT_CHARACTER } = await import(
  '../src/core/constants.js'
);

function fresh() {
  store.clear();
  return loadProfile();
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

test('a first-run profile has sane defaults', () => {
  const p = fresh();
  assert.equal(p.coins, 0);
  assert.equal(p.bestScore, 0);
  assert.equal(p.selected, DEFAULT_CHARACTER);
  assert.ok(Array.isArray(p.unlocked));
  assert.ok(p.unlocked.includes(DEFAULT_CHARACTER), 'the starter must be unlocked');
  assert.ok(Array.isArray(p.leaderboard));
  assert.equal(typeof p.settings, 'object');
});

test('DEFAULT_PROFILE cannot be mutated through a loaded profile', () => {
  const p = fresh();
  p.coins = 999;
  p.unlocked.push('dragon');
  const q = fresh();
  assert.equal(q.coins, 0);
  assert.ok(!q.unlocked.includes('dragon'), 'the template leaked');
  assert.equal(DEFAULT_PROFILE.coins, 0);
});

test('corrupt JSON falls back to defaults instead of throwing', () => {
  store.clear();
  store.setItem(STORAGE_KEY, '{not json at all');
  const p = loadProfile();
  assert.equal(p.coins, 0);
  assert.equal(p.selected, DEFAULT_CHARACTER);
});

test('a truncated or wrongly typed profile is repaired, not discarded', () => {
  store.clear();
  store.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      coins: '250',
      bestScore: -12,
      unlocked: ['chicken', 'duck'],
      selected: 'duck',
      leaderboard: null,
    }),
  );
  const p = loadProfile();
  assert.equal(typeof p.coins, 'number');
  assert.equal(p.coins, 250, 'a numeric string should be coerced, not dropped');
  assert.ok(p.bestScore >= 0, 'negatives are clamped');
  assert.ok(Array.isArray(p.unlocked));
  assert.ok(Array.isArray(p.leaderboard));
  assert.equal(p.selected, 'duck', 'valid fields survive the repair');
});

test('a non-array unlocked list is replaced with the default', () => {
  store.clear();
  store.setItem(STORAGE_KEY, JSON.stringify({ version: 1, unlocked: 'chicken' }));
  const p = loadProfile();
  assert.ok(Array.isArray(p.unlocked));
  assert.ok(p.unlocked.includes(DEFAULT_CHARACTER));
});

test('a selected character the player does not own falls back to the starter', () => {
  store.clear();
  store.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 1, unlocked: ['chicken'], selected: 'dragon' }),
  );
  const p = loadProfile();
  assert.equal(p.selected, DEFAULT_CHARACTER, 'must not select a locked character');
});

test('a profile from a newer version keeps whatever parses', () => {
  store.clear();
  store.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 99, coins: 1234, unlocked: ['chicken', 'fox'], somethingNew: true }),
  );
  const p = loadProfile();
  assert.equal(p.coins, 1234, 'a future version must not wipe progress');
  assert.ok(p.unlocked.includes('fox'));
});

test('unlocked is deduped', () => {
  store.clear();
  store.setItem(
    STORAGE_KEY,
    JSON.stringify({ version: 1, unlocked: ['chicken', 'fox', 'fox', 'chicken'] }),
  );
  const p = loadProfile();
  assert.equal(new Set(p.unlocked).size, p.unlocked.length);
});

test('coins: add, spend, and refuse to overdraw', () => {
  const p = fresh();
  addCoins(p, 100);
  assert.equal(p.coins, 100);
  assert.equal(spendCoins(p, 40), true);
  assert.equal(p.coins, 60);
  assert.equal(spendCoins(p, 61), false, 'must not allow a negative balance');
  assert.equal(p.coins, 60);
  assert.equal(spendCoins(p, 60), true);
  assert.equal(p.coins, 0);
});

test('unlocking is idempotent', () => {
  const p = fresh();
  assert.equal(isUnlocked(p, 'fox'), false);
  unlockCharacter(p, 'fox');
  unlockCharacter(p, 'fox');
  assert.equal(isUnlocked(p, 'fox'), true);
  assert.equal(p.unlocked.filter((x) => x === 'fox').length, 1);
});

test('submitScore ranks correctly and tracks the best', () => {
  const p = fresh();
  const first = submitScore(p, { score: 40, coins: 5, character: 'chicken', biome: 'meadow' });
  assert.equal(first.rank, 1);
  assert.equal(first.isBest, true);
  assert.equal(p.bestScore, 40);

  const worse = submitScore(p, { score: 10, coins: 1, character: 'chicken', biome: 'meadow' });
  assert.equal(worse.rank, 2);
  assert.equal(worse.isBest, false);
  assert.equal(p.bestScore, 40);

  const better = submitScore(p, { score: 120, coins: 9, character: 'fox', biome: 'sunset' });
  assert.equal(better.rank, 1);
  assert.equal(better.isBest, true);
  assert.equal(p.bestScore, 120);

  const board = getLeaderboard(p);
  assert.deepEqual(board.map((e) => e.score), [120, 40, 10]);
  assert.equal(p.totalRuns, 3);
});

test('the leaderboard is capped and drops the weakest entry', () => {
  const p = fresh();
  for (let i = 1; i <= LEADERBOARD_SIZE + 8; i++) {
    submitScore(p, { score: i * 10, coins: i, character: 'chicken', biome: 'meadow' });
  }
  const board = getLeaderboard(p);
  assert.equal(board.length, LEADERBOARD_SIZE);
  assert.equal(board[0].score, (LEADERBOARD_SIZE + 8) * 10);
  // Everything left must beat what fell off the bottom.
  assert.ok(board[board.length - 1].score > 80);

  const missed = submitScore(p, { score: 1, coins: 0, character: 'chicken', biome: 'meadow' });
  assert.equal(missed.rank, null, 'a score that misses the board has no rank');
  assert.equal(getLeaderboard(p).length, LEADERBOARD_SIZE);
});

test('leaderboard entries carry unique ids', () => {
  const p = fresh();
  for (let i = 0; i < 8; i++) {
    submitScore(p, { score: 50, coins: 1, character: 'chicken', biome: 'meadow' });
  }
  const ids = getLeaderboard(p).map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids would break UI keying');
});

test('getLeaderboard hands back a copy', () => {
  const p = fresh();
  submitScore(p, { score: 30, coins: 2, character: 'chicken', biome: 'meadow' });
  const board = getLeaderboard(p);
  board.length = 0;
  board.push({ score: 99999 });
  assert.equal(getLeaderboard(p).length, 1);
  assert.equal(getLeaderboard(p)[0].score, 30);
});

test('clearLeaderboard empties the board but keeps the wallet', () => {
  const p = fresh();
  addCoins(p, 77);
  submitScore(p, { score: 30, coins: 2, character: 'chicken', biome: 'meadow' });
  clearLeaderboard(p);
  assert.equal(getLeaderboard(p).length, 0);
  // submitScore records a run; crediting the wallet is the game's job.
  assert.equal(p.coins, 77, 'the wallet is untouched by clearing the board');
  assert.equal(p.totalRuns, 1, 'lifetime stats survive a board wipe');
});

test('a storage write failure never throws out of saveProfile', () => {
  const p = fresh();
  store.throwOnSet = true;
  try {
    assert.doesNotThrow(() => saveProfile(p));
    addCoins(p, 5);
    assert.doesNotThrow(() => saveProfile(p));
  } finally {
    store.throwOnSet = false;
  }
});

test('resetProfile wipes back to defaults', () => {
  const p = fresh();
  addCoins(p, 500);
  unlockCharacter(p, 'dragon');
  const q = resetProfile();
  assert.equal(q.coins, 0);
  assert.ok(!q.unlocked.includes('dragon'));
});
