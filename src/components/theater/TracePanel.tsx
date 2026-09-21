'use client';
// The card's TRACE section: what the last day's path is made of, a scrubber over it, and the
// honest provenance line. It renders inside the info card, under the aircraft's own facts.
import type { TraceInfo, TracePlayState } from './layers/trace';

const RATES = [60, 240, 900];

function hhmm(s: number | null) { return s === null ? '—' : new Date(s * 1000).toISOString().slice(11, 16) + 'Z'; }

export function TracePanel({ info, play, loading, error, onSeek, onPlay, onRate, onFrame, onClear }: {
  info: TraceInfo | null; play: TracePlayState | null; loading: boolean; error: string | null;
  onSeek: (fraction: number) => void; onPlay: (on: boolean) => void; onRate: (r: number) => void; onFrame: () => void; onClear: () => void;
}) {
  if (loading) return <div className="theater-trace" aria-live="polite"><div className="theater-trace-row"><span className="theater-trace-title">TRACE · 24 H</span><span>fetching the flown path…</span></div></div>;
  if (error) return <div className="theater-trace" aria-live="polite"><div className="theater-trace-row"><span className="theater-trace-title">TRACE · 24 H</span><span className="is-err">{error}</span></div></div>;
  if (!info) return null;
  const hours = info.from !== null && info.to !== null ? (info.to - info.from) / 3600 : null;
  return (
    <div className="theater-trace" role="group" aria-label="Flown path, last 24 hours">
      <div className="theater-trace-row">
        <span className="theater-trace-title">TRACE · {hours !== null ? `${hours < 1 ? Math.round(hours * 60) + ' MIN' : hours.toFixed(1) + ' H'}` : '24 H'}</span>
        <span className="theater-trace-meta">{info.points.toLocaleString()} pts · {info.distanceKm < 10 ? info.distanceKm.toFixed(1) : Math.round(info.distanceKm).toLocaleString()} km{info.minAltFt !== null && info.maxAltFt !== null ? ` · ${Math.round(info.minAltFt).toLocaleString()}–${Math.round(info.maxAltFt).toLocaleString()} ft` : ''}</span>
      </div>
      <div className="theater-trace-legend" aria-hidden="true"><span>LOW</span><i /><span>HIGH</span></div>
      {info.replayable ? (
        <>
          <input type="range" min={0} max={1000} value={Math.round((play?.fraction ?? 1) * 1000)} onChange={(e) => onSeek(Number(e.target.value) / 1000)} aria-label="Scrub the flown path" />
          <div className="theater-trace-row">
            <span className="theater-trace-time">{hhmm(info.from)}</span>
            <button type="button" className="theater-pill is-primary" onClick={() => onPlay(!play?.playing)} aria-pressed={!!play?.playing}>{play?.playing ? '❚❚' : '▶'}</button>
            {RATES.map((r) => <button key={r} type="button" className={`theater-pill ${play?.rate === r ? 'is-on' : ''}`} onClick={() => onRate(r)}>{r}×</button>)}
            <span className="theater-trace-time" style={{ marginLeft: 'auto' }}>{hhmm(info.to)}</span>
          </div>
          <div className="theater-trace-now">{play?.t !== null && play?.t !== undefined ? `${new Date(play.t * 1000).toISOString().slice(11, 19)}Z${play.altFt !== null ? ` · ${Math.round(play.altFt).toLocaleString()} ft` : ' · ground'}${play.speedKt !== null ? ` · ${Math.round(play.speedKt)} kt` : ''}` : ' '}</div>
        </>
      ) : <div className="theater-trace-meta">no clock in this trace — path only</div>}
      <div className="theater-trace-row">
        <button type="button" className="theater-pill" onClick={onFrame}>FRAME</button>
        <button type="button" className="theater-pill" onClick={onClear}>CLEAR</button>
      </div>
      <div className="theater-trace-src">{info.source === 'adsb.lol' ? 'adsb.lol readsb trace · community receivers — a gap in the line is a gap in coverage' : `identity only, from ${info.source} — no path available`}</div>
    </div>
  );
}
