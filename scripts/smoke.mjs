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
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(SHOT_DIR, '01-menu.png') });

  /* --- Menu screens ------------------------------------------------ */
  for (const [screen, shot] of [
    ['characters', '02-characters.png'],
    ['leaderboard', '03-leaderboard.png'],
    ['settings', '04-settings.png'],
  ]) {
    await page.evaluate((s) => window.__crossy.ui.show(s), screen);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOT_DIR, shot) });
    const visible = await page.evaluate((s) => window.__crossy.ui.current === s, screen);
    if (!visible) problems.push(`screen "${screen}" did not become current`);
  }
  await page.evaluate(() => window.__crossy.ui.show('menu'));

  /* --- Play -------------------------------------------------------- */
  log('starting a run…');
  await page.evaluate(() => window.__crossy.game.start());
  await page.waitForTimeout(400);

  // Hop forward with real key events until we have covered some ground.
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(90);
    const alive = await page.evaluate(() => window.__crossy.game.player.alive);
    if (!alive) break;
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOT_DIR, '05-playing.png') });

  const snap = await page.evaluate(() => {
    const g = window.__crossy.game;
    return {
      state: g.state,
      score: g.score,
      alive: g.player.alive,
      rows: g.world.rows.size,
      minRow: g.world.minRow,
      maxRow: g.world.maxRow,
      x: g.player.x,
      y: g.player.y,
      fps: window.__crossy.loop.fps,
      biome: g.biome.id,
    };
  });
  log('  snapshot:', JSON.stringify(snap));

  if (!Number.isFinite(snap.x) || !Number.isFinite(snap.y)) {
    problems.push(`player position is not finite: ${JSON.stringify(snap)}`);
  }
  if (snap.rows < 20) problems.push(`only ${snap.rows} rows streamed in`);
  if (snap.score < 1) problems.push('no forward progress was recorded');

  /* --- Pause ------------------------------------------------------- */
  await page.evaluate(() => window.__crossy.game.pause());
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOT_DIR, '06-paused.png') });
  const paused = await page.evaluate(() => window.__crossy.game.state);
  if (paused !== 'paused') problems.push(`pause did not take: state=${paused}`);
  await page.evaluate(() => window.__crossy.game.resume());

  /* --- Long unattended run: catches drift, leaks and NaNs ----------- */
  log('running unattended for 12s (traffic, water, trains, eagle)…');
  await page.evaluate(() => {
    const g = window.__crossy.game;
    // Drive forward automatically so the run reaches water and rail rows.
    window.__auto = setInterval(() => {
      if (g.state === 'playing') g.handleMove('up');
    }, 130);
  });
  await page.waitForTimeout(12000);
  await page.evaluate(() => clearInterval(window.__auto));
  await page.screenshot({ path: join(SHOT_DIR, '07-far.png') });

  const late = await page.evaluate(() => {
    const g = window.__crossy.game;
    return {
      state: g.state,
      score: g.score,
      coins: g.coins,
      rows: g.world.rows.size,
      poolRows: g.world._pool.length,
      cause: g.player.deathCause,
      fps: Math.round(window.__crossy.loop.fps),
      biome: g.biome.id,
      deaths: window.__crossy.profile.stats?.deaths,
    };
  });
  log('  after run:', JSON.stringify(late));
  if (late.rows > 60) problems.push(`row set grew to ${late.rows} — recycling is leaking`);

  /* --- Death + game over ------------------------------------------- */
  await page.evaluate(() => {
    const g = window.__crossy.game;
    if (g.state !== 'playing') g.start();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__crossy.game.die('car'));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: join(SHOT_DIR, '08-gameover.png') });
  const over = await page.evaluate(() => window.__crossy.ui.current);
  if (over !== 'gameover') problems.push(`game over screen did not show (current=${over})`);

  /* --- Mobile viewport --------------------------------------------- */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.__crossy.game.toMenu());
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(SHOT_DIR, '09-mobile-menu.png') });
  await page.evaluate(() => window.__crossy.ui.show('characters'));
  await page.waitForTimeout(500);
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
