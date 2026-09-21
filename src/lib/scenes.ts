/**
 * Scenes — shot lists the 3D theater can record and play back (src/lib/theater/director.ts).
 * Stored as JSON files under <LOOKOUT_DATA_DIR>/scenes, like cases. Local only.
 * A scene is a presentation object, not evidence: saving one INTO a case goes through the
 * case's own addFinding path so it gets a collection timestamp and a hash like anything else.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { newSceneDocument, validateSceneDocument, type SceneDocument } from '@/lib/theater/director';
import { dataDir } from '@/lib/data-dir';

export const SCENES_DIR = dataDir('scenes');

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export function validSceneId(id: string): boolean { return ID_RE.test(id); }

const file = (id: string) => path.join(SCENES_DIR, `${id}.json`);
async function ensureDir() { await fs.mkdir(SCENES_DIR, { recursive: true }); }

export interface SceneSummary { id: string; title: string; shots: number; createdAt: string; updatedAt: string }

export async function listScenes(): Promise<SceneSummary[]> {
  await ensureDir();
  const names = (await fs.readdir(SCENES_DIR)).filter((n) => n.endsWith('.json'));
  const out: SceneSummary[] = [];
  for (const n of names) {
    try {
      const doc = JSON.parse(await fs.readFile(path.join(SCENES_DIR, n), 'utf8')) as SceneDocument;
      out.push({ id: doc.id, title: doc.title, shots: doc.shots?.length ?? 0, createdAt: doc.createdAt, updatedAt: doc.updatedAt });
    } catch (e) {
      // One corrupt file must not hide the rest; say which one.
      console.warn(`[scenes] skipping unreadable ${n}:`, e instanceof Error ? e.message : e);
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function readScene(id: string): Promise<SceneDocument | null> {
  if (!validSceneId(id)) return null;
  try {
    const v = validateSceneDocument(JSON.parse(await fs.readFile(file(id), 'utf8')));
    return v.ok ? v.doc : null;
  } catch { return null; }
}

/** Validates, stamps updatedAt, writes. Returns the errors instead of throwing on bad input. */
export async function writeScene(input: unknown): Promise<{ ok: true; doc: SceneDocument } | { ok: false; errors: string[] }> {
  const v = validateSceneDocument(input);
  if (!v.ok) return v;
  if (!validSceneId(v.doc.id)) return { ok: false, errors: ['id must be 6–64 letters, digits, _ or -'] };
  await ensureDir();
  const doc = { ...v.doc, updatedAt: new Date().toISOString() };
  await fs.writeFile(file(doc.id), JSON.stringify(doc, null, 2));
  return { ok: true, doc };
}

export async function createScene(title: string): Promise<SceneDocument> {
  const doc = newSceneDocument(title.trim().slice(0, 120) || 'Untitled scene');
  const r = await writeScene(doc);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.doc;
}

export async function deleteScene(id: string): Promise<boolean> {
  if (!validSceneId(id)) return false;
  try { await fs.unlink(file(id)); return true; } catch { return false; }
}
