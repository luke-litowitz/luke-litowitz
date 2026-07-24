/**
 * Bootstrap: builds every subsystem, wires the UI action channel to the game
 * and owns the frame loop. Nothing else in the codebase reaches for the DOM
 * outside of `src/ui/`.
 */

import { GameLoop } from './core/loop.js';
import { InputManager } from './core/input.js';
import { AudioManager } from './core/audio.js';
import {
  loadProfile,
  saveProfile,
  spendCoins,
  unlockCharacter,
  isUnlocked,
} from './core/storage.js';
import { UI } from './ui/screens.js';
import { Game, STATE } from './game/game.js';
import { CharacterPreview } from './render/preview.js';
import { getCharacter } from './data/characters.js';

function fatal(message, detail) {
  const root = document.getElementById('ui') || document.body;
  root.innerHTML = `
    <div class="fatal">
      <h1>Can't start the game</h1>
      <p>${message}</p>
      ${detail ? `<pre>${String(detail).slice(0, 400)}</pre>` : ''}
    </div>`;
  root.style.pointerEvents = 'auto';
}

function boot() {
  const canvas = document.getElementById('game-canvas');
  const uiRoot = document.getElementById('ui');
  if (!canvas || !uiRoot) return fatal('The page is missing its canvas.');

  const profile = loadProfile();
  const audio = new AudioManager();

  let game;
  let ui;
  let preview = null;

  /* ---------------------------------------------------------------- *
   * UI action channel
   * ---------------------------------------------------------------- */

  const onAction = (name, payload) => {
    audio.unlock();
    switch (name) {
      case 'start':
        audio.play('menu-select');
        game.start();
        break;

      case 'resume':
        game.resume();
        break;

      case 'restart':
        audio.play('menu-select');
        game.restart();
        break;

      case 'home':
        audio.play('menu-back');
        game.toMenu();
        break;

      case 'pause':
        game.pause();
        break;

      case 'open':
        audio.play('menu-select');
        ui.show(payload);
        syncPreview(payload);
        break;

      case 'select-character': {
        if (!isUnlocked(profile, payload)) return;
        profile.selected = payload;
        saveProfile(profile);
        game.applyCharacter(payload);
        preview?.setCharacter(payload);
        ui.refreshCharacters();
        audio.play('menu-select');
        break;
      }

      case 'buy-character': {
        const character = getCharacter(payload);
        if (!character || isUnlocked(profile, payload)) return;
        if (!spendCoins(profile, character.price)) {
          audio.play('error');
          ui.toast('Not enough coins yet.', 'error');
          return;
        }
        unlockCharacter(profile, payload);
        profile.selected = payload;
        saveProfile(profile);
        game.applyCharacter(payload);
        preview?.setCharacter(payload);
        ui.refreshCharacters();
        audio.play('unlock');
        ui.toast(`${character.name} unlocked!`, 'success');
        break;
      }

      case 'set-setting': {
        const { key, value } = payload || {};
        if (!key) return;
        profile.settings[key] = value;
        saveProfile(profile);
        game.applySettings(profile.settings);
        audio.play('menu-move', { gain: 0.4 });
        break;
      }

      case 'set-name':
        profile.name = payload;
        saveProfile(profile);
        break;

      case 'clear-leaderboard':
        ui.refreshLeaderboard();
        saveProfile(profile);
        audio.play('menu-back');
        break;

      case 'preview-character':
        preview?.setCharacter(payload);
        break;

      default:
        break;
    }
  };

  /* ---------------------------------------------------------------- *
   * Construction
   * ---------------------------------------------------------------- */

  try {
    ui = new UI(uiRoot, { profile, audio, onAction });
  } catch (err) {
    return fatal('The interface failed to load.', err?.stack || err);
  }

  try {
    game = new Game({ canvas, profile, audio, ui });
  } catch (err) {
    return fatal(
      'WebGL could not start. Try a different browser, or enable hardware acceleration.',
      err?.stack || err,
    );
  }

  const previewMount = uiRoot.querySelector('[data-char-preview]');
  if (previewMount) {
    try {
      preview = new CharacterPreview(previewMount);
      preview.setCharacter(profile.selected);
    } catch {
      preview = null;
    }
  }

  /**
   * The preview only renders while its screen is open. Driving it from the
   * observed screen rather than from navigation actions means it can never
   * get stuck running (or stuck blank) if a screen changes by another route.
   */
  let previewScreen = null;
  function syncPreview(screen) {
    if (!preview || screen === previewScreen) return;
    previewScreen = screen;
    if (screen === 'characters') {
      preview.setCharacter(profile.selected);
      preview.start();
    } else {
      preview.stop();
    }
  }

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  const input = new InputManager(canvas);

  input.on('move', (dir) => {
    if (game.state === STATE.PLAYING) game.handleMove(dir);
  });

  /**
   * Whether a game-level key should act at all.
   *
   * `ui.current === null` means gameplay has the keyboard. Any other screen
   * owns it — including Settings opened *from* the pause menu, where an
   * unguarded P or R would resume or destroy the run from behind the modal.
   * The pause screen itself is the one modal that still answers to P.
   */
  const gameKeysLive = () => ui.current === null || ui.current === 'paused';

  input.on('pause', () => {
    if (!gameKeysLive()) return;
    if (game.state === STATE.PLAYING) game.pause();
    else if (game.state === STATE.PAUSED) game.resume();
  });

  input.on('confirm', () => {
    audio.unlock();
    if (game.state === STATE.MENU && ui.current === 'menu') onAction('start');
  });

  input.on('restart', () => {
    if (!gameKeysLive()) return;
    if (game.state === STATE.PLAYING || game.state === STATE.PAUSED) game.restart();
  });

  // 'back' is deliberately not handled here. The UI traps Escape itself and
  // reports the resulting navigation through onAction ('open' / 'resume' /
  // 'home'), which already knows where each screen should return to.

  // The very first interaction anywhere unlocks audio.
  const unlockOnce = () => audio.unlock();
  window.addEventListener('pointerdown', unlockOnce, { once: true, passive: true });
  window.addEventListener('keydown', unlockOnce, { once: true, passive: true });

  /* ---------------------------------------------------------------- *
   * Sizing
   * ---------------------------------------------------------------- */

  function resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    game.resize(w, h);
    preview?.resize();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  resize();

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Adaptive quality. With the graphics setting on "auto" the game watches its
   * own frame rate and steps down a rung after a sustained dip, so a weak GPU
   * degrades gracefully instead of stuttering. It only ever steps down: an
   * automatic step back up would oscillate at the boundary.
   */
  const QUALITY_LADDER = ['high', 'medium', 'low'];
  let slowSamples = 0;
  function watchFrameRate({ fps }) {
    if ((profile.settings.quality || 'auto') !== 'auto') return;
    if (game.state !== STATE.PLAYING) {
      slowSamples = 0;
      return;
    }
    if (fps >= 45) {
      slowSamples = Math.max(0, slowSamples - 1);
      return;
    }
    if (++slowSamples < 8) return; // ~4 s of sustained slowdown
    slowSamples = 0;

    const rung = QUALITY_LADDER.indexOf(game.stage.quality);
    if (rung < 0 || rung >= QUALITY_LADDER.length - 1) return;
    game.setAutoQuality(QUALITY_LADDER[rung + 1]);
    resize();
    ui.toast('Lowered graphics quality to keep things smooth.', 'info');
  }

  const loop = new GameLoop({
    onStats: watchFrameRate,
    fixedUpdate: (dt) => game.fixedUpdate(dt),
    render: (alpha, frameDt) => {
      // Gamepad polling belongs on the render frame with real elapsed time:
      // driving it from the fixed step would poll twice per frame and tie the
      // stick's auto-repeat to simulation time rather than the wall clock.
      input.update(frameDt);
      game.render(alpha, frameDt);
      syncPreview(ui.current);
    },
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === STATE.PLAYING) game.pause();
      audio.suspend();
    } else {
      loop.resync();
      if (game.state !== STATE.PAUSED) audio.resume();
    }
  });

  window.addEventListener('blur', () => {
    if (game.state === STATE.PLAYING) game.pause();
  });

  ui.hide('loading');
  ui.show('menu');
  loop.start();

  // Expose a small handle for debugging without polluting gameplay code.
  window.__crossy = { game, ui, input, audio, loop, profile };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
