/**
 * Fixed-timestep game loop with render interpolation.
 *
 * Simulation always advances in exact `FIXED_DT` slices so collisions,
 * traffic phases and hop arcs are frame-rate independent and reproducible.
 * Rendering receives the leftover `alpha` so visuals stay smooth on displays
 * that are not a multiple of the simulation rate.
 */

import { FIXED_DT, MAX_SUBSTEPS, MAX_FRAME_TIME } from './constants.js';

export class GameLoop {
  /**
   * @param {object} opts
   * @param {(dt:number)=>void} opts.fixedUpdate  called 0..MAX_SUBSTEPS times per frame
   * @param {(alpha:number, frameDt:number)=>void} opts.render
   * @param {(info:{fps:number, steps:number})=>void} [opts.onStats]
   */
  constructor({ fixedUpdate, render, onStats }) {
    this._fixedUpdate = fixedUpdate;
    this._render = render;
    this._onStats = onStats;

    this._running = false;
    this._rafId = 0;
    this._last = 0;
    this._accumulator = 0;

    // Rolling FPS estimate, reported roughly twice a second.
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.fps = 60;
    this.lastSteps = 0;

    this._tick = this._tick.bind(this);
  }

  get running() {
    return this._running;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._accumulator = 0;
    this._rafId = requestAnimationFrame(this._tick);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  /**
   * Drop any accumulated time. Call after a long stall (tab restored, screen
   * transition) so the simulation does not fast-forward.
   */
  resync() {
    this._last = performance.now();
    this._accumulator = 0;
  }

  _tick(now) {
    if (!this._running) return;
    this._rafId = requestAnimationFrame(this._tick);

    let frameDt = (now - this._last) / 1000;
    this._last = now;

    // A hidden tab or a blocking main-thread task can produce an enormous
    // delta. Clamp instead of trying to catch up, which would tunnel physics.
    if (frameDt > MAX_FRAME_TIME) frameDt = FIXED_DT;
    if (frameDt < 0) frameDt = 0;

    this._accumulator += frameDt;

    let steps = 0;
    while (this._accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      this._fixedUpdate(FIXED_DT);
      this._accumulator -= FIXED_DT;
      steps++;
    }
    // Bleed off any remainder we refused to simulate so we do not drift.
    if (steps === MAX_SUBSTEPS && this._accumulator > FIXED_DT) {
      this._accumulator = 0;
    }
    this.lastSteps = steps;

    this._render(this._accumulator / FIXED_DT, frameDt);

    this._fpsAccum += frameDt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
      if (this._onStats) this._onStats({ fps: this.fps, steps });
    }
  }
}
