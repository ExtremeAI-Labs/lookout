/**
 * Lookout — case store. A PI works a subject over time; this persists findings, notes, and a
 * timeline to local disk (<LOOKOUT_DATA_DIR>/cases). Local only.
 */
import type { Reconstruction } from '@/lib/reconstruction';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dataDir } from '@/lib/data-dir';

/** Stable JSON (sorted keys) so a finding's hash is reproducible regardless of key order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}
export function sha256(data: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(data)).digest('hex');
}

export const CASES_DIR = dataDir('cases');

export interface Finding {
  id: string;
  ts: string;               // collected_at — when this finding entered the case
  tool: string;
  query: string;
  summary?: string;
  analysis?: string;        // the LLM brief, if the user analysed it before saving
  data?: unknown;           // the raw result JSON
  sha256?: string;          // SHA-256 of the data at collection time (tamper-evidence)
}
export interface CaseFile {
  id: string;
  name: string;
  created: string;
  updated: string;
  notes: string;
  findings: Finding[];
  /** the case's evidence placed in space and time — see src/lib/reconstruction.ts */
  reconstruction?: Reconstruction;
}

const ID_RE = /^[0-9a-f]{12,32}$/;
export function validId(id: string): boolean { return ID_RE.test(id); }

async function ensureDir() { await fs.mkdir(CASES_DIR, { recursive: true }); }
function file(id: string) { return path.join(CASES_DIR, `${id}.json`); }

export interface CaseSummary { id: string; name: string; created: string; updated: string; findings: number }

export async function listCases(): Promise<CaseSummary[]> {
  await ensureDir();
  let files: string[] = [];
  try { files = (await fs.readdir(CASES_DIR)).filter((f) => f.endsWith('.json')); } catch { files = []; }
  const out = await Promise.all(files.map(async (f): Promise<CaseSummary | null> => {
    try {
      const c = JSON.parse(await fs.readFile(path.join(CASES_DIR, f), 'utf8')) as CaseFile;
      return { id: c.id, name: c.name, created: c.created, updated: c.updated, findings: (c.findings || []).length };
    } catch { return null; }
  }));
  return out
    .filter((x): x is CaseSummary => x !== null)
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
}

export async function readCase(id: string): Promise<CaseFile | null> {
  if (!validId(id)) return null;
  try { return JSON.parse(await fs.readFile(file(id), 'utf8')) as CaseFile; } catch { return null; }
}

export async function writeCase(c: CaseFile): Promise<void> {
  await ensureDir();
  c.updated = new Date().toISOString();
  await fs.writeFile(file(c.id), JSON.stringify(c, null, 2));
}

export async function createCase(name: string): Promise<CaseFile> {
  await ensureDir();
  const now = new Date().toISOString();
  const c: CaseFile = { id: crypto.randomBytes(8).toString('hex'), name: name.trim() || 'Untitled case', created: now, updated: now, notes: '', findings: [] };
  await writeCase(c);
  return c;
}

export async function deleteCase(id: string): Promise<boolean> {
  if (!validId(id)) return false;
  try { await fs.unlink(file(id)); return true; } catch { return false; }
}

export function newFinding(f: Omit<Finding, 'id' | 'ts' | 'sha256'>): Finding {
  // Chain of custody: stamp collection time and hash the raw data now, so any later change to the
  // stored record is detectable. Computed server-side; the operator cannot forge an earlier time.
  return {
    id: crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    ...f,
    sha256: f.data !== undefined ? sha256(f.data) : undefined,
  };
}

/** Re-hash each finding's stored data and report whether it still matches the recorded hash. */
export function verifyCase(c: CaseFile): { id: string; ok: boolean; recorded?: string; actual?: string }[] {
  return (c.findings || []).map((f) => {
    if (!f.sha256 || f.data === undefined) return { id: f.id, ok: true };
    const actual = sha256(f.data);
    return { id: f.id, ok: actual === f.sha256, recorded: f.sha256, actual };
  });
}
