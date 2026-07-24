/**
 * Game orchestrator: owns the state machine, wires every system together and
 * is the only place that decides when the player dies.
 *
 * Simulation order inside one fixed step matters and is deliberate:
 *   1. world   — hazards move, recording an exact previous position
 *   2. player  — hop advances, riding applies, landing resolves water
 *   3. collide — swept test using both objects' displacement this step
 *   4. pickups, eagle, power-up timers, streaming
 * Anything that reorders these will introduce tunnelling or one-frame unfairness.
 */

import * as THREE from '../../vendor/three/three.module.js';

import {
  SAFE_ROWS,
  MILESTONE_EVERY,
  MILESTONE_BONUS,
  COIN_VALUE,
  DISTANCE_PER_COIN,
  ROWS_BEHIND,
  TILE,
} from '../core/constants.js';
import { clamp, rowToZ, formatNumber } from '../core/math.js';
import { buildVoxelModel } from '../render/voxel.js';
import { biomeForScore, PALETTE } from '../render/palette.js';
import { TerrainKit } from '../render/terrain.js';
import { PropFactory } from '../render/props.js';
import { Particles } from '../render/effects.js';
import { Stage, detectQuality } from '../render/scene.js';
import { World } from './rows.js';
import { Player } from './player.js';
import { GameCamera } from './camera.js';
import { Eagle } from './eagle.js';
import { PowerupSystem } from './powerups.js';
import { characterSpec, getCharacter } from '../data/characters.js';
import { getPowerup } from '../data/powerups.js';
import { submitScore, addCoins, saveProfile } from '../core/storage.js';

const DEATH_DELAY = 1.15;

export const STATE = {
  MENU: 'menu',
  PLAYING: 'playing',
  PAUSED: 'paused',
  DEAD: 'dead',
};

export class Game {
  /**
   * @param {object} deps
   * @param {HTMLCanvasElement} deps.canvas
   * @param {object} deps.profile
   * @param {import('../core/audio.js').AudioManager} deps.audio
   * @param {object} deps.ui
   */
  constructor({ canvas, profile, audio, ui }) {
    this.canvas = canvas;
    this.profile = profile;
    this.audio = audio;
    this.ui = ui;

    this.stage = new Stage(canvas, { quality: profile.settings?.quality });
    this.terrain = new TerrainKit();
    this.props = new PropFactory();
    this.particles = new Particles(this.stage.scene);
    this.world = new World({ scene: this.stage.scene, terrain: this.terrain, props: this.props });
    this.player = new Player();
    this.camera = new GameCamera();
    this.eagle = new Eagle(this.stage.scene, this.props);
    this.powerups = new PowerupSystem((id) => this._onPowerupEnd(id));

    this.state = STATE.MENU;
    this.score = 0;
    this.coins = 0;
    this.runSeed = 1;
    this.elapsed = 0;
    this.deathTimer = 0;
    this.nextMilestone = MILESTONE_EVERY;
    this.biome = biomeForScore(0);

    this.characterModel = null;
    this._characterId = null;

    this._playerCtx = {
      world: this.world,
      onHop: (dir) => this._onHop(dir),
      onLand: (rowType) => this._onLand(rowType),
      onBlocked: () => this.audio.play('error', { gain: 0.35 }),
      onDeath: (cause) => this.die(cause),
    };

    this._eagleCtx = {
      onWarn: () => this.audio.play('eagle'),
      onStrike: () => this.die('eagle'),
      graceBonus: 0,
    };

    this._hudState = { score: -1, best: -1, coins: -1 };
    this._audioScale = 1;
    /** Reused probe for the swept collision query — no per-step allocation. */
    this._probe = { prevX: 0, prevZ: 0, x: 0, z: 0, halfW: 0, halfD: 0 };
    this._onPickupBound = (type, payload) => this._onPickup(type, payload);
    this._holdJetpack = (id) => id === 'jetpack' && !this._canEndFlight();
    this._onTrainWarning = (row) => {
      // Horn volume falls off with distance so a far-off crossing is a hint,
      // not a jump scare.
      const dist = Math.abs(row.index - this.player.rowF);
      if (dist < 9) this.audio.play('train-horn', { gain: clamp(1 - dist / 12, 0.15, 1) });
    };

    this.applyCharacter(profile.selected);
    this.applySettings(profile.settings);
    this.enterMenu();
  }

  /* ================================================================ *
   * Character
   * ================================================================ */

  applyCharacter(id) {
    const character = getCharacter(id) || getCharacter('chicken');
    if (this._characterId === character.id && this.characterModel) return;
    this._characterId = character.id;

    if (this.characterModel) {
      this.characterModel.traverse((o) => o.geometry?.dispose());
      this.characterModel.removeFromParent();
    }
    this.characterModel = buildVoxelModel(characterSpec(character.id), { castShadow: true });
    this.characterModel.castShadow = true;
    this.stage.scene.add(this.characterModel);

    this.character = character;
    this.player.applyCharacter(character);
    this._eagleCtx.graceBonus = character.perk?.id === 'eagleGrace' ? character.perk.value : 0;
    this.powerups.magnetMultiplier =
      character.perk?.id === 'magnetRadius' ? clamp(character.perk.value, 1, 1.5) : 1;
  }

  /* ================================================================ *
   * Settings
   * ================================================================ */

  applySettings(settings = {}) {
    this.audio.setSfxEnabled(settings.sfx !== false);
    this.audio.setMusicEnabled(settings.music !== false);
    this.stage.setShadows(settings.shadows !== false);
    this.camera.enabled = settings.cameraShake !== false;
    // 'auto' hands control back to the frame-rate watcher in main.js, which
    // starts from the device's own capability estimate.
    const quality = settings.quality || 'auto';
    this.stage.setQuality(quality === 'auto' ? detectQuality() : quality);
    this._reducedMotion = !!settings.reducedMotion;
  }

  /* ================================================================ *
   * State transitions
   * ================================================================ */

  enterMenu() {
    this.state = STATE.MENU;
    this.runSeed = (Math.floor(Math.random() * 0x7fffffff) || 1) >>> 0;
    this._setupRun();
    this.camera.reset(this.player.rowF, this.player.x);
    this.ui?.show('menu');
    this.ui?.hide('hud');
  }

  start() {
    this.runSeed = (Math.floor(Math.random() * 0x7fffffff) || 1) >>> 0;
    this._setupRun();
    this.state = STATE.PLAYING;
    this.camera.reset(this.player.rowF, this.player.x);
    this.ui?.show('hud');
    this.audio.startMusic(this.biome.id);
    this.audio.setMusicIntensity(0.25);
  }

  _setupRun() {
    this.score = 0;
    this.coins = 0;
    this.elapsed = 0;
    this.deathTimer = 0;
    this.nextMilestone = MILESTONE_EVERY;

    this.world.reset(this.runSeed);
    this.player.reset(this.character);
    this.player.applyCharacter(this.character);
    this.powerups.reset();
    this.eagle.reset();
    this.particles.reset();

    this.biome = biomeForScore(0);
    this.stage.applyBiome(this.biome, true);
    this.terrain.applyBiome(this.biome);

    // A starting shield is a legendary perk, granted before the first hop.
    if (this.character?.perk?.id === 'startShield') this.powerups.activate('shield');

    this.world.ensure(0, 0);
    this._hudState.score = -1;
    this._hudState.coins = -1;
    this._hudState.best = -1;
  }

  pause() {
    if (this.state !== STATE.PLAYING) return;
    this.state = STATE.PAUSED;
    this.audio.suspend();
    this.ui?.show('paused');
  }

  resume() {
    if (this.state !== STATE.PAUSED) return;
    this.state = STATE.PLAYING;
    this.audio.resume();
    this.ui?.show('hud');
  }

  togglePause() {
    if (this.state === STATE.PLAYING) this.pause();
    else if (this.state === STATE.PAUSED) this.resume();
  }

  restart() {
    this.audio.resume();
    this.start();
  }

  toMenu() {
    this.audio.resume();
    this.audio.stopMusic();
    this.enterMenu();
  }

  /* ================================================================ *
   * Death
   * ================================================================ */

  /** @param {'car'|'train'|'water'|'eagle'|'void'} cause */
  die(cause) {
    if (this.state !== STATE.PLAYING || !this.player.alive) return;
    if (this.powerups.invulnerable) return;
    if (this.player.invulnerable > 0 && cause !== 'void') return;

    if (this.powerups.consumeShield()) {
      this.player.survive(cause, this.world);
      this.audio.play('shield-break');
      this.particles.burst(this.player.x, 0.5, this.player.z, {
        count: 22,
        color: PALETTE.shield,
        speed: 3.4,
        up: 2.2,
        life: 0.6,
      });
      this.camera.shake(0.5);
      this.ui?.toast('Shield absorbed the hit!', 'success');
      return;
    }

    if (!this.player.kill(cause)) return;

    this.state = STATE.DEAD;
    this.deathTimer = 0;
    // The eagle only keeps flying if it was the one that got you.
    if (cause !== 'eagle') this.eagle.standDown();

    const px = this.player.x;
    const pz = this.player.z;
    switch (cause) {
      case 'water':
        this.audio.play('splash');
        this.particles.splash(px, 0, pz, this.biome.water);
        this.camera.shake(0.28);
        break;
      case 'car':
        this.audio.play('crash');
        this.particles.burst(px, 0.35, pz, { count: 26, color: '#ffffff', speed: 4.2, up: 2.6 });
        this.camera.shake(1);
        break;
      case 'train':
        this.audio.play('crash', { rate: 0.7, gain: 1.2 });
        this.particles.burst(px, 0.35, pz, { count: 34, color: '#ffd9a0', speed: 6, up: 3 });
        this.camera.shake(1.4);
        break;
      case 'eagle':
        this.audio.play('eagle', { rate: 1.2 });
        this.camera.shake(0.5);
        break;
      default:
        this.audio.play('thud');
        this.camera.shake(0.3);
    }
    this.audio.play('death');
    this.audio.setMusicIntensity(0);
  }

  _finishRun() {
    const cause = this.player.deathCause || 'void';
    const score = this.score;

    const perk = this.character?.perk;
    const bonus = perk?.id === 'coinBonus' ? clamp(perk.value, 1, 1.15) : 1;
    // Distance pays too, so a long clean run is worth something even when the
    // route happened to be short on coins.
    const distanceBonus = Math.floor(score / DISTANCE_PER_COIN);
    const earned = Math.round((this.coins + distanceBonus) * bonus);

    addCoins(this.profile, earned);
    const stats = this.profile.stats?.deaths;
    if (stats && cause in stats) stats[cause]++;

    const result = submitScore(this.profile, {
      score,
      coins: earned,
      character: this.character.id,
      biome: this.biome.id,
    });
    saveProfile(this.profile);

    this.audio.stopMusic();
    this.ui?.setGameOver({
      score,
      best: this.profile.bestScore,
      coins: earned,
      rank: result.rank,
      isBest: result.isBest,
      cause,
      character: this.character.name,
    });
    this.ui?.show('gameover');
    this.ui?.hide('hud');
    if (result.isBest) this.audio.play('milestone');
  }

  /* ================================================================ *
   * Events
   * ================================================================ */

  handleMove(dir) {
    if (this.state !== STATE.PLAYING) return;
    if (this.powerups.flying) return; // the jetpack steers itself
    this.player.requestMove(dir);
  }

  /**
   * Each character has its own hop voice. The synth's `hop` sweep is authored
   * around a ~480 Hz start, so a character's `baseFreq` becomes a playback
   * rate relative to that — which also shortens or lengthens the blip, so
   * heavy characters land with a lower, longer thud.
   */
  _onHop() {
    const voice = this.character?.hopSound;
    if (!voice) return this.audio.play('hop');
    this.audio.play('hop', {
      rate: clamp(voice.baseFreq / 480, 0.45, 1.8),
      type: voice.type,
    });
  }

  _onLand(rowType) {
    if (rowType === 'water') this.audio.play('jump-land', { rate: 1.15, gain: 0.5 });
    else this.audio.play('jump-land', { gain: 0.45 });
    if (!this._reducedMotion) {
      this.particles.burst(this.player.x, 0.04, this.player.z, {
        count: 4,
        color: rowType === 'water' ? this.biome.water : '#ffffff',
        speed: 0.9,
        up: 0.6,
        life: 0.3,
        size: 0.06,
        gravity: 6,
      });
    }
  }

  _onPickup(type, payload) {
    if (type === 'coin') {
      const value = COIN_VALUE * this.powerups.coinMultiplier;
      this.coins += value;
      this.audio.play('coin', { rate: 1 + Math.min(0.4, this.coins * 0.004) });
      this.particles.burst(payload.x, payload.y, payload.z, {
        count: 8,
        color: PALETTE.coin,
        speed: 1.8,
        up: 1.6,
        life: 0.45,
        size: 0.075,
      });
      return;
    }

    const def = getPowerup(payload.id);
    this.powerups.activate(payload.id);
    this.audio.play('powerup');
    this.particles.burst(payload.x, payload.y, payload.z, {
      count: 20,
      color: def?.color || '#ffffff',
      speed: 3,
      up: 2.2,
      life: 0.6,
    });
    this.ui?.toast(`${def?.icon || ''} ${def?.name || 'Power-up'}!`, 'success');
    if (payload.id === 'jetpack') this.camera.shake(0.3);
  }

  _onPowerupEnd(id) {
    this.audio.play('powerup-end', { gain: 0.5 });
    if (id === 'jetpack') this.camera.shake(0.2);
  }

  _canEndFlight() {
    const row = this.player.hop.active ? this.player.hop.toRow : this.player.gridRow;
    const type = this.world.rowType(row);
    if (type !== 'water') return true;
    return !!this.world.platformAt(row, this.player.x, this.player.grip);
  }

  /* ================================================================ *
   * Simulation
   * ================================================================ */

  fixedUpdate(dt) {
    if (this.state === STATE.PAUSED) return;

    const playing = this.state === STATE.PLAYING;
    const scale = playing ? this.powerups.timeScale : 1;
    const sdt = dt * scale;

    // Bend the soundtrack with the world so slow-motion reads in the ears too.
    if (scale !== this._audioScale) {
      this._audioScale = scale;
      this.audio.setTimeScale(scale);
    }

    this.world.fixedUpdate(sdt);

    if (playing || this.state === STATE.DEAD) {
      this.player.flying = playing && this.powerups.flying;
      this.player.fixedUpdate(sdt, this._playerCtx);

      if (playing && this.player.alive) {
        const probe = this._probe;
        probe.prevX = this.player.prevX;
        probe.prevZ = this.player.prevZ;
        probe.x = this.player.x;
        probe.z = this.player.z;
        probe.halfW = this.player.halfW;
        probe.halfD = this.player.halfD;
        const hit = this.world.hitTestPlayer(probe);
        if (hit) this.die(hit.cause);
      }

      if (playing && this.player.alive) {
        this.world.collect(
          this.player.x,
          this.player.rowF,
          this.powerups.magnetRadius,
          sdt,
          this._onPickupBound,
        );
        this.eagle.fixedUpdate(sdt, this.player, this._eagleCtx);
        this.powerups.fixedUpdate(dt, this._holdJetpack);
        this._updateScore();
      } else if (this.state === STATE.DEAD) {
        this.eagle.fixedUpdate(sdt, this.player, this._eagleCtx);
        this.deathTimer += dt;
        if (this.deathTimer >= DEATH_DELAY) {
          this.state = STATE.MENU;
          this._finishRun();
        }
      }
    }

    this.world.ensure(this.player.rowF, this.score);

    this.world.forEachNewWarning(this._onTrainWarning);
  }

  _updateScore() {
    const s = this.player.score;
    if (s <= this.score) return;
    this.score = s;

    const nextBiome = biomeForScore(s);
    if (nextBiome !== this.biome) {
      this.biome = nextBiome;
      this.stage.applyBiome(nextBiome);
      this.terrain.applyBiome(nextBiome);
      this.audio.startMusic(nextBiome.id);
      this.ui?.toast(`${nextBiome.name}`, 'info');
    }

    this.audio.setMusicIntensity(clamp(s / 220, 0.2, 1));

    if (s >= this.nextMilestone) {
      this.nextMilestone += MILESTONE_EVERY;
      this.coins += MILESTONE_BONUS;
      this.audio.play('milestone');
      this.ui?.toast(`${formatNumber(s)} rows! +${MILESTONE_BONUS} coins`, 'success');
      this.particles.burst(this.player.x, 0.7, this.player.z, {
        count: 24,
        color: PALETTE.coin,
        speed: 3.2,
        up: 2.6,
        life: 0.8,
      });
    }
  }

  /* ================================================================ *
   * Presentation
   * ================================================================ */

  render(alpha, frameDt) {
    this.elapsed += frameDt;

    const lead = this.powerups.flying ? 1.6 : 0;
    if (this.state !== STATE.PAUSED) {
      this.camera.update(frameDt, this.player, lead);
      this.terrain.update(frameDt);
      this.particles.update(frameDt);
      this.stage.update(frameDt, this.camera.focus);
    }

    this.world.render(alpha, this.elapsed);
    this.eagle.render(alpha, this.elapsed);

    if (this.characterModel) {
      this.player.applyToModel(this.characterModel, alpha, frameDt, this.elapsed);
      if (this.state === STATE.MENU && this.player.alive) {
        // Gentle idle bob on the menu so the character feels alive.
        this.characterModel.position.y += Math.sin(this.elapsed * 2.4) * 0.045 + 0.045;
        this.characterModel.rotation.y = Math.sin(this.elapsed * 0.7) * 0.5;
      }
    }

    this._updateHud();
    this.stage.render(this.camera.camera);
  }

  _updateHud() {
    if (!this.ui) return;
    if (this.state !== STATE.PLAYING && this.state !== STATE.DEAD && this.state !== STATE.PAUSED) return;
    const best = Math.max(this.profile.bestScore || 0, this.score);
    this.ui.setHUD({
      score: this.score,
      best,
      coins: this.coins,
      powerups: this.powerups.hudList(),
      eagle: this.eagle.countdown,
    });
  }

  resize(width, height) {
    this.stage.resize(width, height);
    this.camera.resize(width / Math.max(1, height));
  }

  dispose() {
    this.world.dispose();
    this.eagle.dispose();
    this.particles.dispose();
    this.terrain.dispose();
    this.props.dispose();
    this.stage.dispose();
  }
}

export { THREE, SAFE_ROWS, ROWS_BEHIND, TILE, rowToZ };
