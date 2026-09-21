'use client';
// Scenes: a shot list recorded from the 3D camera and played back — the theater's way of
// walking someone through a place (a client, a jury, a recording). Authoring is a few taps:
// frame the view, CAPTURE. Every change autosaves; a scene can be filed into a case, where
// it gets a collection timestamp and a hash like any other finding.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { captureShot, runScene, type SceneDocument, type SceneShot, type SceneShotCamera } from '@/lib/theater/director';
import { SENSOR_STYLES } from '@/lib/theater/styles';
import type { TheaterLayerId } from '@/lib/theater/layers';

export type SceneBridge = {
  captureCamera: () => SceneShotCamera | null;
  currentStyle: string;
  currentLayers: Record<string, boolean>;
  applyStyle: (name: string) => void;
  applyLayers: (layers: Record<string, boolean>) => void;
  travel: (camera: SceneShotCamera, durationSec: number, signal: AbortSignal) => Promise<void>;
  jumpTo: (camera: SceneShotCamera) => void;
  onPlayingChange: (playing: boolean) => void;
};

type Summary = { id: string; title: string; shots: number; updatedAt: string };
type CaseSummary = { id: string; name: string };

const styleLabel = (name?: string) => SENSOR_STYLES.find((s) => s.name === name)?.label ?? 'NORMAL';

export function ScenesPanel({ bridge, open, onOpenChange, initialSceneId, autoplay }: {
  bridge: SceneBridge; open: boolean; onOpenChange: (o: boolean) => void; initialSceneId?: string | null; autoplay?: boolean;
}) {
  const [list, setList] = useState<Summary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [doc, setDoc] = useState<SceneDocument | null>(null);
  const [current, setCurrent] = useState<number>(-1);
  const [playing, setPlaying] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error' | 'idle'>('idle');
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [filed, setFiled] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const autoplayed = useRef(false);

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch('/api/scenes', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setList((await res.json()).scenes || []);
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);

  const load = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/scenes/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const scene = (await res.json()).scene as SceneDocument;
      setDoc(scene);
      setCurrent(scene.shots.length ? 0 : -1);
      setFiled(null);
      const qs = new URLSearchParams(window.location.search);
      qs.set('scene', scene.id);
      window.history.replaceState(null, '', `?${qs.toString()}`);
    } catch (e) {
      setListError(`could not open scene: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => { if (initialSceneId) void load(initialSceneId); }, [initialSceneId, load]);

  // autosave: every edit lands on disk within a second
  const persist = useCallback((next: SceneDocument) => {
    setDoc(next);
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/scenes/${encodeURIComponent(next.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: next }) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSaveState('saved');
        void refreshList();
      } catch (e) {
        console.error('[scenes] autosave failed:', e);
        setSaveState('error');
      }
    }, 800);
  }, [refreshList]);

  const create = useCallback(async () => {
    const title = window.prompt('Scene title', `Scene ${new Date().toLocaleDateString()}`);
    if (title === null) return;
    try {
      const res = await fetch('/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const scene = (await res.json()).scene as SceneDocument;
      setDoc(scene); setCurrent(-1); setFiled(null);
      void refreshList();
    } catch (e) {
      setListError(`could not create scene: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [refreshList]);

  const remove = useCallback(async () => {
    if (!doc || !window.confirm(`Delete scene “${doc.title}”? This cannot be undone.`)) return;
    await fetch(`/api/scenes/${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
    setDoc(null); setCurrent(-1);
    const qs = new URLSearchParams(window.location.search); qs.delete('scene'); window.history.replaceState(null, '', `?${qs.toString()}`);
    void refreshList();
  }, [doc, refreshList]);

  const capture = useCallback(() => {
    if (!doc) return;
    const cam = bridgeRef.current.captureCamera();
    if (!cam) return;
    const shot = captureShot(cam, { style: bridgeRef.current.currentStyle, layers: bridgeRef.current.currentLayers, label: `Shot ${doc.shots.length + 1}` });
    const shots = [...doc.shots];
    const at = current >= 0 ? current + 1 : shots.length;
    shots.splice(at, 0, shot);
    persist({ ...doc, shots });
    setCurrent(at);
  }, [doc, current, persist]);

  const updateShot = useCallback(() => {
    if (!doc || current < 0) return;
    const cam = bridgeRef.current.captureCamera();
    if (!cam) return;
    const shots = doc.shots.map((s, i) => (i === current ? { ...s, camera: cam, style: bridgeRef.current.currentStyle, layers: bridgeRef.current.currentLayers } : s));
    persist({ ...doc, shots });
  }, [doc, current, persist]);

  const editShot = useCallback((i: number, patch: Partial<SceneShot>) => {
    if (!doc) return;
    persist({ ...doc, shots: doc.shots.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  }, [doc, persist]);

  const deleteShot = useCallback((i: number) => {
    if (!doc) return;
    const shots = doc.shots.filter((_, j) => j !== i);
    persist({ ...doc, shots });
    setCurrent(Math.min(i, shots.length - 1));
  }, [doc, persist]);

  const move = useCallback((i: number, dir: -1 | 1) => {
    if (!doc) return;
    const j = i + dir;
    if (j < 0 || j >= doc.shots.length) return;
    const shots = [...doc.shots];
    [shots[i], shots[j]] = [shots[j], shots[i]];
    persist({ ...doc, shots });
    setCurrent(j);
  }, [doc, persist]);

  const seek = useCallback((i: number) => {
    if (!doc || !doc.shots[i]) return;
    setCurrent(i);
    const s = doc.shots[i];
    if (s.style) bridgeRef.current.applyStyle(s.style);
    if (s.layers) bridgeRef.current.applyLayers(s.layers);
    bridgeRef.current.jumpTo(s.camera);
  }, [doc]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const play = useCallback(async (from = 0) => {
    if (!doc || !doc.shots.length) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPlaying(true);
    bridgeRef.current.onPlayingChange(true);
    try {
      await runScene(doc, {
        selectShot: (_s, i) => setCurrent(i),
        applyVisual: (style) => bridgeRef.current.applyStyle(style || 'normal'),
        applyLayers: (layers) => { if (layers) bridgeRef.current.applyLayers(layers); },
        travel: (camera, durationSec, signal) => bridgeRef.current.travel(camera, durationSec, signal ?? controller.signal),
        hold: (seconds, signal) => new Promise<void>((resolve) => {
          const s = signal ?? controller.signal;
          const t = setTimeout(resolve, seconds * 1000);
          s.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        }),
        completeShot: () => {},
      }, { signal: controller.signal, startAt: from });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setPlaying(false);
      bridgeRef.current.onPlayingChange(false);
    }
  }, [doc]);

  useEffect(() => {
    if (autoplay && doc && doc.shots.length && !autoplayed.current) { autoplayed.current = true; void play(0); }
  }, [autoplay, doc, play]);

  useEffect(() => () => { abortRef.current?.abort(); clearTimeout(saveTimer.current); }, []);

  const fileToCase = useCallback(async () => {
    if (!doc) return;
    if (!cases) {
      try {
        const res = await fetch('/api/cases', { cache: 'no-store' });
        const json = await res.json();
        setCases((json.cases || []).map((c: CaseSummary) => ({ id: c.id, name: c.name })));
      } catch { setCases([]); }
      return;
    }
  }, [doc, cases]);

  const fileInto = useCallback(async (caseId: string) => {
    if (!doc) return;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addFinding: { tool: 'scene', query: doc.title, summary: `3D scene · ${doc.shots.length} shots · open: /theater?scene=${doc.id}&play=1`, data: doc } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setFiled(caseId);
      setCases(null);
    } catch (e) {
      setListError(`could not file into case: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc]);

  const copyJson = useCallback(async () => {
    if (!doc) return;
    try { await navigator.clipboard.writeText(JSON.stringify(doc, null, 2)); setSaveState('saved'); } catch { /* clipboard blocked: the file on disk is the copy */ }
  }, [doc]);

  const importJson = useCallback(async () => {
    setImportError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(importText); } catch { setImportError('that is not JSON'); return; }
    try {
      const res = await fetch('/api/scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ document: parsed }) });
      const json = await res.json();
      if (!res.ok) { setImportError([json.error, ...(json.details || [])].join(' · ')); return; }
      setDoc(json.scene); setCurrent(json.scene.shots.length ? 0 : -1); setImportOpen(false); setImportText('');
      void refreshList();
    } catch (e) { setImportError(e instanceof Error ? e.message : String(e)); }
  }, [importText, refreshList]);

  const total = useMemo(() => (doc ? doc.shots.reduce((s, x) => s + x.durationSec + x.holdSec, 0) : 0), [doc]);

  return (
    <aside className={`theater-scenes ${open ? 'is-open' : ''}`} aria-label="Scenes">
      <button className="theater-btn theater-scenes-toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>{open ? 'SCENES ▸' : '◂ SCENES'}</button>
      {open && (
        <div className="theater-scenes-body">
          <div className="theater-scenes-head">
            <span className="theater-card-kind">SCENES</span>
            <span className={`theater-scenes-save is-${saveState}`}>{saveState === 'saving' ? 'saving…' : saveState === 'saved' ? 'saved' : saveState === 'error' ? 'save failed' : ''}</span>
          </div>
          {listError && <div className="theater-scenes-error" role="alert">{listError}</div>}

          {!doc && (
            <>
              {list === null && !listError && <div className="theater-card-detail">Loading scenes…</div>}
              {list && list.length === 0 && <div className="theater-card-detail">No scenes yet. Frame a view and capture your first shot.</div>}
              {list && list.length > 0 && (
                <ul className="theater-scenes-list">
                  {list.map((s) => (
                    <li key={s.id}><button onClick={() => load(s.id)}><span>{s.title}</span><em>{s.shots} shot{s.shots === 1 ? '' : 's'}</em></button></li>
                  ))}
                </ul>
              )}
              <div className="theater-card-actions">
                <button className="theater-btn" onClick={create}>NEW SCENE</button>
                <button className="theater-btn" onClick={() => setImportOpen((o) => !o)}>IMPORT JSON</button>
              </div>
              {importOpen && (
                <div className="theater-scenes-import">
                  <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="Paste a scene document" rows={5} aria-label="Scene JSON" />
                  {importError && <div className="theater-scenes-error" role="alert">{importError}</div>}
                  <button className="theater-btn" onClick={importJson} disabled={!importText.trim()}>IMPORT</button>
                </div>
              )}
            </>
          )}

          {doc && (
            <>
              <div className="theater-scenes-title">
                <button className="theater-card-close" onClick={() => { stop(); setDoc(null); setCurrent(-1); }} aria-label="Back to scene list">‹</button>
                <input value={doc.title} onChange={(e) => persist({ ...doc, title: e.target.value.slice(0, 120) })} aria-label="Scene title" />
              </div>
              <div className="theater-card-detail">{doc.shots.length} shot{doc.shots.length === 1 ? '' : 's'} · {Math.round(total)} s{playing ? ' · PLAYING' : ''}</div>
              <ol className="theater-shots">
                {doc.shots.map((s, i) => (
                  <li key={s.id} className={i === current ? 'is-current' : ''}>
                    <button className="theater-shot-main" onClick={() => seek(i)} disabled={playing}>
                      <b>{i + 1}</b>
                      <input value={s.label || ''} placeholder={`Shot ${i + 1}`} onClick={(e) => e.stopPropagation()} onChange={(e) => editShot(i, { label: e.target.value.slice(0, 80) })} aria-label={`Shot ${i + 1} label`} />
                      <span>{styleLabel(s.style)} · {Math.round(s.camera.alt).toLocaleString()} m</span>
                    </button>
                    <div className="theater-shot-edit">
                      <label>travel <input type="number" min={0} max={600} step={0.5} value={s.durationSec} onChange={(e) => editShot(i, { durationSec: Math.max(0, Math.min(600, Number(e.target.value) || 0)) })} />s</label>
                      <label>hold <input type="number" min={0} max={600} step={0.5} value={s.holdSec} onChange={(e) => editShot(i, { holdSec: Math.max(0, Math.min(600, Number(e.target.value) || 0)) })} />s</label>
                      <button onClick={() => move(i, -1)} disabled={i === 0 || playing} aria-label="Move up">↑</button>
                      <button onClick={() => move(i, 1)} disabled={i === doc.shots.length - 1 || playing} aria-label="Move down">↓</button>
                      <button onClick={() => deleteShot(i)} disabled={playing} aria-label="Delete shot">✕</button>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="theater-card-actions">
                <button className="theater-btn is-primary" onClick={capture} disabled={playing}>CAPTURE SHOT</button>
                <button className="theater-btn" onClick={updateShot} disabled={playing || current < 0}>UPDATE SHOT</button>
                {!playing ? <button className="theater-btn" onClick={() => play(0)} disabled={!doc.shots.length}>PLAY</button> : <button className="theater-btn" onClick={stop}>STOP</button>}
                {!playing && current > 0 && <button className="theater-btn" onClick={() => play(current)}>PLAY FROM {current + 1}</button>}
              </div>
              <div className="theater-card-actions">
                <button className="theater-btn" onClick={fileToCase} disabled={playing}>{filed ? 'FILED ✓' : 'SAVE TO CASE'}</button>
                <button className="theater-btn" onClick={copyJson}>COPY JSON</button>
                <button className="theater-btn is-danger" onClick={remove} disabled={playing}>DELETE</button>
              </div>
              {cases && !filed && (
                <div className="theater-scenes-cases">
                  {cases.length === 0 && <div className="theater-card-detail">No cases yet — create one in the console first.</div>}
                  {cases.map((c) => <button key={c.id} className="theater-btn" onClick={() => fileInto(c.id)}>{c.name}</button>)}
                  <button className="theater-btn" onClick={() => setCases(null)}>CANCEL</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
