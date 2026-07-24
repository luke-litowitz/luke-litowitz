/**
 * The entire DOM overlay: every screen, the HUD, and the toast stack.
 *
 * The UI owns its markup. `index.html` ships an empty `#ui` div and this module
 * builds everything inside it, so there is exactly one place to look for the
 * shape of a screen. Screens are all built up-front (never lazily) because
 * `main.js` reaches for `[data-char-preview]` immediately after construction,
 * and because a menu that has to build itself on the way in stutters.
 *
 * Communication with the game is one-way: the UI never imports game code and
 * never touches the renderer. Everything leaves through `onAction(name, payload)`
 * and everything arrives through the public methods in the §6 contract.
 *
 * Two rules drive most of the odd-looking code in here:
 *   1. `setHUD` runs every rendered frame, so it caches node references and
 *      compares before writing. No allocation, no layout reads, no DOM churn
 *      unless a value actually changed.
 *   2. Nothing may throw into the game loop. Every browser API that can be
 *      missing or refused (matchMedia, focus, Intl) is guarded.
 */

import { CHARACTERS, RARITIES, getCharacter } from '../data/characters.js';
import { getLeaderboard, clearLeaderboard, isUnlocked } from '../core/storage.js';
import { clamp, formatNumber } from '../core/math.js';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Display cap for the player name. Shorter than storage's cap so the
 *  leaderboard column never has to ellipsis mid-run. */
const MAX_NAME_LENGTH = 14;

const TOAST_LIFETIME_MS = 2600;
const TOAST_EXIT_MS = 300;
const MAX_TOASTS = 4;
/** How long the destructive "Clear" button stays armed. */
const CLEAR_CONFIRM_MS = 4000;
/** A power-up chip pulses once it drops under this many seconds. */
const POWERUP_URGENT_S = 1.5;

const SCREEN_NAMES = [
  'loading',
  'menu',
  'characters',
  'leaderboard',
  'settings',
  'hud',
  'paused',
  'gameover',
];

const MODAL_SCREENS = new Set([
  'loading',
  'menu',
  'characters',
  'leaderboard',
  'settings',
  'paused',
  'gameover',
]);

const TOAST_KINDS = new Set(['info', 'success', 'error']);

/** Accessible names for the dialogs; the raw screen id is not user-facing. */
const SCREEN_LABELS = {
  loading: 'Loading',
  menu: 'Crossy Cascade main menu',
  characters: 'Character select',
  leaderboard: 'High scores',
  settings: 'Settings',
  paused: 'Game paused',
  gameover: 'Run over',
};

/** One headline per death cause; the game passes the cause verbatim. */
const CAUSE_COPY = {
  car: { title: 'Squashed!', line: 'That bumper had the right of way.' },
  train: { title: 'Flattened!', line: 'The express does not brake for poultry.' },
  water: { title: 'Splash!', line: 'The river is not a shortcut.' },
  eagle: { title: 'Snatched!', line: 'Standing still is the most dangerous move.' },
  void: { title: 'Adrift!', line: 'The current carried you clean off the map.' },
};
const CAUSE_FALLBACK = { title: 'Wiped out!', line: 'One more hop and it was yours.' };

const SETTING_TOGGLES = [
  { key: 'sfx', label: 'Sound effects', hint: 'Hops, coins, crashes.' },
  { key: 'music', label: 'Music', hint: 'Procedural, one loop per biome.' },
  { key: 'shadows', label: 'Shadows', hint: 'Turn off to gain frames.' },
  { key: 'cameraShake', label: 'Camera shake', hint: 'Impact kick on near misses.' },
  { key: 'reducedMotion', label: 'Reduced motion', hint: 'Calmer camera and menus.' },
];

const QUALITY_OPTIONS = [
  ['auto', 'Auto'],
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
];

const CONTROL_LEGEND = [
  ['↑ ↓ ← →', 'Hop'],
  ['W A S D', 'Hop'],
  ['Swipe / Tap', 'Hop'],
  ['P · Esc', 'Pause'],
  ['R', 'Restart'],
];

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/* ------------------------------------------------------------------ *
 * Small pure helpers
 * ------------------------------------------------------------------ */

/**
 * Escape a value for interpolation into an HTML template string.
 * Character copy is authored in-repo, but the player name is not — and one
 * unescaped `<` in a name would take the whole overlay down.
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Validate a colour before it reaches a `style` attribute, so data (or a
 * hand-edited save) can never inject CSS.
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function safeColor(value, fallback) {
  return typeof value === 'string' && HEX_RE.test(value) ? value : fallback;
}

/**
 * Trim, strip control characters and cap a typed player name.
 * @param {unknown} value
 * @returns {string} always non-empty
 */
function cleanName(value) {
  const s = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return s === '' ? 'Player' : s;
}

/**
 * Short, locale-aware date for a leaderboard row. Falls back to the raw ISO
 * day when `Intl` data is unavailable (some minimal embedded runtimes).
 * @param {string} iso
 * @returns {string}
 */
function shortDate(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  try {
    return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

const COIN_GLYPH = '<span class="coin" aria-hidden="true"></span>';

/* ------------------------------------------------------------------ *
 * Screen markup
 * ------------------------------------------------------------------ */

const TEMPLATES = {
  loading: () => `
    <div class="panel panel--sm panel--center">
      ${lockup('sm')}
      <div class="spinner" aria-hidden="true"><i></i><i></i><i></i></div>
      <p class="muted">Paving the roads…</p>
    </div>`,

  menu: () => `
    <div class="panel panel--sm menu">
      ${lockup('lg')}
      <div class="chiprow">
        <span class="chip chip--coin">${COIN_GLYPH}<b data-menu-coins>0</b></span>
        <span class="chip"><span class="chip__label">BEST</span><b data-menu-best>0</b></span>
      </div>
      <button class="btn btn--play" type="button" data-action="start" data-autofocus>
        <span>PLAY</span>
      </button>
      <nav class="menu__nav" aria-label="Main menu">
        <button class="btn btn--soft" type="button" data-action="open" data-target="characters">
          <span class="btn__glyph" aria-hidden="true">★</span>Characters
        </button>
        <button class="btn btn--soft" type="button" data-action="open" data-target="leaderboard">
          <span class="btn__glyph" aria-hidden="true">▤</span>Scores
        </button>
        <button class="btn btn--soft" type="button" data-action="open" data-target="settings">
          <span class="btn__glyph" aria-hidden="true">⚙</span>Settings
        </button>
        <button class="btn btn--soft" type="button" data-action="toggle-howto"
                aria-expanded="false" aria-controls="cc-howto" data-howto-toggle>
          <span class="btn__glyph" aria-hidden="true">?</span>How to play
        </button>
      </nav>
      <section class="howto" id="cc-howto" data-howto hidden>
        <p>Hop forward for points. Every row you clear is one point.</p>
        <ul>
          <li>Traffic kills on contact — jumping does not clear a bumper.</li>
          <li>Rivers need a log or a lily pad. Ride to the edge and you are gone.</li>
          <li>Coins buy characters. Crates drop power-ups.</li>
          <li>Dawdle and an eagle takes you. Keep moving.</li>
        </ul>
      </section>
      ${legend()}
    </div>`,

  characters: () => `
    <div class="panel panel--wide">
      ${topbar('Characters', 'menu', '<span class="chip chip--coin">' + COIN_GLYPH + '<b data-chars-coins>0</b></span>')}
      <div class="char-stage">
        <!-- The game mounts its own WebGL canvas here; keep it empty so the
             renderer can size itself from this box alone. -->
        <div class="char-preview" data-char-preview></div>
        <div class="char-caption">
          <p class="char-caption__name" data-preview-name>Chicken</p>
          <p class="char-caption__desc" data-preview-desc></p>
        </div>
      </div>
      <div class="char-grid" data-char-grid data-arrow-grid></div>
    </div>`,

  leaderboard: () => `
    <div class="panel panel--wide">
      ${topbar('High scores', 'menu', '')}
      <div class="field">
        <label class="field__label" for="cc-name">Player name</label>
        <input class="input" id="cc-name" type="text" inputmode="text" autocomplete="off"
               spellcheck="false" maxlength="${MAX_NAME_LENGTH}" data-name-input />
      </div>
      <div class="table-wrap" data-lb-wrap>
        <table class="table">
          <thead>
            <tr>
              <th class="col-rank" scope="col">#</th>
              <th class="col-score" scope="col">Score</th>
              <th class="col-coins" scope="col">Coins</th>
              <th class="col-char" scope="col">Character</th>
              <th class="col-date" scope="col">Date</th>
            </tr>
          </thead>
          <tbody data-lb-body></tbody>
        </table>
      </div>
      <p class="empty" data-lb-empty>No runs yet. The board is yours to take.</p>
      <div class="btn-row btn-row--end">
        <button class="btn btn--soft btn--danger" type="button" data-action="clear-leaderboard" data-clear>
          Clear scores
        </button>
      </div>
    </div>`,

  settings: () => `
    <div class="panel panel--sm">
      ${topbar('Settings', 'menu', '', 'data-settings-back')}
      <div class="settings">
        ${SETTING_TOGGLES.map(
          (t) => `
        <div class="setting">
          <span class="setting__text">
            <span class="setting__label" id="cc-set-${esc(t.key)}">${esc(t.label)}</span>
            <span class="setting__hint">${esc(t.hint)}</span>
          </span>
          <button class="switch" type="button" role="switch" aria-checked="false"
                  aria-labelledby="cc-set-${esc(t.key)}"
                  data-action="set-setting" data-key="${esc(t.key)}">
            <span class="switch__knob" aria-hidden="true"></span>
          </button>
        </div>`,
        ).join('')}
        <div class="setting">
          <span class="setting__text">
            <span class="setting__label"><label for="cc-quality">Graphics quality</label></span>
            <span class="setting__hint">Auto follows your frame rate.</span>
          </span>
          <select class="select" id="cc-quality" data-setting-select data-key="quality">
            ${QUALITY_OPTIONS.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>`,

  hud: () => `
    <div class="hud">
      <div class="hud__top">
        <div class="hud__scores">
          <div class="hud__score" data-hud-score>0</div>
          <div class="hud__best">BEST <b data-hud-best>0</b></div>
        </div>
        <div class="hud__right">
          <div class="hud__coins" data-hud-coin-wrap>${COIN_GLYPH}<b data-hud-coins>0</b></div>
          <button class="btn btn--icon" type="button" data-action="pause" aria-label="Pause game">
            <span aria-hidden="true">❙❙</span>
          </button>
        </div>
      </div>
      <div class="pw-strip" data-pw-strip></div>
      <p class="hud__alert" data-hud-eagle hidden><span aria-hidden="true">▲</span> Eagle incoming</p>
    </div>`,

  paused: () => `
    <div class="panel panel--sm panel--center">
      <h2 class="screen__title">Paused</h2>
      <div class="stats">
        <div class="stat"><span>Score</span><b data-pause-score>0</b></div>
        <div class="stat"><span>Coins</span><b data-pause-coins>0</b></div>
        <div class="stat"><span>Best</span><b data-pause-best>0</b></div>
      </div>
      <div class="btn-col">
        <button class="btn btn--play btn--compact" type="button" data-action="resume" data-autofocus>Resume</button>
        <button class="btn btn--soft" type="button" data-action="restart">Restart run</button>
        <button class="btn btn--soft" type="button" data-action="open" data-target="settings">Settings</button>
        <button class="btn btn--soft btn--danger" type="button" data-action="home">Quit to menu</button>
      </div>
    </div>`,

  gameover: () => `
    <div class="panel panel--sm panel--center gameover">
      <p class="gameover__eyebrow" data-go-title>Wiped out!</p>
      <p class="gameover__line" data-go-line></p>
      <p class="flair" data-go-flair hidden>NEW BEST!</p>
      <div class="gameover__score">
        <span class="gameover__score-label">SCORE</span>
        <b data-go-score>0</b>
      </div>
      <div class="stats">
        <div class="stat"><span>Best</span><b data-go-best>0</b></div>
        <div class="stat"><span>Coins</span><b data-go-coins>0</b></div>
        <div class="stat" data-go-rank-wrap><span>Rank</span><b data-go-rank>—</b></div>
      </div>
      <div class="btn-col">
        <button class="btn btn--play btn--compact" type="button" data-action="restart" data-autofocus>Retry</button>
        <button class="btn btn--soft" type="button" data-action="home">Home</button>
      </div>
    </div>`,
};

/** Title lockup, shared by the loading and menu screens. */
function lockup(size) {
  return `
    <header class="lockup lockup--${size}">
      <h1 class="lockup__title">
        <span class="lockup__word">Crossy</span><span class="lockup__word lockup__word--alt">Cascade</span>
      </h1>
      <p class="lockup__tag">Dodge the traffic. Ride the river. Do not look back.</p>
    </header>`;
}

/** Header row with a back button, a title and an optional trailing slot. */
function topbar(title, backTo, trailing, extraAttrs = '') {
  return `
    <header class="topbar">
      <button class="btn btn--icon" type="button" data-action="open" data-target="${esc(backTo)}"
              aria-label="Back" ${extraAttrs}><span aria-hidden="true">‹</span></button>
      <h2 class="topbar__title">${esc(title)}</h2>
      <div class="topbar__end">${trailing}</div>
    </header>`;
}

function legend() {
  return `
    <ul class="legend" aria-label="Controls">
      ${CONTROL_LEGEND.map(
        ([keys, what]) => `<li><kbd>${esc(keys)}</kbd><span>${esc(what)}</span></li>`,
      ).join('')}
    </ul>`;
}

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

export class UI {
  /**
   * @param {HTMLElement} root the empty `#ui` overlay element
   * @param {{profile: object, audio?: object, onAction?: (name: string, payload?: any) => void}} deps
   */
  constructor(root, { profile, audio, onAction } = {}) {
    if (!root || typeof root.appendChild !== 'function') {
      throw new TypeError('UI requires a root element');
    }

    this.root = root;
    this.profile = profile || {};
    this.audio = audio || null;
    this.onAction = typeof onAction === 'function' ? onAction : null;

    this._current = null;
    /** Where the settings screen should return to (menu, or the pause menu). */
    this._returnTo = 'menu';
    this._destroyed = false;
    /** Actions raised while the first paint is still being assembled are
     *  dropped: the host is not wired up yet, and an early `preview-character`
     *  would poke systems that do not exist. */
    this._ready = false;
    this._clearArmed = false;
    this._clearTimer = 0;
    this._coinPopFlip = false;
    this._lastPreviewId = null;

    /** Last values pushed through `setHUD`; also feeds the pause screen. */
    this._hudState = { score: -1, best: -1, coins: -1, eagle: false };
    /** Pooled power-up chips. Grown once, then reused forever. */
    this._pwPool = [];

    this._screens = new Map();
    this._el = Object.create(null);

    this._buildDom();
    this._cacheNodes();
    this._bindEvents();
    this._watchMotionPreference();

    this.refreshSettings();
    this.refreshCharacters();
    this.refreshLeaderboard();
    this._refreshMenu();
    this.show('loading');
    this._ready = true;
  }

  /* ---------------------------------------------------------------- *
   * Construction
   * ---------------------------------------------------------------- */

  _buildDom() {
    this.root.classList.add('ui');
    this.root.innerHTML = '';

    const frag = document.createDocumentFragment();
    for (const name of SCREEN_NAMES) {
      const modal = MODAL_SCREENS.has(name);
      const section = document.createElement('section');
      section.className = `screen screen--${name} ${modal ? 'screen--modal' : 'screen--hud'}`;
      section.dataset.screen = name;
      section.hidden = true;
      if (modal) {
        section.setAttribute('role', 'dialog');
        section.setAttribute('aria-modal', 'true');
        section.setAttribute('aria-label', SCREEN_LABELS[name] || name);
      } else {
        section.setAttribute('aria-live', 'off');
      }
      section.innerHTML = TEMPLATES[name]();
      this._screens.set(name, section);
      frag.appendChild(section);
    }

    const toasts = document.createElement('div');
    toasts.className = 'toast-stack';
    toasts.setAttribute('aria-live', 'polite');
    frag.appendChild(toasts);
    this._toastStack = toasts;

    this.root.appendChild(frag);
  }

  _cacheNodes() {
    const q = (sel) => this.root.querySelector(sel);
    const el = this._el;

    el.menuCoins = q('[data-menu-coins]');
    el.menuBest = q('[data-menu-best]');
    el.howto = q('[data-howto]');
    el.howtoToggle = q('[data-howto-toggle]');

    el.charsCoins = q('[data-chars-coins]');
    el.charGrid = q('[data-char-grid]');
    el.previewName = q('[data-preview-name]');
    el.previewDesc = q('[data-preview-desc]');

    el.nameInput = q('[data-name-input]');
    el.lbBody = q('[data-lb-body]');
    el.lbWrap = q('[data-lb-wrap]');
    el.lbEmpty = q('[data-lb-empty]');
    el.clearBtn = q('[data-clear]');

    el.settingsBack = q('[data-settings-back]');
    el.qualitySelect = q('[data-setting-select]');

    el.hudScore = q('[data-hud-score]');
    el.hudBest = q('[data-hud-best]');
    el.hudCoins = q('[data-hud-coins]');
    el.hudCoinWrap = q('[data-hud-coin-wrap]');
    el.hudEagle = q('[data-hud-eagle]');
    el.pwStrip = q('[data-pw-strip]');

    el.pauseScore = q('[data-pause-score]');
    el.pauseCoins = q('[data-pause-coins]');
    el.pauseBest = q('[data-pause-best]');

    el.goTitle = q('[data-go-title]');
    el.goLine = q('[data-go-line]');
    el.goFlair = q('[data-go-flair]');
    el.goScore = q('[data-go-score]');
    el.goBest = q('[data-go-best]');
    el.goCoins = q('[data-go-coins]');
    el.goRank = q('[data-go-rank]');
    el.goRankWrap = q('[data-go-rank-wrap]');
  }

  _bindEvents() {
    this._onClick = this._onClick.bind(this);
    this._onChange = this._onChange.bind(this);
    this._onFocusIn = this._onFocusIn.bind(this);
    this._onPointerOver = this._onPointerOver.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);

    this.root.addEventListener('click', this._onClick);
    this.root.addEventListener('change', this._onChange);
    this.root.addEventListener('focusin', this._onFocusIn);
    this.root.addEventListener('pointerover', this._onPointerOver);
    // Capture on the document: the global InputManager listens on `window`, so
    // capturing here lets the UI claim Escape/Tab/arrows *before* the game does
    // and stop them, instead of both reacting to the same press.
    document.addEventListener('keydown', this._onKeyDown, true);
  }

  /**
   * OS-level reduced motion. The in-game setting is mirrored onto a data
   * attribute in `refreshSettings`; CSS honours either signal.
   */
  _watchMotionPreference() {
    this._prefersReduced = false;
    let mq = null;
    try {
      mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch {
      mq = null;
    }
    if (!mq) return;
    this._prefersReduced = !!mq.matches;
    const onChange = (e) => {
      this._prefersReduced = !!e.matches;
    };
    // Safari < 14 only has the deprecated listener API.
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else if (typeof mq.addListener === 'function') mq.addListener(onChange);
    this._mq = mq;
    this._onMotionChange = onChange;
  }

  /** @returns {boolean} true when animation should be suppressed. */
  get _reduced() {
    return this._prefersReduced || !!this.profile?.settings?.reducedMotion;
  }

  /* ---------------------------------------------------------------- *
   * Outgoing channel
   * ---------------------------------------------------------------- */

  /**
   * @param {string} name
   * @param {*} [payload]
   */
  _emit(name, payload) {
    if (!this.onAction || !this._ready || this._destroyed) return;
    try {
      this.onAction(name, payload);
    } catch (err) {
      // A game-side handler blowing up must not take the menu with it.
      console.error(`[ui] action "${name}" failed`, err);
    }
  }

  /** @param {string} name */
  _sfx(name) {
    try {
      this.audio?.play?.(name);
    } catch {
      /* audio is optional; never let it break navigation */
    }
  }

  /* ---------------------------------------------------------------- *
   * Screen visibility
   * ---------------------------------------------------------------- */

  /** @returns {string|null} the active modal screen, or null during gameplay. */
  get current() {
    return this._current;
  }

  /**
   * Activate a screen. `hud` is independent of the modal stack; showing any
   * modal leaves the HUD as it was, and showing the HUD dismisses the modal.
   * @param {string} name
   */
  show(name) {
    const section = this._screens.get(name);
    if (!section) return;

    if (name === 'hud') {
      this._setActive(section, true);
      this._closeModal();
      return;
    }

    if (this._current && this._current !== name) {
      const previous = this._screens.get(this._current);
      if (previous) this._setActive(previous, false);
    }

    // Remember where a nested screen was opened from so "back" lands correctly.
    if (name === 'settings' && this._el.settingsBack) {
      this._returnTo = this._current === 'paused' ? 'paused' : 'menu';
      this._el.settingsBack.dataset.target = this._returnTo;
    }

    this._current = name;
    this._setActive(section, true);
    this._onScreenEnter(name);
    this._focusFirst(section);
  }

  /**
   * Deactivate a screen. Hiding a screen that is not showing is a no-op.
   * @param {string} name
   */
  hide(name) {
    const section = this._screens.get(name);
    if (!section) return;
    if (name === 'hud') {
      this._setActive(section, false);
      return;
    }
    if (this._current !== name) return;
    this._blurWithin(section);
    this._setActive(section, false);
    this._current = null;
  }

  _closeModal() {
    if (!this._current) return;
    const section = this._screens.get(this._current);
    if (section) {
      this._blurWithin(section);
      this._setActive(section, false);
    }
    this._current = null;
  }

  /**
   * @param {HTMLElement} section
   * @param {boolean} active
   */
  _setActive(section, active) {
    section.classList.toggle('is-active', active);
    // `hidden` doubles as a stylesheet-independent fallback and keeps the
    // focus-trap queries honest.
    section.hidden = !active;
  }

  /** Refresh data that could have changed while a screen was closed. */
  _onScreenEnter(name) {
    switch (name) {
      case 'menu':
        this._refreshMenu();
        break;
      case 'characters':
        this.refreshCharacters();
        break;
      case 'leaderboard':
        this.refreshLeaderboard();
        break;
      case 'settings':
        this.refreshSettings();
        break;
      case 'paused':
        this._refreshPause();
        break;
      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- *
   * Focus
   * ---------------------------------------------------------------- */

  /** @param {HTMLElement} scope @returns {HTMLElement[]} */
  _focusables(scope) {
    const out = [];
    let nodes;
    try {
      nodes = scope.querySelectorAll(FOCUSABLE_SELECTOR);
    } catch {
      return out;
    }
    for (const node of nodes) {
      if (node.hidden || node.disabled) continue;
      if (node.closest('[hidden]')) continue;
      // `offsetParent` is null for anything display:none'd by an ancestor.
      if (node.offsetParent === null) continue;
      out.push(node);
    }
    return out;
  }

  /** @param {HTMLElement} section */
  _focusFirst(section) {
    const target = section.querySelector('[data-autofocus]') || this._focusables(section)[0];
    if (!target) return;
    try {
      target.focus({ preventScroll: true });
    } catch {
      /* focus can be refused mid-transition; harmless */
    }
  }

  /** Drop focus if it sits inside a screen that is going away. */
  _blurWithin(section) {
    const active = document.activeElement;
    if (active && section.contains(active) && typeof active.blur === 'function') active.blur();
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  _onClick(ev) {
    const target = ev.target;
    if (!target || typeof target.closest !== 'function') return;
    const el = target.closest('[data-action]');
    if (!el || el.disabled || !this.root.contains(el)) return;

    const action = el.dataset.action;
    switch (action) {
      case 'open':
        this._emit('open', el.dataset.target || 'menu');
        break;

      case 'toggle-howto':
        this._toggleHowto();
        break;

      case 'set-setting':
        this._toggleSetting(el);
        break;

      case 'clear-leaderboard':
        this._handleClear();
        break;

      case 'char':
        this._handleCharCard(el);
        break;

      case 'start':
      case 'resume':
      case 'restart':
      case 'home':
      case 'pause':
        this._emit(action);
        break;

      default:
        break;
    }
  }

  _onChange(ev) {
    const el = ev.target;
    if (!el) return;
    if (el === this._el.qualitySelect) {
      this._emit('set-setting', { key: 'quality', value: el.value });
      return;
    }
    if (el === this._el.nameInput) this._commitName();
  }

  _onFocusIn(ev) {
    const card = ev.target?.closest?.('[data-char-id]');
    if (card) this._previewCharacter(card.dataset.charId);
  }

  _onPointerOver(ev) {
    const card = ev.target?.closest?.('[data-char-id]');
    if (card) this._previewCharacter(card.dataset.charId);
  }

  _onKeyDown(ev) {
    if (this._destroyed || ev.defaultPrevented) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const modal = this._current ? this._screens.get(this._current) : null;
    if (!modal) return; // Gameplay: the game's InputManager owns the keyboard.

    const target = ev.target;
    const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'SELECT');

    if (ev.key === 'Escape') {
      ev.stopPropagation();
      if (ev.repeat) return; // A held Escape is still one request to go back.
      if (inField && typeof target.blur === 'function') {
        target.blur(); // First Escape leaves the field, not the screen.
        return;
      }
      const before = this._current;
      this._emit('back');
      // The host owns navigation. Only fall back to the obvious local move if
      // it ignored `back` — otherwise both would fire and the screen would
      // change twice.
      if (this._current === before) this._handleBack();
      return;
    }

    if (ev.key === 'Tab') {
      this._trapTab(ev, modal);
      return;
    }

    if (inField || ev.repeat) return;

    const forward = ev.key === 'ArrowDown' || ev.key === 'ArrowRight';
    const back = ev.key === 'ArrowUp' || ev.key === 'ArrowLeft';
    if (!forward && !back) return;

    // Claim the arrows: unhandled they would scroll the page and also reach
    // the game's move handler.
    ev.preventDefault();
    ev.stopPropagation();
    this._moveFocus(modal, forward ? 1 : -1, ev.key === 'ArrowUp' || ev.key === 'ArrowDown');
  }

  /**
   * Last-resort Escape handling: only runs when the host left the screen
   * exactly as it was, so the overlay is never a dead end.
   */
  _handleBack() {
    switch (this._current) {
      case 'characters':
      case 'leaderboard':
        this._emit('open', 'menu');
        break;
      case 'settings':
        this._emit('open', this._returnTo);
        break;
      case 'paused':
        this._emit('resume');
        break;
      case 'gameover':
        this._emit('home');
        break;
      default:
        break;
    }
  }

  /** @param {KeyboardEvent} ev @param {HTMLElement} modal */
  _trapTab(ev, modal) {
    const items = this._focusables(modal);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = active && modal.contains(active);

    if (!inside) {
      ev.preventDefault();
      ev.stopPropagation();
      this._focusNode(ev.shiftKey ? last : first);
      return;
    }
    if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      ev.stopPropagation();
      this._focusNode(first);
    } else if (ev.shiftKey && active === first) {
      ev.preventDefault();
      ev.stopPropagation();
      this._focusNode(last);
    }
  }

  /**
   * Arrow-key navigation. Inside a grid, up/down jump a whole row — the column
   * count is derived from where items wrap rather than hard-coded, so it stays
   * correct at every breakpoint.
   * @param {HTMLElement} modal
   * @param {number} step -1 or 1
   * @param {boolean} vertical
   */
  _moveFocus(modal, step, vertical) {
    const items = this._focusables(modal);
    if (items.length === 0) return;
    const active = document.activeElement;
    let index = items.indexOf(active);
    if (index === -1) {
      this._focusNode(items[0]);
      return;
    }

    let jump = 1;
    const grid = vertical && active ? active.closest('[data-arrow-grid]') : null;
    if (grid) {
      const cards = items.filter((n) => grid.contains(n));
      const top = cards.length ? cards[0].offsetTop : 0;
      let columns = 0;
      for (const card of cards) {
        if (card.offsetTop !== top) break;
        columns++;
      }
      if (columns > 0) jump = columns;
    }

    index = clamp(index + step * jump, 0, items.length - 1);
    this._focusNode(items[index]);
  }

  _focusNode(node) {
    try {
      node.focus({ preventScroll: false });
      this._sfx('menu-move');
    } catch {
      /* ignore */
    }
  }

  /* ---------------------------------------------------------------- *
   * Menu
   * ---------------------------------------------------------------- */

  _refreshMenu() {
    const el = this._el;
    if (el.menuCoins) el.menuCoins.textContent = formatNumber(this.profile.coins || 0);
    if (el.menuBest) el.menuBest.textContent = formatNumber(this.profile.bestScore || 0);
  }

  _toggleHowto() {
    const { howto, howtoToggle } = this._el;
    if (!howto || !howtoToggle) return;
    const open = howto.hidden;
    howto.hidden = !open;
    howtoToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* ---------------------------------------------------------------- *
   * Characters
   * ---------------------------------------------------------------- */

  /** Rebuild the character grid from the roster and the live profile. */
  refreshCharacters() {
    const grid = this._el.charGrid;
    if (!grid) return;

    const coins = Math.max(0, Math.floor(this.profile.coins || 0));
    if (this._el.charsCoins) this._el.charsCoins.textContent = formatNumber(coins);

    const html = [];
    for (const character of CHARACTERS) {
      html.push(this._cardMarkup(character, coins));
    }
    grid.innerHTML = html.join('');
    this._lastPreviewId = null;
    this._previewCharacter(this.profile.selected);
  }

  /**
   * @param {object} c character entry
   * @param {number} coins current balance
   * @returns {string} markup for one card
   */
  _cardMarkup(c, coins) {
    const owned = isUnlocked(this.profile, c.id);
    const selected = owned && this.profile.selected === c.id;
    const affordable = !owned && coins >= c.price;
    const state = selected ? 'selected' : owned ? 'owned' : affordable ? 'buy' : 'locked';
    const rarity = RARITIES[c.rarity] || RARITIES.common;
    const color = safeColor(rarity.color, '#78889a');

    const footer =
      state === 'selected'
        ? '<span class="card__state card__state--on">Selected</span>'
        : state === 'owned'
          ? '<span class="card__state">Owned</span>'
          : `<span class="card__price">${COIN_GLYPH}${formatNumber(c.price)}</span>`;

    const label =
      state === 'selected'
        ? `${c.name}, ${rarity.label}, selected`
        : state === 'owned'
          ? `${c.name}, ${rarity.label}, owned — press to select`
          : state === 'buy'
            ? `${c.name}, ${rarity.label}, costs ${c.price} coins — press to buy`
            : `${c.name}, ${rarity.label}, locked, needs ${c.price} coins`;

    return `
      <button class="card" type="button"
              data-action="char" data-char-id="${esc(c.id)}" data-state="${state}"
              style="--rarity:${color}"
              aria-pressed="${selected ? 'true' : 'false'}"
              aria-label="${esc(label)}"
              ${state === 'locked' ? 'disabled' : ''}>
        <span class="card__rarity" style="--rarity:${color}">${esc(rarity.label)}</span>
        <span class="card__name">${esc(c.name)}</span>
        ${c.perk ? `<span class="card__perk">${esc(c.perk.label)}</span>` : '<span class="card__perk card__perk--none">No perk</span>'}
        <span class="card__foot">${footer}</span>
      </button>`;
  }

  /** @param {HTMLElement} el the clicked card */
  _handleCharCard(el) {
    const id = el.dataset.charId;
    if (!id) return;
    const state = el.dataset.state;
    if (state === 'owned') this._emit('select-character', id);
    else if (state === 'buy') this._emit('buy-character', id);
    else if (state === 'selected') this._sfx('menu-move');
  }

  /**
   * Point the 3D preview and the caption at a character.
   * @param {string} id
   */
  _previewCharacter(id) {
    if (!id || id === this._lastPreviewId) return;
    const character = getCharacter(id);
    if (!character) return;
    this._lastPreviewId = character.id;
    if (this._el.previewName) this._el.previewName.textContent = character.name;
    if (this._el.previewDesc) this._el.previewDesc.textContent = character.description || '';
    this._emit('preview-character', character.id);
  }

  /* ---------------------------------------------------------------- *
   * Leaderboard
   * ---------------------------------------------------------------- */

  /** Rebuild the score table and re-sync the name field. */
  refreshLeaderboard() {
    const { lbBody, lbEmpty, lbWrap, nameInput } = this._el;
    this._disarmClear();

    if (nameInput && document.activeElement !== nameInput) {
      nameInput.value = cleanName(this.profile.name);
    }
    if (!lbBody) return;

    const board = getLeaderboard(this.profile);
    if (board.length === 0) {
      lbBody.innerHTML = '';
      if (lbWrap) lbWrap.hidden = true;
      if (lbEmpty) lbEmpty.hidden = false;
      if (this._el.clearBtn) this._el.clearBtn.disabled = true;
      return;
    }

    if (lbWrap) lbWrap.hidden = false;
    if (lbEmpty) lbEmpty.hidden = true;
    if (this._el.clearBtn) this._el.clearBtn.disabled = false;

    const rows = [];
    for (let i = 0; i < board.length; i++) {
      const e = board[i];
      rows.push(`
        <tr class="${i < 3 ? `is-medal is-medal-${i + 1}` : ''}">
          <td class="col-rank">${i + 1}</td>
          <td class="col-score">${formatNumber(e.score)}</td>
          <td class="col-coins">${COIN_GLYPH}${formatNumber(e.coins)}</td>
          <td class="col-char">${esc(getCharacter(e.character).name)}</td>
          <td class="col-date">${esc(shortDate(e.date))}</td>
        </tr>`);
    }
    lbBody.innerHTML = rows.join('');
  }

  _commitName() {
    const input = this._el.nameInput;
    if (!input) return;
    const clean = cleanName(input.value);
    input.value = clean;
    if (clean === this.profile.name) return;
    this._emit('set-name', clean);
  }

  /** Two-step destructive action: arm, then confirm. */
  _handleClear() {
    const btn = this._el.clearBtn;
    if (!btn) return;

    if (!this._clearArmed) {
      this._clearArmed = true;
      btn.classList.add('is-armed');
      btn.textContent = 'Tap again to erase';
      this._sfx('menu-back');
      this._clearTimer = setTimeout(() => this._disarmClear(), CLEAR_CONFIRM_MS);
      return;
    }

    this._disarmClear();
    clearLeaderboard(this.profile);
    this._emit('clear-leaderboard');
    this.refreshLeaderboard();
    this.toast('Scores cleared.', 'info');
  }

  _disarmClear() {
    if (this._clearTimer) {
      clearTimeout(this._clearTimer);
      this._clearTimer = 0;
    }
    this._clearArmed = false;
    const btn = this._el.clearBtn;
    if (btn) {
      btn.classList.remove('is-armed');
      btn.textContent = 'Clear scores';
    }
  }

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */

  /** Pull every control back in line with `profile.settings`. */
  refreshSettings() {
    const settings = this.profile.settings || {};
    for (const { key } of SETTING_TOGGLES) {
      const btn = this.root.querySelector(`.switch[data-key="${key}"]`);
      if (btn) btn.setAttribute('aria-checked', settings[key] ? 'true' : 'false');
    }
    if (this._el.qualitySelect) this._el.qualitySelect.value = settings.quality || 'auto';
    // Mirror the in-game preference so CSS can drop animations without JS.
    this.root.dataset.reducedMotion = settings.reducedMotion ? 'on' : 'off';
  }

  /** @param {HTMLElement} btn the switch that was pressed */
  _toggleSetting(btn) {
    const key = btn.dataset.key;
    if (!key) return;
    const value = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', value ? 'true' : 'false');
    if (key === 'reducedMotion') this.root.dataset.reducedMotion = value ? 'on' : 'off';
    this._emit('set-setting', { key, value });
  }

  /* ---------------------------------------------------------------- *
   * HUD
   * ---------------------------------------------------------------- */

  /**
   * Per-frame HUD update. Allocation-free on the common path: values are
   * compared against the last frame and only differences reach the DOM.
   * @param {{score:number, best:number, coins:number,
   *   powerups?: Array<{id:string, icon:string, color:string, remaining:number, duration:number, name?:string}>,
   *   eagle?: number}} state
   */
  setHUD(state) {
    if (!state) return;
    const el = this._el;
    const hud = this._hudState;

    const score = Math.max(0, Math.floor(state.score || 0));
    if (score !== hud.score) {
      hud.score = score;
      if (el.hudScore) el.hudScore.textContent = formatNumber(score);
    }

    const best = Math.max(0, Math.floor(state.best || 0));
    if (best !== hud.best) {
      hud.best = best;
      if (el.hudBest) el.hudBest.textContent = formatNumber(best);
    }

    const coins = Math.max(0, Math.floor(state.coins || 0));
    if (coins !== hud.coins) {
      const gained = coins > hud.coins && hud.coins >= 0;
      hud.coins = coins;
      if (el.hudCoins) el.hudCoins.textContent = formatNumber(coins);
      if (gained) this._popCoins();
    }

    const eagle = typeof state.eagle === 'number' && state.eagle > 0;
    if (eagle !== hud.eagle) {
      hud.eagle = eagle;
      if (el.hudEagle) el.hudEagle.hidden = !eagle;
    }

    this._syncPowerups(state.powerups);
  }

  /**
   * Restart the coin bump. Two alternating classes avoid the forced reflow a
   * remove/re-add of a single class would cost on every pickup.
   */
  _popCoins() {
    const wrap = this._el.hudCoinWrap;
    if (!wrap || this._reduced) return;
    this._coinPopFlip = !this._coinPopFlip;
    wrap.classList.toggle('is-pop-a', this._coinPopFlip);
    wrap.classList.toggle('is-pop-b', !this._coinPopFlip);
  }

  /**
   * Reconcile the active-power-up strip against a pooled set of chips.
   * @param {Array<object>|undefined} list
   */
  _syncPowerups(list) {
    const strip = this._el.pwStrip;
    if (!strip) return;
    const pool = this._pwPool;
    const count = list ? list.length : 0;

    for (let i = 0; i < count; i++) {
      const src = list[i];
      let chip = pool[i];
      if (!chip) {
        chip = this._makePowerupChip();
        pool.push(chip);
        strip.appendChild(chip.root);
      }
      if (chip.root.hidden) chip.root.hidden = false;

      if (chip.id !== src.id) {
        chip.id = src.id;
        chip.icon.textContent = src.icon || '●';
        chip.root.style.setProperty('--pw', safeColor(src.color, '#ffffff'));
        chip.root.setAttribute('aria-label', src.name || src.id || 'Power-up');
      }

      const duration = src.duration > 0 ? src.duration : 1;
      const pct = Math.round(clamp(src.remaining / duration, 0, 1) * 100);
      if (pct !== chip.pct) {
        chip.pct = pct;
        chip.root.style.setProperty('--p', pct);
      }

      const urgent = src.remaining <= POWERUP_URGENT_S;
      if (urgent !== chip.urgent) {
        chip.urgent = urgent;
        chip.root.classList.toggle('is-urgent', urgent);
      }
    }

    for (let i = count; i < pool.length; i++) {
      const chip = pool[i];
      if (chip.root.hidden) continue;
      chip.root.hidden = true;
      chip.id = null;
      chip.pct = -1;
      chip.urgent = false;
      chip.root.classList.remove('is-urgent');
    }
  }

  /** @returns {{root:HTMLElement, icon:HTMLElement, id:string|null, pct:number, urgent:boolean}} */
  _makePowerupChip() {
    const root = document.createElement('div');
    root.className = 'pw';
    root.setAttribute('role', 'img');
    const ring = document.createElement('span');
    ring.className = 'pw__ring';
    ring.setAttribute('aria-hidden', 'true');
    const icon = document.createElement('span');
    icon.className = 'pw__icon';
    icon.setAttribute('aria-hidden', 'true');
    root.appendChild(ring);
    root.appendChild(icon);
    return { root, icon, id: null, pct: -1, urgent: false };
  }

  _refreshPause() {
    const el = this._el;
    const hud = this._hudState;
    if (el.pauseScore) el.pauseScore.textContent = formatNumber(Math.max(0, hud.score));
    if (el.pauseCoins) el.pauseCoins.textContent = formatNumber(Math.max(0, hud.coins));
    if (el.pauseBest) el.pauseBest.textContent = formatNumber(Math.max(0, hud.best));
  }

  /* ---------------------------------------------------------------- *
   * Game over
   * ---------------------------------------------------------------- */

  /**
   * Fill the game-over screen. Call before `show('gameover')`.
   * @param {{score:number, best:number, coins:number, rank:number|null,
   *   cause:string, isBest:boolean}} result
   */
  setGameOver(result) {
    const r = result || {};
    const el = this._el;
    const copy = CAUSE_COPY[r.cause] || CAUSE_FALLBACK;

    if (el.goTitle) el.goTitle.textContent = copy.title;
    if (el.goLine) el.goLine.textContent = copy.line;
    if (el.goScore) el.goScore.textContent = formatNumber(Math.max(0, r.score || 0));
    if (el.goBest) el.goBest.textContent = formatNumber(Math.max(0, r.best || 0));
    if (el.goCoins) el.goCoins.textContent = formatNumber(Math.max(0, r.coins || 0));
    if (el.goFlair) el.goFlair.hidden = !r.isBest;

    const rank = Number.isFinite(r.rank) ? r.rank : null;
    if (el.goRankWrap) el.goRankWrap.hidden = rank === null;
    if (el.goRank && rank !== null) el.goRank.textContent = `#${rank}`;

    const screen = this._screens.get('gameover');
    if (screen) screen.dataset.cause = CAUSE_COPY[r.cause] ? r.cause : 'other';

    // The wallet and best score changed; keep the menu chips honest.
    this._refreshMenu();
  }

  /* ---------------------------------------------------------------- *
   * Toasts
   * ---------------------------------------------------------------- */

  /**
   * Transient message. Stacks, and trims the oldest past the cap.
   * @param {string} message
   * @param {'info'|'success'|'error'} [kind]
   */
  toast(message, kind = 'info') {
    const stack = this._toastStack;
    if (!stack || this._destroyed) return;

    const el = document.createElement('div');
    el.className = `toast toast--${TOAST_KINDS.has(kind) ? kind : 'info'}`;
    el.textContent = String(message ?? '');
    stack.appendChild(el);

    while (stack.children.length > MAX_TOASTS) {
      const oldest = stack.firstElementChild;
      if (!oldest) break;
      this._killToast(oldest);
      oldest.remove();
    }

    el._exitTimer = setTimeout(() => {
      el.classList.add('is-out');
      el._exitTimer = setTimeout(() => el.remove(), TOAST_EXIT_MS);
    }, TOAST_LIFETIME_MS);
  }

  _killToast(el) {
    if (el && el._exitTimer) {
      clearTimeout(el._exitTimer);
      el._exitTimer = 0;
    }
  }

  /* ---------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------- */

  /** Detach every listener and empty the overlay. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._disarmClear();
    this.root.removeEventListener('click', this._onClick);
    this.root.removeEventListener('change', this._onChange);
    this.root.removeEventListener('focusin', this._onFocusIn);
    this.root.removeEventListener('pointerover', this._onPointerOver);
    document.removeEventListener('keydown', this._onKeyDown, true);
    if (this._mq && this._onMotionChange) {
      if (typeof this._mq.removeEventListener === 'function') {
        this._mq.removeEventListener('change', this._onMotionChange);
      } else if (typeof this._mq.removeListener === 'function') {
        this._mq.removeListener(this._onMotionChange);
      }
    }
    if (this._toastStack) {
      for (const child of this._toastStack.children) this._killToast(child);
    }
    this.root.innerHTML = '';
    this._screens.clear();
    this._pwPool.length = 0;
  }
}
