/**
 * Unified input: keyboard, pointer/touch gestures and gamepad, funnelled into
 * one tiny event emitter so no gameplay code ever touches a DOM event.
 *
 * Events
 * ------
 *   'move'    -> 'up' | 'down' | 'left' | 'right'
 *   'pause'   'confirm'   'back'   'restart'   (no payload)
 *
 * `confirm` is deliberately *not* an implied forward hop: the game decides
 * whether Space means "hop" or "press the highlighted button", because the two
 * mean different things on the menu and in a run.
 *
 * The whole class is safe to construct without a DOM (SSR / unit tests): every
 * browser API it reaches for is feature-detected, and `update()` degrades to a
 * no-op when the Gamepad API is missing or blocked by permissions policy.
 */

import { clamp } from './math.js';

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/** Minimum travel, in CSS pixels, before a drag counts as a swipe. */
const SWIPE_MIN_PX = 24;
/** A press that moves less than this and ends quickly is a tap. */
const TAP_MAX_PX = 24;
const TAP_MAX_MS = 250;

/**
 * After a touch, browsers without Pointer Events synthesize a compatibility
 * mouse down/up pair (~300 ms later, at the same spot). Ignore mouse input for
 * this long after any touch so one tap is not read as two hops.
 */
const TOUCH_MOUSE_GUARD_MS = 700;

const PAD_DEADZONE = 0.55;
/** Held direction: fires once, waits, then auto-repeats at 8 Hz. */
const PAD_REPEAT_DELAY = 0.35;
const PAD_REPEAT_INTERVAL = 1 / 8;
/** How often to look for a pad when none is known to be connected. */
const PAD_SCAN_INTERVAL = 0.5;
/** Upper bound on the dt fed to the repeat clock, so a stall cannot burst. */
const MAX_POLL_DT = 0.1;

/* Standard gamepad mapping. */
const BTN_CONFIRM = 0;
const BTN_BACK = 1;
const BTN_START = 9;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;

const MASK_CONFIRM = 1;
const MASK_BACK = 2;
const MASK_START = 4;

/* ------------------------------------------------------------------ *
 * Key tables
 * ------------------------------------------------------------------ */

/**
 * Null-prototype so a lookup can only ever hit a key we put there. A plain
 * object literal would resolve `code === 'constructor'` / `'toString'` to an
 * inherited function and emit it as a movement direction.
 */
const table = (obj) => Object.freeze(Object.assign(Object.create(null), obj));

/**
 * Keyed by `KeyboardEvent.code` (physical position) so WASD still forms a
 * cluster on AZERTY/Dvorak layouts.
 */
const KEY_MOVE = table({
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
});

const KEY_EVENT = table({
  Space: 'confirm',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Escape: 'pause',
  KeyP: 'pause',
  Backspace: 'back',
  KeyR: 'restart',
});

/** Codes whose default action scrolls the page or walks browser history. */
const PREVENT_CODES = table({
  ArrowUp: 1,
  ArrowDown: 1,
  ArrowLeft: 1,
  ArrowRight: 1,
  Space: 1,
  Backspace: 1,
});

/** Elements that own their own pointer/keyboard semantics. */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, label, [role="button"], [data-no-gesture]';

const NOOP = () => {};

/* ------------------------------------------------------------------ *
 * Small free helpers (module scope: no per-event allocation)
 * ------------------------------------------------------------------ */

function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** `KeyboardEvent.code` with a `key` fallback for older/odd browsers. */
function codeOf(e) {
  if (e.code) return e.code;
  const k = e.key;
  if (!k) return '';
  if (k === ' ' || k === 'Spacebar') return 'Space';
  if (k.length === 1) return `Key${k.toUpperCase()}`;
  return k;
}

function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/** Something the browser will itself activate on Enter/Space. */
function isActivatable(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
  if (tag === 'A' && typeof el.hasAttribute === 'function' && el.hasAttribute('href')) return true;
  return typeof el.getAttribute === 'function' && el.getAttribute('role') === 'button';
}

function inInteractive(el) {
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest(INTERACTIVE_SELECTOR) !== null;
}

function padPressed(buttons, i) {
  const b = buttons && buttons[i];
  if (!b) return false;
  return typeof b === 'object' ? b.pressed === true || b.value > 0.5 : b > 0.5;
}

/**
 * D-pad first, then the left stick past the deadzone, locked to the dominant
 * axis so a diagonal push never resolves to two directions at once.
 * @returns {'up'|'down'|'left'|'right'|null}
 */
function readPadDirection(pad) {
  const b = pad.buttons;
  if (padPressed(b, DPAD_UP)) return 'up';
  if (padPressed(b, DPAD_DOWN)) return 'down';
  if (padPressed(b, DPAD_LEFT)) return 'left';
  if (padPressed(b, DPAD_RIGHT)) return 'right';

  const axes = pad.axes;
  if (!axes || axes.length < 2) return null;
  const x = axes[0] || 0;
  const y = axes[1] || 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax < PAD_DEADZONE && ay < PAD_DEADZONE) return null;
  if (ax >= ay) return x > 0 ? 'right' : 'left';
  return y > 0 ? 'down' : 'up'; // stick +Y points down, same as screen space
}

/* ------------------------------------------------------------------ *
 * InputManager
 * ------------------------------------------------------------------ */

export class InputManager {
  /**
   * @param {HTMLElement|null} [target] element that receives pointer gestures.
   *   Defaults to `document.body`. Passing the canvas keeps taps on the DOM
   *   overlay from being read as hops.
   */
  constructor(target = null) {
    /** @type {Map<string, Function[]>} copy-on-write handler lists. */
    this._listeners = new Map();
    this._enabled = true;
    this._destroyed = false;

    this._hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
    this.target = target || (this._hasDOM ? document.body : null);
    this._usePointerEvents = this._hasDOM && typeof window.PointerEvent === 'function';

    /* Pointer gesture state. */
    this._pointerId = -1;
    this._pointerDown = false;
    this._startX = 0;
    this._startY = 0;
    this._startT = 0;
    this._swipeFired = false;
    /** Timestamp of the last touch event, to reject compatibility mouse events. */
    this._lastTouchT = -Infinity;

    /* Gamepad state. */
    this._hasGamepadAPI =
      this._hasDOM && typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
    this._padIndex = -1;
    this._padMask = 0;
    this._padDir = null;
    this._padHold = 0;
    this._padNextRepeat = PAD_REPEAT_DELAY;
    this._padCount = 0;
    this._padActive = false;
    this._padScan = 0;
    this._padBroken = false;
    this._padSync = false;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove = this._onTouchMove.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._onTouchCancel = this._onTouchCancel.bind(this);
    this._onPadConnected = this._onPadConnected.bind(this);
    this._onPadDisconnected = this._onPadDisconnected.bind(this);

    this._attach();
  }

  /* ---------------------------------------------------------------- *
   * Emitter
   * ---------------------------------------------------------------- */

  /**
   * Subscribe to an input event.
   * @param {'move'|'pause'|'confirm'|'back'|'restart'} event
   * @param {(payload?: 'up'|'down'|'left'|'right') => void} fn
   * @returns {() => void} unsubscribe (idempotent)
   */
  on(event, fn) {
    if (typeof fn !== 'function' || this._destroyed) return NOOP;
    const arr = this._listeners.get(event);
    // Copy-on-write: `#emit` iterates the snapshot it captured, so subscribing
    // or unsubscribing from inside a handler cannot skip or double-fire one.
    this._listeners.set(event, arr ? arr.concat(fn) : [fn]);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.off(event, fn);
    };
  }

  /**
   * Remove a previously registered handler.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx === -1) return;
    const next = arr.slice();
    next.splice(idx, 1);
    if (next.length) this._listeners.set(event, next);
    else this._listeners.delete(event);
  }

  /** Dispatch to subscribers. Allocation-free: no spread, no iterator. */
  #emit(event, payload) {
    if (!this._enabled || this._destroyed) return;
    const arr = this._listeners.get(event);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](payload);
      } catch (err) {
        // One bad listener must never take down the input pipeline.
        console.error(`[input] handler for "${event}" threw`, err);
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /** @returns {boolean} true while a finger/mouse button is held on the target. */
  get isPointerDown() {
    return this._pointerDown;
  }

  /** @returns {boolean} whether events are currently being emitted. */
  get enabled() {
    return this._enabled;
  }

  /** Resume emitting. Listeners stay attached while disabled, so this is cheap. */
  enable() {
    if (this._destroyed || this._enabled) return;
    this._enabled = true;
    // Adopt whatever the pad is doing right now without firing for it.
    this._padSync = true;
  }

  /** Stop emitting and drop any in-flight gesture / held direction. */
  disable() {
    if (!this._enabled) return;
    this._enabled = false;
    this._cancelGesture();
    this._resetPad();
  }

  /** Detach every listener. The instance is inert afterwards. */
  destroy() {
    if (this._destroyed) return;
    this._detach();
    this._destroyed = true;
    this._enabled = false;
    this._cancelGesture();
    this._resetPad();
    this._listeners.clear();
    this.target = null;
  }

  /* ---------------------------------------------------------------- *
   * Gamepad polling
   * ---------------------------------------------------------------- */

  /**
   * Poll the Gamepad API. Call once per rendered frame — gamepads have no
   * events for axis/button state, only snapshots.
   * @param {number} dt seconds since the previous call
   */
  update(dt) {
    if (this._destroyed || !this._enabled || !this._hasGamepadAPI || this._padBroken) return;
    const step = clamp(typeof dt === 'number' && dt > 0 ? dt : 0, 0, MAX_POLL_DT);

    // `getGamepads()` allocates a fresh array every call, so only pay that per
    // frame once a pad is actually live. Some browsers never fire
    // `gamepadconnected` until a button is pressed, hence the slow scan.
    if (this._padCount <= 0 && !this._padActive) {
      this._padScan -= step;
      if (this._padScan > 0) return;
      this._padScan = PAD_SCAN_INTERVAL;
    }

    let pads = null;
    try {
      pads = navigator.getGamepads();
    } catch {
      // Blocked by a permissions policy or a hardened browser: stop asking.
      this._padBroken = true;
      return;
    }
    if (!pads) {
      this._padActive = false;
      return;
    }

    let pad = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (p && p.connected && p.buttons) {
        pad = p;
        break;
      }
    }

    if (!pad) {
      if (this._padActive) this._clearPad();
      this._padActive = false;
      return;
    }

    if (pad.index !== this._padIndex) {
      this._padIndex = pad.index;
      // A pad usually only becomes visible *because* the player pressed
      // something, so clear without latching — that first press must count.
      this._clearPad();
    }
    this._padActive = true;
    this._pollPad(pad, step);
  }

  _pollPad(pad, dt) {
    const b = pad.buttons;
    let mask = 0;
    if (padPressed(b, BTN_CONFIRM)) mask |= MASK_CONFIRM;
    if (padPressed(b, BTN_BACK)) mask |= MASK_BACK;
    if (padPressed(b, BTN_START)) mask |= MASK_START;
    const dir = readPadDirection(pad);

    if (this._padSync) {
      // First frame after enable/reconnect: latch state, emit nothing, so a
      // button that was already held does not read as a fresh press.
      this._padSync = false;
      this._padMask = mask;
      this._padDir = dir;
      this._padHold = 0;
      this._padNextRepeat = PAD_REPEAT_DELAY;
      return;
    }

    const rising = mask & ~this._padMask;
    this._padMask = mask;
    if (rising & MASK_CONFIRM) this.#emit('confirm');
    if (rising & MASK_BACK) this.#emit('back');
    if (rising & MASK_START) this.#emit('pause');

    if (dir !== this._padDir) {
      this._padDir = dir;
      this._padHold = 0;
      this._padNextRepeat = PAD_REPEAT_DELAY;
      if (dir) this.#emit('move', dir);
      return;
    }
    if (!dir) return;

    this._padHold += dt;
    while (this._padHold >= this._padNextRepeat) {
      this.#emit('move', dir);
      this._padNextRepeat += PAD_REPEAT_INTERVAL;
    }
  }

  /** Forget the held direction / button mask. The next poll emits normally. */
  _clearPad() {
    this._padMask = 0;
    this._padDir = null;
    this._padHold = 0;
    this._padNextRepeat = PAD_REPEAT_DELAY;
  }

  /**
   * Clear *and* latch: used when input resumes after being gated (focus loss,
   * disable), where a still-held button is not a new press.
   */
  _resetPad() {
    this._clearPad();
    this._padSync = true;
  }

  _onPadConnected() {
    this._padCount++;
  }

  _onPadDisconnected() {
    this._padCount = Math.max(0, this._padCount - 1);
    this._padIndex = -1;
    this._padActive = false;
    this._clearPad();
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  _onKeyDown(e) {
    if (!this._enabled || this._destroyed) return;

    const active = (typeof document !== 'undefined' && document.activeElement) || null;
    // Never steal a keystroke that is being typed into a field.
    if (isTextEntry(active) || isTextEntry(e.target)) return;
    // Leave browser/OS shortcuts (Ctrl+R, Cmd+Left, ...) alone.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const code = codeOf(e);
    const activatable = isActivatable(active) || isActivatable(e.target);

    // Swallow the page-scroll / history-back defaults, except Space on a
    // focused control — preventing that would kill the button's own click.
    if (PREVENT_CODES[code] && !(code === 'Space' && activatable) && e.cancelable !== false) {
      e.preventDefault();
    }

    // Held keys must not machine-gun moves; one press is one hop.
    if (e.repeat) return;

    const dir = KEY_MOVE[code];
    if (dir) {
      this.#emit('move', dir);
      return;
    }

    const evt = KEY_EVENT[code];
    if (!evt) return;
    // The browser already activates a focused button on Enter/Space; emitting
    // confirm as well would trigger the same action twice.
    if (evt === 'confirm' && activatable) return;
    this.#emit(evt);
  }

  _onBlur() {
    this._cancelGesture();
    this._resetPad();
  }

  _onVisibility() {
    if (typeof document !== 'undefined' && document.hidden) {
      this._cancelGesture();
      this._resetPad();
    }
  }

  /* ---------------------------------------------------------------- *
   * Gestures (source-agnostic core)
   * ---------------------------------------------------------------- */

  _gestureStart(x, y) {
    this._pointerDown = true;
    this._swipeFired = false;
    this._startX = x;
    this._startY = y;
    this._startT = nowMs();
  }

  _gestureMove(x, y) {
    if (!this._pointerDown || this._swipeFired) return;
    const dx = x - this._startX;
    const dy = y - this._startY;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax < SWIPE_MIN_PX && ay < SWIPE_MIN_PX) return;
    // Exactly one move per gesture, locked to the dominant axis.
    this._swipeFired = true;
    if (ax >= ay) this.#emit('move', dx > 0 ? 'right' : 'left');
    else this.#emit('move', dy > 0 ? 'down' : 'up'); // screen +Y is toward the camera
  }

  _gestureEnd(x, y) {
    if (!this._pointerDown) return;
    const swiped = this._swipeFired;
    const dx = x - this._startX;
    const dy = y - this._startY;
    const held = nowMs() - this._startT;
    this._pointerDown = false;
    this._swipeFired = false;
    this._pointerId = -1;
    if (swiped) return;
    if (dx * dx + dy * dy < TAP_MAX_PX * TAP_MAX_PX && held < TAP_MAX_MS) {
      this.#emit('move', 'up'); // tap = hop forward
    }
  }

  _cancelGesture() {
    // Blur/disable can land mid-drag; hand the capture back or the target keeps
    // swallowing pointer events for a gesture nobody is listening to any more.
    if (this._pointerId >= 0) this._releaseCapture(this._pointerId);
    this._pointerDown = false;
    this._swipeFired = false;
    this._pointerId = -1;
  }

  _releaseCapture(id) {
    const t = this.target;
    if (!t || typeof t.releasePointerCapture !== 'function') return;
    try {
      if (typeof t.hasPointerCapture !== 'function' || t.hasPointerCapture(id)) {
        t.releasePointerCapture(id);
      }
    } catch {
      // Capture may already be gone (element detached); nothing to do.
    }
  }

  /* ---------------------------------------------------------------- *
   * Pointer Events
   * ---------------------------------------------------------------- */

  _onPointerDown(e) {
    if (this._destroyed || this._pointerDown) return; // ignore secondary touches
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (inInteractive(e.target)) return; // let UI controls own their own taps
    this._pointerId = e.pointerId;
    this._gestureStart(e.clientX, e.clientY);
    const t = this.target;
    if (t && typeof t.setPointerCapture === 'function') {
      try {
        // Capture keeps move/up flowing even if the finger leaves the canvas.
        t.setPointerCapture(e.pointerId);
      } catch {
        // Best-effort only; the plain bubbling path still works.
      }
    }
  }

  _onPointerMove(e) {
    if (!this._pointerDown || e.pointerId !== this._pointerId) return;
    this._gestureMove(e.clientX, e.clientY);
  }

  _onPointerUp(e) {
    if (!this._pointerDown || e.pointerId !== this._pointerId) return;
    this._releaseCapture(e.pointerId);
    this._gestureEnd(e.clientX, e.clientY);
  }

  _onPointerCancel(e) {
    if (e.pointerId !== this._pointerId) return;
    this._releaseCapture(e.pointerId);
    this._cancelGesture();
  }

  /* ---------------------------------------------------------------- *
   * Mouse + touch fallback (browsers without Pointer Events)
   * ---------------------------------------------------------------- */

  _onMouseDown(e) {
    if (this._destroyed || this._pointerDown || e.button !== 0) return;
    // A tap already produced a gesture via touchstart/touchend; the browser's
    // compatibility mouse pair must not replay it as a second hop.
    if (nowMs() - this._lastTouchT < TOUCH_MOUSE_GUARD_MS) return;
    if (inInteractive(e.target)) return;
    this._pointerId = -2; // sentinel: a mouse gesture, not a touch id
    this._gestureStart(e.clientX, e.clientY);
  }

  _onMouseMove(e) {
    if (this._pointerId !== -2) return;
    this._gestureMove(e.clientX, e.clientY);
  }

  _onMouseUp(e) {
    if (this._pointerId !== -2) return;
    this._gestureEnd(e.clientX, e.clientY);
  }

  _findTouch(list, id) {
    if (!list) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === id) return list[i];
    }
    return null;
  }

  _onTouchStart(e) {
    this._lastTouchT = nowMs();
    if (this._destroyed || this._pointerDown) return;
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch || (e.touches && e.touches.length > 1)) return;
    if (inInteractive(e.target)) return;
    this._pointerId = touch.identifier;
    this._gestureStart(touch.clientX, touch.clientY);
  }

  _onTouchMove(e) {
    this._lastTouchT = nowMs();
    const t = this.target;
    // CSS `touch-action` is the real fix; this is the explicit opt-in for hosts
    // that still get rubber-band scrolling over the canvas.
    if (
      t &&
      typeof t.hasAttribute === 'function' &&
      t.hasAttribute('data-block-scroll') &&
      e.cancelable
    ) {
      e.preventDefault();
    }
    if (this._usePointerEvents) return;
    const touch = this._findTouch(e.changedTouches, this._pointerId);
    if (touch) this._gestureMove(touch.clientX, touch.clientY);
  }

  _onTouchEnd(e) {
    this._lastTouchT = nowMs();
    const touch = this._findTouch(e.changedTouches, this._pointerId);
    if (touch) this._gestureEnd(touch.clientX, touch.clientY);
  }

  _onTouchCancel(e) {
    this._lastTouchT = nowMs();
    if (this._findTouch(e.changedTouches, this._pointerId)) this._cancelGesture();
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  _attach() {
    if (!this._hasDOM) return;

    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onVisibility);

    if (this._hasGamepadAPI) {
      window.addEventListener('gamepadconnected', this._onPadConnected);
      window.addEventListener('gamepaddisconnected', this._onPadDisconnected);
    }

    const t = this.target;
    if (!t || typeof t.addEventListener !== 'function') return;

    if (this._usePointerEvents) {
      // A gesture may only *start* on the target, but it must be able to end
      // anywhere: `setPointerCapture` can be refused, and without it a release
      // over the DOM overlay would never reach a target-bound `pointerup`,
      // wedging `_pointerDown` true and killing every later gesture. The
      // pointerId check below keeps unrelated pointers out.
      t.addEventListener('pointerdown', this._onPointerDown);
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
      window.addEventListener('pointercancel', this._onPointerCancel);
    } else {
      t.addEventListener('mousedown', this._onMouseDown);
      window.addEventListener('mousemove', this._onMouseMove);
      window.addEventListener('mouseup', this._onMouseUp);
      t.addEventListener('touchstart', this._onTouchStart, { passive: true });
      t.addEventListener('touchend', this._onTouchEnd);
      t.addEventListener('touchcancel', this._onTouchCancel);
    }

    // Registered in both modes: it also carries the scroll-blocking opt-in.
    t.addEventListener('touchmove', this._onTouchMove, { passive: false });
  }

  _detach() {
    if (!this._hasDOM) return;

    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('gamepadconnected', this._onPadConnected);
    window.removeEventListener('gamepaddisconnected', this._onPadDisconnected);
    // Removed before the target guard: these live on `window`, so they must go
    // even when the target has been torn down already.
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerCancel);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mouseup', this._onMouseUp);

    const t = this.target;
    if (!t || typeof t.removeEventListener !== 'function') return;

    t.removeEventListener('pointerdown', this._onPointerDown);
    t.removeEventListener('mousedown', this._onMouseDown);
    t.removeEventListener('touchstart', this._onTouchStart);
    t.removeEventListener('touchend', this._onTouchEnd);
    t.removeEventListener('touchcancel', this._onTouchCancel);
    t.removeEventListener('touchmove', this._onTouchMove);
  }
}
