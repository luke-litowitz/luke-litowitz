/**
 * Global tuning constants for Crossy Cascade.
 *
 * Coordinate system
 * -----------------
 *   col  -> world X   (right on screen is +col / +X)
 *   row  -> world Z   (forward / away from camera is +row, which is -Z)
 *   up   -> world Y   (ground surface sits at y = 0)
 *
 * Conversion helpers live in `src/core/math.js` (`colToX`, `rowToZ`).
 * Every gameplay system works in (row, col) space; only the renderer cares
 * about the Three.js axes.
 */

export const TILE = 1;
export const HALF_TILE = TILE * 0.5;

/* ------------------------------------------------------------------ *
 * Playfield
 * ------------------------------------------------------------------ */

export const COL_MIN = -9;
export const COL_MAX = 9;
export const COL_COUNT = COL_MAX - COL_MIN + 1; // 19 columns

/** Hard wall: the player can never move past these tile centres. */
export const PLAY_COL_MIN = COL_MIN + 1;
export const PLAY_COL_MAX = COL_MAX - 1;

/** X coordinate beyond which a floating player is lost (carried off screen). */
export const BOUND_X = (COL_MAX + 1.5) * TILE;

/** How far off-screen traffic spawns / despawns, in tiles. */
export const TRAFFIC_MARGIN = 8 * TILE;

/* ------------------------------------------------------------------ *
 * Simulation
 * ------------------------------------------------------------------ */

/** Fixed simulation step. 120 Hz keeps swept collisions cheap and exact. */
export const FIXED_DT = 1 / 120;
/** Never simulate more than this many steps in one frame (spiral-of-death guard). */
export const MAX_SUBSTEPS = 8;
/** Frames longer than this are treated as a stall and discarded. */
export const MAX_FRAME_TIME = 0.25;

/* ------------------------------------------------------------------ *
 * Player
 * ------------------------------------------------------------------ */

export const HOP_DURATION = 0.15;
export const HOP_HEIGHT = 0.55;
export const PLAYER_HALF_W = 0.3;
export const PLAYER_HALF_D = 0.3;
export const PLAYER_HEIGHT = 0.78;

/** Squash/stretch envelope applied over a hop. */
export const HOP_SQUASH = 0.22;

/** A direction pressed while airborne is remembered for this long. */
export const INPUT_BUFFER_TIME = 0.2;
export const MAX_QUEUED_MOVES = 2;

/**
 * When hopping off a moving platform the player keeps the platform's
 * horizontal momentum (Newton's first law). 1 = full inheritance.
 * Only applies when the destination row is also water; landings on solid
 * ground always snap to the tile grid.
 */
export const PLATFORM_MOMENTUM_INHERITANCE = 1;

/** Player must stay within this much of a platform's surface to keep footing. */
export const PLATFORM_GRIP_MARGIN = 0.08;

/* ------------------------------------------------------------------ *
 * Eagle (anti-camping)
 * ------------------------------------------------------------------ */

/** Seconds of no forward progress before the eagle is summoned. */
export const EAGLE_IDLE_LIMIT = 7;
/** Rows behind the furthest row reached before the eagle is summoned. */
export const EAGLE_TRAIL_LIMIT = 4;
/** Warning time between the shadow appearing and the grab. */
export const EAGLE_WARNING = 1.15;

/* ------------------------------------------------------------------ *
 * Scoring & economy
 * ------------------------------------------------------------------ */

export const COIN_VALUE = 1;
export const COIN_PICKUP_RADIUS = 0.62;

/**
 * Coins always have a little pull, not just under the magnet power-up.
 * Without it, collection requires landing on a coin's exact column — with 17
 * playable columns that is a ~5% chance per coin, which starves the economy
 * to the point where the cheapest character costs ~90 runs.
 */
export const COIN_MAGNET_BASE = 1.7;
/** Radius while the magnet power-up is active. */
export const COIN_MAGNET_RADIUS = 3.8;

/** Score milestone that awards bonus coins. */
export const MILESTONE_EVERY = 25;
export const MILESTONE_BONUS = 5;
/** Coins awarded per this many rows survived, paid out at the end of a run. */
export const DISTANCE_PER_COIN = 12;

/* ------------------------------------------------------------------ *
 * World generation
 * ------------------------------------------------------------------ */

/** Rows kept alive behind the player before recycling. */
export const ROWS_BEHIND = 12;
/** Rows generated ahead of the player. */
export const ROWS_AHEAD = 26;
/** Safe grass rows at the start of a run. */
export const SAFE_ROWS = 4;

/** Difficulty saturates at this score. */
export const DIFFICULTY_MAX_SCORE = 320;

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */

export const CAMERA_OFFSET = { x: 7.2, y: 11.5, z: 11.2 };
export const CAMERA_LOOK_AHEAD = 2.6;
/** Vertical half-size of the orthographic frustum, in world units. */
export const CAMERA_VIEW_SIZE = 8.6;
export const CAMERA_FOLLOW_SPEED = 7.5;
/** Camera pushes the player forward once they fall behind this screen fraction. */
export const CAMERA_PUSH_START_SCORE = 1e9; // disabled by default; endless mode

/* ------------------------------------------------------------------ *
 * Row / terrain visuals
 * ------------------------------------------------------------------ */

export const GROUND_TOP_Y = 0;
export const ROAD_SINK = 0.02;
export const WATER_SINK = 0.24;
export const RAIL_SINK = 0.01;

/** Length of one train car along X. Worldgen and the row runtime must agree. */
export const TRAIN_CAR_LENGTH = 4.6;

export const LOG_TOP_Y = 0.16;
export const LILYPAD_TOP_Y = 0.06;

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export const STORAGE_KEY = 'crossy-cascade:v1';
export const LEADERBOARD_SIZE = 12;
export const DEFAULT_CHARACTER = 'chicken';
