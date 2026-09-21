'use client';
// ANNOTATE — the operator's marks on the scene: pin, label, outline, measure. Drawn by clicking
// on the globe (or by Scout with coordinates), listed here with their measures, and filed into a
// case as a finding that says plainly whose assertion it is.
import { useEffect, useState } from 'react';
import { measureOf, type Annotation, type AnnotationKind } from '@/lib/theater/annotations';
import { NewCase } from './CaseNew';

export type AnnotateCamera = { lat: number; lng: number; alt: number; heading: number; pitch: number };
type CaseSummary = { id: string; name: string };

export function AnnotatePanel({ open, onOpenChange, annotations, drawMode, draftPoints, label, onLabel, onStart, onFinish, onCancel, onRemove, onClear, onFly, camera }: {
  open: boolean; onOpenChange: (o: boolean) => void;
  annotations: Annotation[]; drawMode: AnnotationKind | null; draftPoints: number;
  label: string; onLabel: (s: string) => void;
  onStart: (k: AnnotationKind) => void; onFinish: () => void; onCancel: () => void;
  onRemove: (id: string) => void; onClear: () => void; onFly: (id: string) => void;
  camera: AnnotateCamera;
}) {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [caseId, setCaseId] = useState('');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || cases) return;
    let alive = true;
    fetch('/api/cases').then((r) => r.json()).then((j: { cases?: CaseSummary[] }) => { if (!alive) return; setCases(j.cases ?? []); if (j.cases?.length) setCaseId(j.cases[0].id); }).catch(() => { if (alive) setCases([]); });
    return () => { alive = false; };
  }, [open, cases]);

  const save = async () => {
    if (!caseId || !annotations.length) return;
    setSaving(true); setSaveMsg(null);
    try {
      const summary = `${annotations.length} annotation${annotations.length === 1 ? '' : 's'} on the 3D theater: ${annotations.map((a) => `${a.kind}${a.label ? ` "${a.label}"` : ''}${measureOf(a) ? ` (${measureOf(a)!.text})` : ''}`).join('; ')}`.slice(0, 400);
      const r = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addFinding: { tool: 'annotation', query: `${annotations.length} annotations · theater`, summary, data: { basis: 'asserted by the operator, not observed', annotations, camera, savedAt: new Date().toISOString(), theaterUrl: `/theater?lat=${camera.lat.toFixed(5)}&lng=${camera.lng.toFixed(5)}&alt=${Math.round(camera.alt)}&heading=${Math.round(camera.heading)}&pitch=${Math.round(camera.pitch)}` } } }) });
      const j = (await r.json()) as { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setSaveMsg(`filed as a finding in ${cases?.find((c) => c.id === caseId)?.name ?? 'the case'} (hash-sealed)`);
    } catch (e) { setSaveMsg(`save failed: ${e instanceof Error ? e.message : String(e)}`); } finally { setSaving(false); }
  };

  const modeHint = drawMode === 'pin' ? 'Click the globe to drop a pin (type a label first if you want one). Esc stops.' : drawMode === 'label' ? 'Type the text, then click where it belongs. Esc stops.' : drawMode === 'outline' ? `Click each corner (${draftPoints} so far) — double-click, Enter or DONE closes it.` : drawMode === 'measure' ? `Click the points to measure along (${draftPoints} so far) — double-click, Enter or DONE finishes.` : null;

  return (
    <div className="theater-annotate">
      <button type="button" className={`theater-pill theater-annotate-toggle ${drawMode ? 'is-on' : ''}`} aria-expanded={open} onClick={() => onOpenChange(!open)}>{open ? '▸' : '◂'} ANNOTATE</button>
      {open && (
        <div className="theater-annotate-body" role="region" aria-label="Annotations">
          <div className="theater-history-head">
            <span className="theater-history-title">ANNOTATE · YOUR MARKS</span>
            {annotations.length > 0 && <button type="button" className="theater-pill" onClick={onClear}>CLEAR ALL</button>}
          </div>
          <div className="theater-annotate-modes" role="group" aria-label="Draw">
            {(['pin', 'label', 'outline', 'measure'] as AnnotationKind[]).map((k) => (
              <button key={k} type="button" className={`theater-pill ${drawMode === k ? 'is-on' : ''}`} aria-pressed={drawMode === k} onClick={() => (drawMode === k ? onCancel() : onStart(k))}>{k.toUpperCase()}</button>
            ))}
          </div>
          <input className="theater-annotate-label" value={label} onChange={(e) => onLabel(e.target.value)} placeholder="Label (optional; required for LABEL)" aria-label="Annotation label" />
          {modeHint && <p className="theater-history-status">{modeHint}</p>}
          {drawMode && (drawMode === 'outline' || drawMode === 'measure') && (
            <div className="theater-history-controls">
              <button type="button" className="theater-pill is-primary" onClick={onFinish} disabled={draftPoints < (drawMode === 'outline' ? 3 : 2)}>DONE</button>
              <button type="button" className="theater-pill" onClick={onCancel}>CANCEL</button>
            </div>
          )}
          {annotations.length === 0 && !drawMode && <p className="theater-history-hint">Nothing drawn yet. Pick a mode above, or tell Scout: “measure from the pier to the airport”.</p>}
          {annotations.length > 0 && (
            <ul className="theater-annotate-list">
              {annotations.map((a, i) => {
                const m = measureOf(a);
                return (
                  <li key={a.id}>
                    <button type="button" className="theater-annotate-item" onClick={() => onFly(a.id)} title="Fly to it">
                      <b>{i + 1}</b>
                      <span className="kind">{a.kind.toUpperCase()}</span>
                      <span className="text">{a.label || (a.kind === 'pin' ? `${a.points[0].lat.toFixed(5)}, ${a.points[0].lng.toFixed(5)}` : `${a.points.length} points`)}</span>
                      {m && <span className="measure">{m.text}</span>}
                    </button>
                    <button type="button" className="theater-card-close" onClick={() => onRemove(a.id)} aria-label={`Remove annotation ${i + 1}`}>×</button>
                  </li>
                );
              })}
            </ul>
          )}
          {annotations.length > 0 && (
            <div className="theater-history-export">
              <span>File into</span>
              {cases === null ? <span>loading cases…</span> : cases.length === 0 ? <span>no cases yet</span> : (
                <select value={caseId} onChange={(e) => setCaseId(e.target.value)} aria-label="Case">{cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              )}
              {cases !== null && <NewCase compact={cases.length > 0} onCreated={(c) => { setCases([...(cases ?? []), c]); setCaseId(c.id); }} />}
              <button type="button" className="theater-pill is-primary" onClick={() => void save()} disabled={!caseId || saving}>{saving ? '…' : 'SAVE'}</button>
            </div>
          )}
          {saveMsg && <p className={`theater-history-status ${/failed/.test(saveMsg) ? 'is-err' : ''}`}>{saveMsg}</p>}
          <p className="theater-history-hint">Annotations are your assertions, not observations — filed into a case they are labelled that way, with the time and the camera.</p>
        </div>
      )}
    </div>
  );
}
