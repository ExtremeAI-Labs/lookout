'use client';
// DETECT inside a camera's card: the operator's own YOLO tracker (a loopback service on this
// Mac) watches the camera for a few seconds and reports the vehicles it saw — types, colours,
// directions, dwell — with the annotated clip. Frames never leave the machine; the panel says so.
export type DetectVehicle = { track_id: number; type: string; color?: string | null; direction?: string; dwell_s?: number; frames?: number; thumb?: string | null };
export type DetectResult = { job_id: string; annotated_url: string | null; meta: { frames?: number; polls?: number | null; elapsed_s?: number; model?: string; device?: string; duration_s?: number; vehicles?: number }; vehicles: DetectVehicle[] };
export type DetectState = { camId: string; status: 'running' | 'done' | 'error'; result?: DetectResult; error?: string; startedAt: number; windowS: number };

export function summarizeDetections(vehicles: DetectVehicle[]): string {
  if (!vehicles.length) return 'no vehicles';
  const counts = new Map<string, number>();
  for (const v of vehicles) counts.set(v.type, (counts.get(v.type) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ×${n}`).join(' · ');
}

export function DetectPanel({ state, onRun }: { state: DetectState; onRun: () => void }) {
  const r = state.result;
  return (
    <div className="theater-detect" role="group" aria-label="Vehicle detection">
      <div className="theater-trace-row">
        <span className="theater-trace-title">DETECT · ON-DEVICE</span>
        {state.status === 'running' && <span className="theater-trace-meta">watching {state.windowS} s… yolo11s on this Mac</span>}
        {state.status === 'error' && <span className="theater-trace-meta is-err">{state.error}</span>}
        {state.status === 'done' && r && <span className="theater-trace-meta">{summarizeDetections(r.vehicles)} · {r.meta.frames ?? 0} frames in {r.meta.elapsed_s ?? '?'} s</span>}
      </div>
      {state.status === 'running' && <div className="theater-detect-bar"><i /></div>}
      {state.status === 'done' && r && r.vehicles.length > 0 && (
        <ul className="theater-detect-list">
          {r.vehicles.slice(0, 6).map((v) => (
            <li key={v.track_id}>
              {v.thumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/tracker/result/${encodeURIComponent(r.job_id)}/${encodeURIComponent(v.thumb)}`} alt={`${v.type} crop`} loading="lazy" />
              ) : <span className="theater-detect-nothumb" aria-hidden="true" />}
              <span><b>{v.type}</b>{v.color ? ` · ${v.color}` : ''}{v.direction ? ` · ${v.direction}` : ''}{typeof v.dwell_s === 'number' ? ` · ${v.dwell_s.toFixed(0)} s` : ''}</span>
            </li>
          ))}
        </ul>
      )}
      {state.status === 'done' && r && r.annotated_url && (
        <video className="theater-detect-video" src={`/api/tracker${r.annotated_url}`} autoPlay muted loop playsInline controls={false} aria-label="Annotated clip" />
      )}
      {state.status !== 'running' && (
        <div className="theater-trace-row"><button type="button" className="theater-pill" onClick={onRun}>RUN AGAIN</button></div>
      )}
      <div className="theater-trace-src">detected here, on this Mac — frames never leave the machine · boxes are yolo11s guesses at {state.status === 'done' && r?.meta.model ? r.meta.model : 'conf ≥ 0.35'}, not identifications</div>
    </div>
  );
}
