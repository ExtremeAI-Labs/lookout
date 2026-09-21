'use client';
// HISTORY — replay what the operator's own receiver recorded. Pick a window (≤ 6 h), load it,
// scrub or play it back, and file any aircraft's track into a case as a hash-sealed finding.
// Honest about provenance: the panel says whether the fixes came from sealed hours, and
// whether anything is being recorded at all.
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { Track } from '@/lib/tracks/store';
import { NewCase } from './CaseNew';

export type HistoryBridge = {
  setTracks: (tracks: Track[]) => void;
  setPlayhead: (t: number) => void;
  flyToTrack: (hex: string) => void;
};
export type HistoryInfo = { from: number; to: number; tracks: number; fixes: number; playhead: number; playing: boolean };
export type HistoryHandle = { load: (fromMs: number, toMs: number) => Promise<{ ok: boolean; note?: string; tracks?: number; fixes?: number }>; info: () => HistoryInfo | null };

type RecorderStatus = { configured: boolean; reason?: string; url?: string; lastOkAt?: number | null; lastError?: string | null; fixesRecorded?: number; aircraftInRange?: number; running?: boolean };
type StatusPayload = { recorder: RecorderStatus; store: { days: { day: string; bytes: number; sealedSegments: number }[]; totalBytes: number }; latestDay: { day: string; ok: boolean; sealedHours: number } | null; fetchedAt?: number };
type Loaded = { from: number; to: number; tracks: Track[]; fixCount: number; truncated: boolean; sealedLines: number; unsealedLines: number };
type CaseSummary = { id: string; name: string };

const SPEEDS = [1, 10, 60, 600];
const MAX_WINDOW_MS = 6 * 3_600_000;
const fmtClock = (t: number) => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
const toLocalInput = (t: number) => { const d = new Date(t - new Date().getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };
const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.round(n / 1e3)} kB`);

export function HistoryPanel({ bridge, open, onOpenChange, handleRef, initialWindow, onSelectTrack }: {
  bridge: HistoryBridge; open: boolean; onOpenChange: (o: boolean) => void;
  handleRef: MutableRefObject<HistoryHandle | null>;
  initialWindow?: { from: number; to: number } | null;
  onSelectTrack?: (hex: string) => void;
}) {
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [from, setFrom] = useState(() => toLocalInput(Date.now() - 3_600_000));
  const [to, setTo] = useState(() => toLocalInput(Date.now()));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [exportFor, setExportFor] = useState<string | null>(null);
  const [exportCase, setExportCase] = useState('');
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrame = useRef(0);
  const loadedRef = useRef<Loaded | null>(null);
  const playheadRef = useRef(0);
  const playingRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/tracks/status', { cache: 'no-store' });
      const j = (await r.json()) as StatusPayload & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setStatus({ ...j, fetchedAt: Date.now() }); setStatusError(null);
    } catch (e) { setStatusError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetches recorder status when the panel opens; state lands after the await
    if (open) void refreshStatus();
  }, [open, refreshStatus]);

  const applyPlayhead = useCallback((t: number) => { playheadRef.current = t; setPlayhead(t); bridge.setPlayhead(t); }, [bridge]);

  const load = useCallback(async (fromMs: number, toMs: number) => {
    setLoading(true); setError(null); setExportMsg(null);
    try {
      if (!(toMs > fromMs)) throw new Error('the window must end after it starts');
      if (toMs - fromMs > MAX_WINDOW_MS) throw new Error('windows are limited to 6 hours');
      const r = await fetch(`/api/tracks?from=${fromMs}&to=${toMs}`, { cache: 'no-store' });
      const j = (await r.json()) as { error?: string; tracks: Track[]; fixCount: number; truncated: boolean; sealedLines: number; unsealedLines: number };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      const l: Loaded = { from: fromMs, to: toMs, tracks: j.tracks, fixCount: j.fixCount, truncated: j.truncated, sealedLines: j.sealedLines, unsealedLines: j.unsealedLines };
      loadedRef.current = l; setLoaded(l);
      setFrom(toLocalInput(fromMs)); setTo(toLocalInput(toMs));
      bridge.setTracks(j.tracks);
      const start = j.tracks.length ? Math.max(fromMs, Math.min(...j.tracks.map((t) => t.fixes[0][0]))) : fromMs;
      applyPlayhead(start);
      setPlaying(false); playingRef.current = false;
      return { ok: true, tracks: j.tracks.length, fixes: j.fixCount, note: j.tracks.length ? undefined : 'no recorded fixes in that window' };
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      setError(note);
      return { ok: false, note };
    } finally { setLoading(false); }
  }, [bridge, applyPlayhead]);

  // What the assistant and the URL can drive.
  useEffect(() => {
    handleRef.current = {
      load,
      info: () => (loadedRef.current ? { from: loadedRef.current.from, to: loadedRef.current.to, tracks: loadedRef.current.tracks.length, fixes: loadedRef.current.fixCount, playhead: playheadRef.current, playing: playingRef.current } : null),
    };
    return () => { handleRef.current = null; };
  }, [handleRef, load]);
  // A window handed in by the URL (?history=) or the assistant: load it once per distinct window.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- applies the deep-linked window after mount
    if (initialWindow) void load(initialWindow.from, initialWindow.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialWindow?.from, initialWindow?.to]);

  // Playback: wall-clock × speed, stops at the end of the window.
  useEffect(() => {
    if (!playing) { if (rafRef.current) cancelAnimationFrame(rafRef.current); rafRef.current = null; return; }
    lastFrame.current = performance.now();
    const step = (now: number) => {
      const l = loadedRef.current;
      if (!l) return;
      const dt = (now - lastFrame.current) * speed;
      lastFrame.current = now;
      const next = playheadRef.current + dt;
      if (next >= l.to) { applyPlayhead(l.to); setPlaying(false); playingRef.current = false; return; }
      applyPlayhead(next);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playing, speed, applyPlayhead]);
  const togglePlay = () => { const l = loadedRef.current; if (!l) return; if (!playing && playheadRef.current >= l.to) applyPlayhead(l.from); const p = !playing; setPlaying(p); playingRef.current = p; };

  const quick = (ms: number) => { const now = Date.now(); void load(now - ms, now); };
  const submitWindow = () => { const f = Date.parse(from), t = Date.parse(to); if (!Number.isFinite(f) || !Number.isFinite(t)) { setError('enter both times'); return; } void load(f, t); };

  const openExport = async (hex: string) => {
    setExportFor(hex); setExportMsg(null);
    if (!cases) {
      try { const r = await fetch('/api/cases'); const j = (await r.json()) as { cases?: CaseSummary[] }; setCases(j.cases ?? []); if (j.cases?.length) setExportCase(j.cases[0].id); }
      catch { setCases([]); }
    }
  };
  const doExport = async () => {
    const l = loadedRef.current;
    if (!l || !exportFor || !exportCase) return;
    setExportMsg('saving…');
    try {
      const r = await fetch('/api/tracks/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId: exportCase, hex: exportFor, from: new Date(l.from).toISOString(), to: new Date(l.to).toISOString() }) });
      const j = (await r.json()) as { error?: string; fixes?: number; sha256?: string; unsealedLines?: number };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setExportMsg(`filed: ${j.fixes} fixes, sha256 ${j.sha256?.slice(0, 12)}…${j.unsealedLines ? ` (${j.unsealedLines} from the open hour)` : ''}`);
      setExportFor(null);
    } catch (e) { setExportMsg(`export failed: ${e instanceof Error ? e.message : String(e)}`); }
  };

  const rec = status?.recorder;
  const recLine = useMemo(() => {
    if (statusError) return `status unavailable: ${statusError}`;
    if (!status) return 'checking the recorder…';
    if (!rec?.configured) return 'not recording — set LOOKOUT_RECEIVER_URL to your own receiver';
    const age = rec.lastOkAt && status.fetchedAt ? Math.max(0, Math.round((status.fetchedAt - rec.lastOkAt) / 1000)) : null;
    return `${rec.running ? 'recording' : 'stopped'} from ${new URL(rec.url ?? 'http://x').host} · ${rec.aircraftInRange ?? 0} in range · ${rec.fixesRecorded?.toLocaleString() ?? 0} fixes this run${age !== null ? ` · ok ${age} s ago` : ''}${rec.lastError ? ` · ERROR ${rec.lastError}` : ''}`;
  }, [status, statusError, rec]);

  return (
    <div className="theater-history">
      <button type="button" className="theater-pill theater-history-toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>{open ? '▸' : '◂'} HISTORY</button>
      {open && (
        <div className="theater-history-body" role="region" aria-label="Recorded history">
          <div className="theater-history-head">
            <span className="theater-history-title">RECORDED · OWN RECEIVER</span>
            <button type="button" className="theater-pill" onClick={() => void refreshStatus()} title="Refresh status">↻</button>
          </div>
          <p className={`theater-history-status ${rec?.lastError || statusError ? 'is-err' : ''}`}>{recLine}</p>
          {status && rec?.configured === false && (
            <p className="theater-history-hint">{rec.reason} An RTL-SDR-class 1090 MHz dongle running readsb / dump1090 on the Mac mini or a Pi is enough; only your own receiver is ever recorded.</p>
          )}
          {status && status.store.days.length > 0 && (
            <p className="theater-history-store">{status.store.days.length} day{status.store.days.length === 1 ? '' : 's'} on disk · {fmtBytes(status.store.totalBytes)}{status.latestDay ? ` · ${status.latestDay.day}: ${status.latestDay.sealedHours} sealed hours ${status.latestDay.ok ? 'verify ✓' : 'VERIFY FAILED'}` : ''}</p>
          )}

          <div className="theater-history-window">
            <div className="theater-history-quick">
              <button type="button" className="theater-pill" onClick={() => quick(15 * 60_000)} disabled={loading}>LAST 15 MIN</button>
              <button type="button" className="theater-pill" onClick={() => quick(3_600_000)} disabled={loading}>1 H</button>
              <button type="button" className="theater-pill" onClick={() => quick(6 * 3_600_000)} disabled={loading}>6 H</button>
            </div>
            <label>FROM <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>TO <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <button type="button" className="theater-pill is-primary" onClick={submitWindow} disabled={loading}>{loading ? 'LOADING…' : 'LOAD'}</button>
          </div>
          {error && <p className="theater-history-error" role="alert">{error}</p>}

          {loaded && (
            <>
              <p className="theater-history-summary">
                {loaded.tracks.length} track{loaded.tracks.length === 1 ? '' : 's'} · {loaded.fixCount.toLocaleString()} fixes · {loaded.sealedLines.toLocaleString()} from sealed hours{loaded.unsealedLines ? `, ${loaded.unsealedLines.toLocaleString()} from the open hour` : ''}{loaded.truncated ? ' · TRUNCATED — narrow the window' : ''}
              </p>
              {loaded.tracks.length === 0 && <p className="theater-history-hint">Nothing recorded in that window.</p>}
              {loaded.tracks.length > 0 && (
                <div className="theater-history-scrub">
                  <div className="theater-history-clock" aria-live="polite">{fmtClock(playhead)}</div>
                  <input type="range" min={loaded.from} max={loaded.to} step={1000} value={playhead} onChange={(e) => { setPlaying(false); playingRef.current = false; applyPlayhead(Number(e.target.value)); }} aria-label="Playhead" />
                  <div className="theater-history-controls">
                    <button type="button" className="theater-pill is-primary" onClick={togglePlay}>{playing ? '❚❚ PAUSE' : '▶ PLAY'}</button>
                    {SPEEDS.map((s) => <button key={s} type="button" className={`theater-pill ${speed === s ? 'is-on' : ''}`} onClick={() => setSpeed(s)}>{s}×</button>)}
                  </div>
                </div>
              )}
              {loaded.tracks.length > 0 && (
                <ul className="theater-history-list">
                  {loaded.tracks.slice(0, 200).map((t) => (
                    <li key={t.hex}>
                      <button type="button" className="theater-history-track" onClick={() => { setPlaying(false); playingRef.current = false; applyPlayhead(Math.max(loaded.from, t.fixes[0][0])); bridge.flyToTrack(t.hex); onSelectTrack?.(t.hex); }}>
                        <b>{t.callsign || t.hex.toUpperCase()}</b>{t.military && <span className="theater-history-mil">MIL</span>}
                        <span>{t.fixes.length} fixes · {fmtClock(t.fixes[0][0]).slice(11, 19)}–{fmtClock(t.fixes[t.fixes.length - 1][0]).slice(11, 19)}</span>
                      </button>
                      <button type="button" className="theater-pill" onClick={() => void openExport(t.hex)} title="File this track into a case">CASE</button>
                    </li>
                  ))}
                  {loaded.tracks.length > 200 && <li className="theater-history-hint">…and {loaded.tracks.length - 200} more — narrow the window.</li>}
                </ul>
              )}
              {exportFor && (
                <div className="theater-history-export">
                  <span>File {loaded.tracks.find((t) => t.hex === exportFor)?.callsign || exportFor.toUpperCase()} into</span>
                  {cases === null ? <span>loading cases…</span> : cases.length === 0 ? <span>no cases yet</span> : (
                    <select value={exportCase} onChange={(e) => setExportCase(e.target.value)} aria-label="Case">{cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  )}
                  {cases !== null && <NewCase compact={cases.length > 0} onCreated={(c) => { setCases([...(cases ?? []), c]); setExportCase(c.id); }} />}
                  <button type="button" className="theater-pill is-primary" onClick={() => void doExport()} disabled={!exportCase}>SAVE</button>
                  <button type="button" className="theater-pill" onClick={() => setExportFor(null)}>CANCEL</button>
                </div>
              )}
              {exportMsg && <p className={`theater-history-status ${/failed/.test(exportMsg) ? 'is-err' : ''}`}>{exportMsg}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
