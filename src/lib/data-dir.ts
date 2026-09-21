// Where Lookout keeps what it writes: cases, scenes, recorded tracks, the aircraft registry, the
// watchlist. One root, overridable with LOOKOUT_DATA_DIR; each store hangs a subdirectory off it.
// The kit defaults to ~/.lookout (the private console it came from uses another root).
import os from 'node:os';
import path from 'node:path';

// The hosted demo reads its committed sample tracks and scenes from ./data (a read-only filesystem).
export const DATA_DIR = process.env.LOOKOUT_DATA_DIR || (process.env.LOOKOUT_DEMO === '1' ? path.resolve('data') : path.join(os.homedir(), '.lookout'));

export function dataDir(...parts: string[]): string { return path.join(DATA_DIR, ...parts); }
