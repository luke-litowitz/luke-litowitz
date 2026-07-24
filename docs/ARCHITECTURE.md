# Crossy Cascade — Architecture & Module Contracts

A 3D "cross the road" arcade game. Plain ES modules, no build step, no CDN.
Three.js is vendored at `vendor/three/three.module.js` and imported with a
relative path from every renderer-facing module.

```
import * as THREE from '../../vendor/three/three.module.js';   // from src/<dir>/x.js
import * as THREE from '../vendor/three/three.module.js';      // from src/x.js
```

Run it with any static server: `npm start` (serves the repo root on :8080).

---

## 1. Coordinate system

| axis | meaning |
|------|---------|
| `col` → world **X** | left/right. `+col` is right on screen. |
| `row` → world **Z** | forward. `+row` is *away* from the camera, i.e. `z = -row`. |
| world **Y** | up. Ground surface is `y = 0`. |

Helpers in `src/core/math.js`: `colToX`, `rowToZ`, `xToCol`, `zToRow`.

Gameplay is authored in `(row, col)`. Only the renderer touches Three.js axes.

Playfield spans `COL_MIN=-9 .. COL_MAX=9`; the player is clamped to
`PLAY_COL_MIN=-8 .. PLAY_COL_MAX=8`.

## 2. Simulation model

`src/core/loop.js` runs a fixed-timestep accumulator at `FIXED_DT = 1/120`
with render interpolation. Every system exposes:

- `fixedUpdate(dt, ctx)` — deterministic simulation. `dt` is always `FIXED_DT`.
- `render(alpha, ctx)` — visual-only interpolation/animation. `alpha ∈ [0,1)`.

`ctx` is the live `Game` instance.

All collision goes through `sweptAABB` (`src/core/math.js`) so nothing tunnels
at high speed. Trains move ~26 u/s; at 120 Hz that is 0.21 u/step, well under
the player's 0.6 u width, but sweeping is used anyway for exactness.

## 3. Foundation modules (already written — do not modify)

| file | exports |
|------|---------|
| `src/core/constants.js` | all tuning constants (see file) |
| `src/core/math.js` | `clamp lerp invLerp smoothstep damp approach angleDelta dampAngle colToX rowToZ xToCol zToRow hopArc hopEase makeAABB setAABB aabbOverlap aabbContainsPoint sweptAABB sweepHits SeededRNG hashInt hash01 formatNumber formatTime` |
| `src/render/voxel.js` | `buildBoxesGeometry buildVoxelModel getVoxelMaterial specBounds recolorSpec extendSpec disposeObject3D disposeMaterialCache` |
| `src/render/palette.js` | `PALETTE BIOMES VEHICLE_COLORS biomeForScore biomeBlend` |

### Voxel spec format

```js
{
  scale: 1,
  parts: [{
    name: 'body',
    pivot: [x, y, z],                 // part origin relative to model origin
    material: 'lambert',              // 'lambert'|'basic'|'phong'|'glass'|'glow'
    opacity: 1,
    boxes: [{ pos: [x,y,z], size: [w,h,d], color: '#rrggbb' }],
  }],
}
```

`buildVoxelModel(spec)` returns a `THREE.Group` with `.parts` — a
`name -> THREE.Mesh` map for animation. **Model origin = centre of the
footprint at ground level (`y = 0`).** Boxes are positioned relative to their
part's `pivot`; rotating `group.parts.leftLeg` rotates about that pivot.

---

## 4. Module contracts

### `src/core/storage.js`
```js
export const DEFAULT_PROFILE      // frozen template
export function loadProfile()     // -> profile (migrated, validated)
export function saveProfile(p)    // debounced write to localStorage
export function resetProfile()
export function addCoins(p, n)
export function spendCoins(p, n)  // -> boolean
export function unlockCharacter(p, id)
export function isUnlocked(p, id)
export function submitScore(p, entry)  // entry {score, coins, character, biome}
                                       // -> {rank:number|null, isBest:boolean}
export function getLeaderboard(p)      // sorted, capped at LEADERBOARD_SIZE
export function clearLeaderboard(p)
```
Profile shape:
```js
{
  version: 1, name: 'Player', coins: 0, bestScore: 0, totalRuns: 0,
  totalCoins: 0, totalDistance: 0, selected: 'chicken',
  unlocked: ['chicken'], leaderboard: [], stats: {deaths:{car:0,train:0,water:0,eagle:0,void:0}},
  settings: { sfx: true, music: true, shadows: true, quality: 'auto', reducedMotion: false, cameraShake: true },
  seenTutorial: false,
}
```
Must be crash-proof: corrupt/absent localStorage falls back to defaults, and
every write is wrapped in try/catch (private browsing throws on setItem).

### `src/core/audio.js`
```js
export class AudioManager {
  constructor()
  unlock()                       // call from a user gesture
  get ready()
  setSfxEnabled(b); setMusicEnabled(b); setMasterVolume(v)
  play(name, opts?)              // opts: {rate, gain, pan}
  startMusic(biomeId?); stopMusic(); setMusicIntensity(0..1)
  setTimeScale(s)                // pitch-bends music for slow-mo
  suspend(); resume()
}
```
100% procedural WebAudio — **no audio files**. Required sound names:
`hop jump-land coin coin-big splash crash thud train-horn train-pass
powerup powerup-end shield-break unlock buy menu-move menu-select menu-back
eagle death countdown milestone tick error`.

### `src/core/input.js`
```js
export class InputManager {
  constructor(target)            // target: HTMLElement for pointer/touch
  on(event, fn)                  // 'move' -> ('up'|'down'|'left'|'right'),
                                 // 'pause', 'confirm', 'back', 'restart'
  enable(); disable(); destroy()
  get isPointerDown()
}
```
Sources: WASD + arrow keys, swipe (min 24 px, direction locked to dominant
axis), tap-to-hop-forward, and Gamepad API polled from `update(dt)`.
Keyboard repeat must not spam `move`.

### `src/data/characters.js`
```js
export const CHARACTERS = [ ... ]   // ~16 entries
export function getCharacter(id)
export function characterSpec(id)   // -> voxel spec
export const RARITIES = { common:{...}, rare:{...}, epic:{...}, legendary:{...} }
```
Character entry:
```js
{
  id, name, rarity, price,            // price 0 = free/starter
  description,
  hopSound: { baseFreq, type },       // consumed by AudioManager.play('hop', {...})
  perk: null | { id, label, value },  // see §5
  build: () => voxelSpec,             // lazily built spec
}
```
Perk ids the game engine honours: `coinBonus` (multiplier on coin value),
`eagleGrace` (extra idle seconds), `hopSpeed` (hop duration multiplier,
clamp 0.8–1.2), `magnetRadius` (multiplier), `startShield` (bool),
`riverGrip` (extra platform grip margin). Keep perks small (±15%).

### `src/data/powerups.js`
```js
export const POWERUPS = [ ... ]
export function getPowerup(id)
export function rollPowerup(rng, score)   // -> id
```
Entry: `{ id, name, icon, color, duration, description, weight, build(): spec }`.
Required ids: `magnet`, `shield`, `doubler`, `slowmo`, `jetpack`.

### `src/render/models.js`
Pure factory functions returning voxel **specs** (not Three objects), so the
game can pool and rebuild them:
```js
export function carSpec(color, variant)      // variant 0..3, footprint ~1.7 x 0.95
export function truckSpec(color)             // ~3.0 long
export function busSpec(color)               // ~3.4 long
export function trainCarSpec(kind)           // 'engine' | 'car', ~4.6 long
export function logSpec(lengthTiles)         // 1..4
export function lilypadSpec()
export function treeSpec(variant, rng)       // 3 variants
export function rockSpec(rng)
export function bushSpec(rng)
export function coinSpec()
export function crateSpec(color)             // power-up crate
export function signalSpec()                 // rail warning post; parts.lamp
export function eagleSpec()                  // parts.leftWing/rightWing/body
export const VEHICLE_TYPES = [ ... ]         // {id, spec, length, width, weight, speedMul, honk}
```
Vehicles face **+X** in model space (the game rotates them by π for `-X` lanes).
Length is along X, width along Z. Keep every vehicle's width ≤ 0.95 so lanes
read clearly.

### `src/ui/screens.js` + `styles/main.css`
DOM overlay on top of the canvas. See §6.

---

## 5. Game systems (core, hand-written)

```
src/game/config.js     difficulty curves
src/game/worldgen.js   row planning + guaranteed-solvable reachability
src/game/rows.js       Row objects (grass/road/water/rail) + pooling
src/game/traffic.js    vehicle, log and train spawners
src/game/player.js     hop state machine, carriers, death causes
src/game/powerups.js   active effect stack
src/game/coins.js      pickups + magnet
src/game/eagle.js      anti-camping predator
src/game/camera.js     follow + shake
src/game/game.js       orchestrator / state machine
src/main.js            bootstrap
```

### Player hop rules (the "accurate physics" part)

1. A hop is a ballistic arc of fixed duration. Height follows `4t(1-t)` —
   the exact parabola of projectile motion.
2. **Landing on solid ground** (grass/road/rail): the target X is snapped to a
   tile centre, computed at take-off. Blocked tiles (trees/rocks) reject the
   move outright — the hop never starts.
3. **Landing on water**: X is continuous, not snapped. Target X =
   `startX + dirX * TILE + carrierVx * HOP_DURATION * PLATFORM_MOMENTUM_INHERITANCE`.
   Momentum from the log you left is conserved through the flight.
4. On landing in a water row the game queries that row for a platform whose
   surface contains the player's X (within `PLATFORM_GRIP_MARGIN`). Hit →
   attach as carrier. Miss → drown.
5. While attached, `player.x += carrier.vx * dt` every fixed step. Drifting past
   `BOUND_X` is a `void` death.
6. Vehicles/trains are tested with `sweptAABB` using **relative** displacement
   `(vehicleV - playerV) * dt`, so a car cannot pass through a hopping player.
7. The player is airborne above `y = 0.28` — vehicles still hit them (they are
   not tall enough to clear traffic), which keeps hops from being an exploit.

### Death causes
`'car' | 'train' | 'water' | 'eagle' | 'void'` — each drives a distinct
camera/sfx/animation response.

---

## 6. UI contract

Single `#ui` overlay with one `<section class="screen" data-screen="…">` per
screen: `loading`, `menu`, `characters`, `leaderboard`, `settings`, `hud`,
`paused`, `gameover`. Exactly one is active at a time (`.screen.is-active`),
except `hud` which is shown alongside gameplay.

`src/ui/screens.js` exports:
```js
export class UI {
  constructor(root, { profile, audio, onAction })
  show(name); hide(name); get current
  setHUD({score, best, coins, powerups})
  setGameOver({score, best, coins, rank, cause, isBest})
  refreshCharacters(); refreshLeaderboard(); refreshSettings()
  toast(message, kind)
}
```
`onAction(name, payload)` is the single channel back to the game:
`start`, `resume`, `restart`, `home`, `pause`, `select-character`,
`buy-character`, `open`, `set-setting`, `set-name`, `clear-leaderboard`.

Everything must be keyboard-navigable and touch-friendly (44 px targets),
and must respect `prefers-reduced-motion`.

---

## 7. Non-negotiables

- No network requests at runtime. No external fonts, no CDNs.
- 60 fps on integrated graphics: pool rows/vehicles, merge geometry, cap
  shadow-casting objects, never allocate in `fixedUpdate`.
- Deterministic given a seed: no `Math.random()` in gameplay code — use
  `SeededRNG`. (Cosmetic-only randomness may use `Math.random`.)
- Pause must halt simulation *and* audio, and survive tab blur.
- Every generated stretch of world must be provably crossable (see
  `worldgen.js` reachability pass).
