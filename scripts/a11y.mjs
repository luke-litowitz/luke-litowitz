#!/usr/bin/env node
/**
 * Accessibility checks against the real page.
 *
 * These assert behaviour that is easy to regress silently and impossible to
 * eyeball: whether a locked card can be reached by keyboard, whether a toast
 * lands somewhere assistive tech can see it, whether the HUD stops covering a
 * modal, and whether focus survives a control disappearing under it.
 *
 *   node scripts/a11y.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

/**
 * Load Playwright, or explain why it is missing.
 *
 * The game itself needs no install — but this harness drives a real browser,
 * so it needs the dev dependency. A raw ERR_MODULE_NOT_FOUND here reads like
 * the project is broken rather than simply not set up.
 */
async function loadChromium() {
  try {
    return (await import('playwright-core')).chromium;
  } catch {
    console.error(
      'This harness needs Playwright. Run `npm install` first ' +
        '(the game and `npm test` need no install at all).',
    );
    process.exit(1);
  }
}

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const problems = [];
const log = (...a) => console.log(...a);

function startServer() {
  const proc = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '0'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      proc.kill();
      rej(new Error('server did not start'));
    }, 10000);
    proc.stdout.on('data', (d) => {
      const m = /running at (http:\/\/[^/\s]+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        res({ proc, base: m[1].replace('localhost', '127.0.0.1') });
      }
    });
    proc.on('error', rej);
  });
}

/** Wait for a screen's entrance animation to land before measuring it. */
async function settle(page, screen) {
  await page.waitForFunction(
    (name) => {
      const el = document.querySelector(`[data-screen="${name}"]`);
      if (!el || el.hidden) return false;
      if (Number(getComputedStyle(el).opacity) < 0.99) return false;
      return el.getAnimations({ subtree: true }).every((a) => a.playState !== 'running');
    },
    screen,
    { timeout: 20000 },
  );
}

let server = null;
let browser = null;

async function main() {
  const started = await startServer();
  server = started.proc;
  const chromium = await loadChromium();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });

  await page.goto(started.base, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__crossy);
  await settle(page, 'menu');

  /* --- 1. The whole roster is reachable on a fresh, coinless profile ---
   * Locked cards used to be `disabled`, which removes them from the tab order
   * entirely: a new player could reach exactly one of sixteen characters and
   * never learn what the others cost.
   */
  await page.evaluate(() => {
    window.__crossy.profile.coins = 0;
    window.__crossy.ui.show('characters');
    window.__crossy.ui.refreshCharacters();
  });
  await settle(page, 'characters');

  const roster = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-screen="characters"] button[data-char-id]')];
    const focusable = cards.filter((c) => !c.disabled && c.tabIndex >= 0);
    const locked = cards.filter((c) => c.dataset.state === 'locked');
    const labelled = cards.filter((c) => (c.getAttribute('aria-label') || '').length > 4);
    // Contrast is exempt for genuinely disabled controls, but a locked card
    // still has to communicate its price.
    const dim = locked[0] ? Number(getComputedStyle(locked[0]).opacity) : 1;
    return {
      total: cards.length,
      focusable: focusable.length,
      locked: locked.length,
      lockedAndFocusable: locked.filter((c) => !c.disabled && c.tabIndex >= 0).length,
      labelled: labelled.length,
      lockedOpacity: dim,
      lockedAriaDisabled: locked.every((c) => c.getAttribute('aria-disabled') === 'true'),
    };
  });
  log('roster:', JSON.stringify(roster));
  if (roster.focusable < roster.total) {
    problems.push(`only ${roster.focusable}/${roster.total} character cards are focusable`);
  }
  if (roster.locked > 0 && !roster.lockedAriaDisabled) {
    problems.push('locked cards are focusable but not marked aria-disabled');
  }
  if (roster.labelled < roster.total) {
    problems.push(`${roster.total - roster.labelled} cards have no accessible name`);
  }
  if (roster.lockedOpacity < 0.7) {
    problems.push(`locked cards are dimmed to ${roster.lockedOpacity} — the price is unreadable`);
  }

  // Activating a locked card must be inert, not a crash or a free unlock.
  const inert = await page.evaluate(() => {
    const before = window.__crossy.profile.unlocked.length;
    const card = [...document.querySelectorAll('[data-screen="characters"] button[data-char-id]')]
      .find((c) => c.dataset.state === 'locked');
    if (!card) return { skipped: true };
    card.focus();
    const focused = document.activeElement === card;
    card.click();
    return { focused, changed: window.__crossy.profile.unlocked.length !== before };
  });
  log('locked card:', JSON.stringify(inert));
  if (!inert.skipped && !inert.focused) problems.push('a locked card cannot take focus');
  if (inert.changed) problems.push('activating a locked card unlocked something');

  /* --- 2. Toasts land inside the modal, where aria-modal lets AT see them --- */
  const toast = await page.evaluate(() => {
    window.__crossy.ui.toast('Not enough coins yet.', 'error');
    const el = document.querySelector('.toast, [class*="toast"]:not([class*="toasts"])');
    const stack = el?.closest('[class*="toast"]')?.parentElement || el?.parentElement;
    const screen = document.querySelector('[data-screen="characters"]');
    const region = el?.closest('[aria-live]');
    return {
      shown: !!el,
      insideActiveScreen: !!(stack && screen && screen.contains(stack)),
      live: region?.getAttribute('aria-live') || null,
      modal: screen?.getAttribute('aria-modal') || null,
    };
  });
  log('toast:', JSON.stringify(toast));
  if (!toast.shown) problems.push('toast() rendered nothing');
  if (toast.modal === 'true' && !toast.insideActiveScreen) {
    problems.push('the toast sits outside the aria-modal dialog, so it is never announced');
  }
  if (!toast.live) problems.push('the toast region has no aria-live');

  /* --- 3. The HUD stops covering a modal opened mid-run ------------------- */
  const hud = await page.evaluate(() => {
    const g = window.__crossy.game;
    g.start();
    for (let i = 0; i < 600; i++) g.fixedUpdate(1 / 120);
    const hudEl = document.querySelector('[data-screen="hud"]');
    const duringPlay = !hudEl.hidden;
    g.pause();
    const duringPause = !hudEl.hidden;
    g.resume();
    const afterResume = !hudEl.hidden;
    g.toMenu();
    return { duringPlay, duringPause, afterResume };
  });
  log('hud visibility:', JSON.stringify(hud));
  if (!hud.duringPlay) problems.push('the HUD is hidden during play');
  if (hud.duringPause) problems.push('the HUD stays up over the pause dialog');
  if (!hud.afterResume) problems.push('the HUD does not come back on resume');

  /* --- 4. Focus survives the control under it disappearing ---------------- */
  await page.evaluate(() => {
    const p = window.__crossy.profile;
    for (let i = 0; i < 3; i++) {
      p.leaderboard.push({
        id: `probe-${i}`,
        score: 40 - i,
        coins: 1,
        character: 'chicken',
        biome: 'meadow',
        date: new Date().toISOString(),
      });
    }
    window.__crossy.ui.show('leaderboard');
    window.__crossy.ui.refreshLeaderboard();
  });
  await settle(page, 'leaderboard');

  const cleared = await page.evaluate(() => {
    const screen = document.querySelector('[data-screen="leaderboard"]');
    const btn = [...screen.querySelectorAll('button')].find((b) => /clear/i.test(b.textContent));
    if (!btn) return { skipped: true };
    btn.focus();
    btn.click(); // arms
    btn.click(); // confirms
    const active = document.activeElement;
    return {
      rows: screen.querySelectorAll('tbody tr').length,
      focusInsideDialog: !!(active && screen.contains(active)),
      focusTag: active?.tagName,
    };
  });
  log('clear scores:', JSON.stringify(cleared));
  if (!cleared.skipped) {
    if (cleared.rows !== 0) problems.push('clearing the leaderboard left rows behind');
    if (!cleared.focusInsideDialog) {
      problems.push(`focus escaped the dialog after clearing (landed on ${cleared.focusTag})`);
    }
  }

  /* --- 5. Pinch-zoom is not blocked -------------------------------------- */
  const zoom = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="viewport"]')?.content || '';
    return {
      content: meta,
      blocks: /user-scalable\s*=\s*no|maximum-scale\s*=\s*1\b/.test(meta),
    };
  });
  log('viewport:', JSON.stringify(zoom));
  if (zoom.blocks) problems.push('the viewport meta still blocks pinch-zoom (WCAG 1.4.4)');

  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exitCode = 1;
    return;
  }
  log('\naccessibility checks passed');
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  server?.kill();
}
