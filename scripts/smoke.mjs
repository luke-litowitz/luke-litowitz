#!/usr/bin/env node
/**
 * Headless smoke test.
 *
 * Boots the real game in Chromium, drives it with real key events, and fails
 * on any console error, page error or failed request. Also captures
 * screenshots of every screen so a visual regression is obvious.
 *
 *   node scripts/smoke.mjs [--shots screenshots/] [--keep]
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = join(ROOT, 'screenshots');

const problems = [];
const log = (...a) => console.log(...a);

/**
 * Wait until a screen's entrance animation has actually landed.
 *
 * Under software GL the page paints a couple of frames a second, so a CSS
 * animation can take seconds of wall-clock to start. Screenshotting before it
 * settles produces a half-faded panel that looks like a styling bug. Waiting
 * on the real computed opacity also guards the styling itself: if a screen
 * ever ends up stuck transparent, this is where it shows up.
 */
async function settle(page, screen, timeout = 15000) {
  try {
    await page.waitForFunction(
      (name) => {
        const el = document.querySelector(`[data-screen="${name}"]`);
        if (!el || el.hidden) return false;
        if (Number(getComputedStyle(el).opacity) < 0.99) return false;
        return el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
      },
      screen,
      { timeout },
    );
    return true;
  } catch {
    const state = await page.evaluate((name) => {
      const el = document.querySelector(`[data-screen="${name}"]`);
      return el ? { hidden: el.hidden, opacity: getComputedStyle(el).opacity } : null;
    }, screen);
    problems.push(`screen "${screen}" never settled visible: ${JSON.stringify(state)}`);
    return false;
  }
}

function startServer() {
  const proc = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('running at')) {
        clearTimeout(timer);
        res(proc);
      }
    });
    proc.on('error', rej);
  });
}

async function main() {
  await mkdir(SHOT_DIR, { recursive: true });
  const server = await startServer();
  log(`server up on ${BASE}`);

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  page.on('console', (msg) => {
    const t = msg.type();
    const text = msg.text();
    if (t === 'error') problems.push(`console.error: ${text}`);
    else if (t === 'warning' && !/WebGL|SwiftShader|deprecat/i.test(text)) {
      log(`  warn: ${text}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) =>
    problems.push(`request failed: ${req.url()} (${req.failure()?.errorText})`),
  );

  log('loading…');
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => !!window.__crossy, null, { timeout: 20000 });
  await settle(page, 'menu');
  await page.screenshot({ path: join(SHOT_DIR, '01-menu.png') });

  // One shared autopilot for every scripted pass below. It is deliberately
  // simple but competent: aim at a column that is free in the next row, wait
  // for a log before committing to water, and never bounce between two rules.
  await page.evaluate(() => {
    window.__bot = (stats) => {
      const g = window.__crossy.game;
      const p = g.player;
      if (p.hop.active) return;
      const W = g.world;
      const col = Math.round(p.x);
      const next = p.gridRow + 1;
      const type = W.rowType(next);
      if (type === null) return;

      if (type === 'water') {
        const carry = p.carrier ? (W.rowAt(p.carrierRow)?.velocity || 0) * 0.15 : 0;
        if (!W.platformAt(next, p.x + carry, 0)) { stats.waterWait++; return; }
        stats.forward++;
        g.handleMove('up');
        return;
      }

      if (Math.abs(col) <= 8 && !W.isBlocked(next, col)) {
        stats.forward++;
        g.handleMove('up');
        return;
      }

      // Blocked (or pushed outside): walk toward the nearest column that is
      // free ahead, preferring the side that also heads back to the middle.
      const prefer = col > 0 ? -1 : 1;
      for (let d = 1; d <= 17; d++) {
        for (const side of [prefer, -prefer]) {
          const target = col + side * d;
          if (target < -8 || target > 8) continue;
          if (W.isBlocked(next, target)) continue;
          const step = Math.max(-8, Math.min(8, col + side));
          if (W.isBlocked(p.gridRow, step)) continue;
          stats.side++;
          g.handleMove(side < 0 ? 'left' : 'right');
          return;
        }
      }
      stats.stuck++;
      g.handleMove('up');
    };
  });

  /* --- Menu screens ------------------------------------------------ */
  for (const [screen, shot] of [
    ['characters', '02-characters.png'],
    ['leaderboard', '03-leaderboard.png'],
    ['settings', '04-settings.png'],
  ]) {
    await page.evaluate((s) => window.__crossy.ui.show(s), screen);
    await settle(page, screen);
    await page.screenshot({ path: join(SHOT_DIR, shot) });
    const visible = await page.evaluate((s) => window.__crossy.ui.current === s, screen);
    if (!visible) problems.push(`screen "${screen}" did not become current`);
  }

  const previewLive = await page.evaluate(() => {
    const mount = document.querySelector('[data-char-preview]');
    const canvas = mount?.querySelector('canvas');
    return { mounted: !!canvas, w: canvas?.width || 0, h: canvas?.height || 0 };
  });
  if (!previewLive.mounted) problems.push('the character preview canvas never mounted');
  else if (previewLive.w < 2 || previewLive.h < 2) {
    problems.push(`character preview has no size: ${JSON.stringify(previewLive)}`);
  }
  await page.evaluate(() => window.__crossy.ui.show('menu'));

  /* --- Play -------------------------------------------------------- */
  log('starting a run…');
  await page.evaluate(() => window.__crossy.game.start());
  await page.waitForTimeout(400);

  // Real key events, to prove the input path is wired end to end.
  const beforeKeys = await page.evaluate(() => window.__crossy.game.player.hopCount);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(220);
  }
  const afterKeys = await page.evaluate(() => window.__crossy.game.player.hopCount);
  if (afterKeys <= beforeKeys) problems.push('arrow keys did not reach the player');
  log(`  keyboard produced ${afterKeys - beforeKeys} hops`);

  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOT_DIR, '05-playing.png') });

  const snap = await page.evaluate(() => {
    const g = window.__crossy.game;
    return {
      state: g.state,
      rows: g.world.rows.size,
      minRow: g.world.minRow,
      maxRow: g.world.maxRow,
      x: g.player.x,
      y: g.player.y,
      hops: g.player.hopCount,
      biome: g.biome.id,
    };
  });
  log('  snapshot:', JSON.stringify(snap));

  if (!Number.isFinite(snap.x) || !Number.isFinite(snap.y)) {
    problems.push(`player position is not finite: ${JSON.stringify(snap)}`);
  }
  if (snap.rows < 20) problems.push(`only ${snap.rows} rows streamed in`);

  /* --- Pause ------------------------------------------------------- */
  await page.evaluate(() => window.__crossy.game.pause());
  await settle(page, 'paused');
  await page.screenshot({ path: join(SHOT_DIR, '06-paused.png') });
  const paused = await page.evaluate(() => window.__crossy.game.state);
  if (paused !== 'paused') problems.push(`pause did not take: state=${paused}`);
  await page.evaluate(() => window.__crossy.game.resume());

  /* --- Simulation soak ---------------------------------------------
   * Rendering is the bottleneck under software GL, and it is not what we are
   * testing here. Step the simulation directly so the soak covers tens of
   * thousands of physics steps — every hazard type, biome change, recycle
   * pass and death path — in a couple of seconds.
   */
  log('soaking the simulation for 60 000 steps (~8 minutes of play)…');
  const soak = await page.evaluate(() => {
    const g = window.__crossy.game;
    const DT = 1 / 120;
    const seen = { biomes: new Set(), causes: new Set(), rowTypes: new Set() };
    let maxRows = 0;
    let maxScore = 0;
    let deaths = 0;
    let nan = null;

    const stats = { forward: 0, side: 0, waterWait: 0, stuck: 0 };
    g.start();
    for (let i = 0; i < 60000; i++) {
      if (i % 12 === 0) window.__bot(stats);
      g.fixedUpdate(DT);

      if (g.player.deathCause) seen.causes.add(g.player.deathCause);
      seen.biomes.add(g.biome.id);
      maxRows = Math.max(maxRows, g.world.rows.size);
      maxScore = Math.max(maxScore, g.score);

      if (!nan && (!Number.isFinite(g.player.x) || !Number.isFinite(g.player.y) || !Number.isFinite(g.player.rowF))) {
        nan = { step: i, x: g.player.x, y: g.player.y, row: g.player.rowF };
      }
      // A finished run rolls straight into the next one.
      if (g.state === 'menu' && !g.player.alive) {
        deaths++;
        g.start();
      }
    }
    for (const row of g.world.list) seen.rowTypes.add(row.type);

    return {
      maxScore,
      maxRows,
      deaths,
      nan,
      biomes: [...seen.biomes],
      causes: [...seen.causes],
      liveRows: g.world.rows.size,
      listInSync: g.world.list.length === g.world.rows.size,
      pooledRows: g.world._pool.length,
      coins: window.__crossy.profile.coins,
      board: window.__crossy.profile.leaderboard.length,
      best: window.__crossy.profile.bestScore,
      deathStats: window.__crossy.profile.stats?.deaths,
      stats,
    };
  });
  log('  soak:', JSON.stringify(soak));

  if (soak.nan) problems.push(`player position went non-finite: ${JSON.stringify(soak.nan)}`);
  if (soak.maxRows > 60) problems.push(`row set grew to ${soak.maxRows} — recycling is leaking`);
  if (!soak.listInSync) problems.push('world.list and world.rows disagree — row bookkeeping is broken');
  if (soak.deaths < 3) problems.push(`only ${soak.deaths} runs completed — the soak is not exercising death`);
  if (soak.maxScore < 30) problems.push(`best soak score was only ${soak.maxScore}`);
  if (soak.board === 0) problems.push('no run made it onto the leaderboard');
  for (const cause of ['car', 'water']) {
    if (!soak.causes.includes(cause)) problems.push(`the soak never triggered a ${cause} death`);
  }

  /* --- Deep progression --------------------------------------------
   * The naive bot dies around row 35, so it never sees the later biomes or
   * the top of the difficulty curve. Run a second pass with death disabled
   * to exercise deep streaming, biome cross-fades and end-game generation.
   */
  log('deep pass: 40 000 invincible steps to reach the late biomes…');
  const deep = await page.evaluate(() => {
    const g = window.__crossy.game;
    const DT = 1 / 120;
    const realDie = g.die.bind(g);
    // Survive everything by routing each fatal hit through the same rescue
    // path a shield uses. Nulling out die() entirely would let a log carry
    // the player past the world bounds with nothing to stop them.
    g.die = (cause) => {
      g.player.survive(cause, g.world);
      g.player.invulnerable = 0.4;
    };

    const biomes = new Set();
    let maxRows = 0;
    let nan = null;
    let cratesSeen = 0;
    let coinsSeen = 0;
    const railRows = new Set();

    const why = { forward: 0, side: 0, waterWait: 0, stuck: 0 };
    g.start();
    for (let i = 0; i < 40000; i++) {
      if (i % 12 === 0) window.__bot(why);
      g.fixedUpdate(DT);
      biomes.add(g.biome.id);
      maxRows = Math.max(maxRows, g.world.rows.size);
      if (!nan && !Number.isFinite(g.player.x)) nan = i;
      if (i % 60 === 0) {
        for (const row of g.world.list) {
          if (row.crate) cratesSeen++;
          coinsSeen += row.coins.length;
          if (row.type === 'rail') railRows.add(row.index);
        }
      }
    }
    const railRowsSeen = railRows.size;
    const out = {
      score: g.score,
      biomes: [...biomes],
      maxRows,
      nan,
      cratesSeen,
      coinsSeen,
      railRowsSeen,
      why,
      finalRowType: g.world.rowType(g.player.gridRow),
      finalX: +g.player.x.toFixed(2),
      hops: g.player.hopCount,
      fogColor: g.stage.scene.fog.color.getHexString(),
      sunIntensity: +g.stage.sun.intensity.toFixed(2),
      generatorIndex: g.world.generator.index,
    };
    g.die = realDie;
    g.toMenu();
    return out;
  });
  log('  deep:', JSON.stringify(deep));

  if (deep.nan !== null) problems.push(`deep pass went non-finite at step ${deep.nan}`);
  if (deep.score < 100) problems.push(`deep pass only reached row ${deep.score}`);
  if (deep.biomes.length < 2) problems.push(`deep pass never changed biome (saw ${deep.biomes})`);
  if (deep.maxRows > 60) problems.push(`deep pass leaked rows (peak ${deep.maxRows})`);
  if (deep.cratesSeen === 0) problems.push('no power-up crates were generated in 300+ rows');
  if (deep.coinsSeen === 0) problems.push('no coins were generated in 300+ rows');
  if (deep.railRowsSeen === 0) problems.push('no rail rows were generated in 300+ rows');

  /* --- Every biome actually applies --------------------------------
   * Driving a bot far enough to see Frostline would be testing the bot, not
   * the game. Walk the score through each threshold instead and assert the
   * stage and terrain really re-tint.
   */
  const biomes = await page.evaluate(() => {
    const g = window.__crossy.game;
    const out = [];
    g.start();
    for (const b of g.stage.constructor === Object ? [] : []) void b;
    const thresholds = [0, 90, 190, 300, 430];
    for (const score of thresholds) {
      g.score = score - 1;
      g.player.maxRow = score;
      g._updateScore();
      // Let the crossfade run to completion.
      for (let i = 0; i < 200; i++) g.stage.update(1 / 30, g.camera.focus);
      out.push({
        score,
        biome: g.biome.id,
        fog: g.stage.scene.fog.color.getHexString(),
        grass: g.terrain.mat.grass.color.getHexString(),
        water: g.terrain.mat.water.color.getHexString(),
        sun: +g.stage.sun.intensity.toFixed(2),
      });
    }
    g.toMenu();
    return out;
  });
  log('  biomes:');
  for (const b of biomes) log(`    ${String(b.score).padStart(3)} -> ${b.biome.padEnd(7)} fog #${b.fog} grass #${b.grass} water #${b.water} sun ${b.sun}`);

  const ids = biomes.map((b) => b.biome);
  if (new Set(ids).size !== 5) problems.push(`biome thresholds did not all resolve: ${ids}`);
  if (new Set(biomes.map((b) => b.fog)).size < 4) {
    problems.push('fog colour did not change across biomes — the crossfade is not applying');
  }
  if (new Set(biomes.map((b) => b.grass)).size < 4) {
    problems.push('terrain did not re-tint across biomes');
  }

  /* --- Trains actually kill ----------------------------------------
   * Rail rows are rare enough that the soak bot rarely meets one head on.
   * Park the player on a live crossing and confirm the swept test catches a
   * 30 u/s train rather than letting it pass straight through.
   */
  const train = await page.evaluate(() => {
    const g = window.__crossy.game;
    const DT = 1 / 120;
    g.start();
    // Run the world forward until a rail row exists ahead of the player.
    let rail = null;
    const stats = { forward: 0, side: 0, waterWait: 0, stuck: 0 };
    for (let i = 0; i < 20000 && !rail; i++) {
      if (g.state !== 'playing') g.start();
      if (i % 12 === 0) window.__bot(stats);
      g.fixedUpdate(DT);
      for (const row of g.world.list) {
        if (row.type === 'rail' && row.index > g.player.gridRow) { rail = row; break; }
      }
    }
    if (!rail) return { found: false };

    // Stand on the tracks and refuse to move.
    g.player.gridRow = rail.index;
    g.player.rowF = rail.index;
    g.player.x = 0;
    g.player.z = -rail.index;
    g.player.hop.active = false;
    g.player.invulnerable = 0;
    g.player.idleTime = 0;
    g.powerups.reset();

    const speed = rail.plan.speed;
    for (let i = 0; i < 3000; i++) {
      g.fixedUpdate(DT);
      // Keep the eagle from stealing the kill.
      g.player.idleTime = 0;
      if (!g.player.alive) break;
    }
    return { found: true, speed, alive: g.player.alive, cause: g.player.deathCause };
  });
  log('  train:', JSON.stringify(train));

  /* --- The eagle punishes standing still ---------------------------- */
  const eagle = await page.evaluate(() => {
    const g = window.__crossy.game;
    const DT = 1 / 120;
    g.start();
    // Move once so the run is under way, then refuse to move again.
    g.handleMove('up');
    for (let i = 0; i < 60; i++) g.fixedUpdate(DT);

    let warned = false;
    for (let i = 0; i < 3000; i++) {
      g.fixedUpdate(DT);
      if (g.eagle.active) warned = true;
      if (!g.player.alive) break;
    }
    return {
      warned,
      alive: g.player.alive,
      cause: g.player.deathCause,
      idle: +g.player.idleTime.toFixed(1),
    };
  });
  log('  eagle:', JSON.stringify(eagle));
  if (!eagle.warned) problems.push('the eagle never warned while the player idled');
  if (eagle.cause !== 'eagle') {
    problems.push(`idling did not end in an eagle grab (got ${eagle.cause})`);
  }
  if (!train.found) problems.push('could not find a rail row to test train collision');
  else if (train.cause !== 'train') {
    problems.push(`standing on live tracks did not cause a train death (got ${train.cause})`);
  }

  await page.waitForTimeout(600);
  await page.screenshot({ path: join(SHOT_DIR, '07-far.png') });

  /* --- Death + game over -------------------------------------------
   * Step the death delay directly: under software GL the page renders a
   * couple of frames a second, so wall-clock waiting would never get there.
   */
  const over = await page.evaluate(() => {
    const g = window.__crossy.game;
    g.start();
    g.fixedUpdate(1 / 120);
    g.die('car');
    const stateAtDeath = g.state;
    for (let i = 0; i < 400; i++) g.fixedUpdate(1 / 120); // 3.3 s of simulation
    return { stateAtDeath, state: g.state, current: window.__crossy.ui.current };
  });
  await settle(page, 'gameover');
  await page.screenshot({ path: join(SHOT_DIR, '08-gameover.png') });

  // The board is populated by now; capture the real thing, not the empty state.
  await page.evaluate(() => window.__crossy.ui.show('leaderboard'));
  await settle(page, 'leaderboard');
  await page.screenshot({ path: join(SHOT_DIR, '03b-leaderboard-full.png') });
  const rows = await page.evaluate(
    () => document.querySelectorAll('[data-screen="leaderboard"] tbody tr').length,
  );
  if (rows === 0) problems.push('the leaderboard renders no rows despite completed runs');
  log(`  leaderboard rows: ${rows}`);
  log('  game over:', JSON.stringify(over));
  if (over.stateAtDeath !== 'dead') problems.push(`die() left state at ${over.stateAtDeath}`);
  if (over.current !== 'gameover') {
    problems.push(`game over screen did not show (current=${over.current})`);
  }

  /* --- Mobile viewport --------------------------------------------- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    window.__crossy.game.toMenu();
    window.__crossy.ui.show('menu');
  });
  await settle(page, 'menu');
  await page.screenshot({ path: join(SHOT_DIR, '09-mobile-menu.png') });
  await page.evaluate(() => window.__crossy.ui.show('characters'));
  await settle(page, 'characters');
  await page.screenshot({ path: join(SHOT_DIR, '10-mobile-characters.png') });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  if (overflow) problems.push('the page scrolls horizontally at 390px wide');

  await browser.close();
  server.kill();

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  log(`\nsmoke test passed — screenshots in ${SHOT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
