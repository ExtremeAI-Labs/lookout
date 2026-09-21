'use client';
// WATCHLIST — the airframes the operator wants to know about: data-driven packs from the public
// registry (executive fleet, C-40 CODEL fleet, DJT Operations, Falcon Landing) plus custom tail
// numbers. Live status per airframe, last sighting, a sightings log, and honest notes about what
// a public ADS-B feed can and cannot see (LADD hides on FAA-fed sites only; PIA rotates the hex).
import { useCallback, useEffect, useRef, useState } from 'react';

export type WatchBridge = {
  /** select + fly to a watched airframe that is on screen now; false when it is not in the scene */
  selectByHex: (hex: string) => boolean;
  /** fly to a last-known position */
  flyTo: (lat: number, lng: number, altM: number) => void;
};

type Sighting = { lastSeenAt: number; firstSeenAt: number; callsign: string; lat: number; lng: number; alt: number; count: number };
type Item = { id: string; hex: string; reg: string; label: string; pack: string; type?: string; desc?: string; owner?: string; flags?: { military: boolean; pia: boolean; ladd: boolean }; note?: string; sighting: Sighting | null; airborne: boolean };
type Pack = { id: string; label: string; note: string; enabled: boolean; items: Item[] };
type Status = { packs: Pack[]; custom: Item[]; db: { ready: boolean; rows: number; fetchedAt: string | null }; alerts: boolean; sightings?: Record<string, unknown>[] };

const ago = (t: number, now: number) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 90 ? `${s} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} d`; };

export function WatchPanel({ bridge, open, onOpenChange }: { bridge: WatchBridge; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async (withLog = false) => {
    try {
      const r = await fetch(`/api/watchlist${withLog ? '?sightings=1' : ''}`, { cache: 'no-store' });
      const j = (await r.json()) as Status & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setStatus((prev) => (withLog || !prev?.sightings ? j : { ...j, sightings: prev.sightings })); setError(null); setNow(Date.now());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => {
    if (!open) { if (timer.current) clearInterval(timer.current); timer.current = null; return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polls the watchlist while the panel is open; state lands after the fetch
    void refresh(showLog);
    timer.current = setInterval(() => void refresh(showLog), 30_000);
    return () => { if (timer.current) clearInterval(timer.current); timer.current = null; };
  }, [open, showLog, refresh]);

  const add = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch('/api/watchlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q, label: label.trim() || undefined }) });
      const j = (await r.json()) as { error?: string; reg?: string; hex?: string; desc?: string; owner?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setMsg(`watching ${j.reg || j.hex?.toUpperCase()}${j.desc ? ` · ${j.desc}` : ''}${j.owner ? ` · ${j.owner}` : ''}`);
      setQuery(''); setLabel('');
      await refresh(showLog);
    } catch (e) { setMsg(`could not add: ${e instanceof Error ? e.message : String(e)}`); } finally { setBusy(false); }
  };
  const remove = async (id: string) => { await fetch(`/api/watchlist?id=${encodeURIComponent(id)}`, { method: 'DELETE' }); await refresh(showLog); };
  const togglePack = async (id: string, enabled: boolean) => { await fetch('/api/watchlist', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pack: id, enabled }) }); await refresh(showLog); };
  const go = (it: Item) => {
    if (it.airborne && bridge.selectByHex(it.hex)) return;
    if (it.sighting) bridge.flyTo(it.sighting.lat, it.sighting.lng, Math.max(3000, it.sighting.alt + 2500));
  };

  const Row = ({ it, removable }: { it: Item; removable?: boolean }) => (
    <li className={`theater-watch-item ${it.airborne ? 'is-airborne' : ''}`}>
      <button type="button" className="theater-watch-go" onClick={() => go(it)} title={it.airborne ? 'On screen now — select and fly to it' : it.sighting ? 'Fly to the last known position' : 'Never seen by this console'}>
        <span className="dot" aria-hidden />
        <span className="who"><b>{it.label}</b>{it.reg && it.reg !== it.label ? <span className="reg"> {it.reg}</span> : null}<span className="what">{it.desc || it.type || ''}{it.owner ? ` · ${it.owner}` : ''}</span></span>
        <span className="when">{it.airborne ? `AIRBORNE${it.sighting?.callsign ? ` · ${it.sighting.callsign}` : ''}` : it.sighting ? `seen ${ago(it.sighting.lastSeenAt, now)} ago` : 'never seen'}</span>
      </button>
      <span className="flags">{it.flags?.military ? 'MIL ' : ''}{it.flags?.ladd ? 'LADD ' : ''}{it.flags?.pia ? 'PIA' : ''}</span>
      {removable && <button type="button" className="theater-card-close" onClick={() => void remove(it.id)} aria-label={`Stop watching ${it.label}`}>×</button>}
    </li>
  );

  return (
    <div className="theater-watch">
      <button type="button" className="theater-pill theater-watch-toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>{open ? '▸' : '◂'} WATCH</button>
      {open && (
        <div className="theater-watch-body" role="region" aria-label="Aircraft watchlist">
          <div className="theater-history-head">
            <span className="theater-history-title">WATCHLIST · NOTABLE AIRFRAMES</span>
            <button type="button" className="theater-pill" onClick={() => void refresh(showLog)} title="Refresh">↻</button>
          </div>
          {error && <p className="theater-history-error" role="alert">{error}</p>}
          {status && !status.db.ready && <p className="theater-history-status is-err">The aircraft registry is still downloading (first start) — packs appear when it lands.</p>}
          {status && status.db.ready && <p className="theater-history-store">registry {status.db.rows.toLocaleString()} airframes · refreshed {status.db.fetchedAt ? ago(Date.parse(status.db.fetchedAt), now) + ' ago' : '—'} · alerts {status.alerts ? 'ON (ntfy)' : 'off — set LOOKOUT_NTFY_URL'}</p>}

          <form className="theater-watch-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tail number (N757AF) or hex" aria-label="Tail number or hex" autoComplete="off" />
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" aria-label="Label" autoComplete="off" />
            <button type="submit" className="theater-pill is-primary" disabled={busy || !query.trim()}>{busy ? '…' : 'WATCH'}</button>
          </form>
          {msg && <p className={`theater-history-status ${/could not/.test(msg) ? 'is-err' : ''}`}>{msg}</p>}

          {status?.custom.length ? (
            <section className="theater-watch-yours"><h3 className="theater-history-title">YOURS · {status.custom.length}</h3><ul className="theater-watch-list">{status.custom.map((it) => <Row key={it.id} it={it} removable />)}</ul></section>
          ) : null}
          {status?.packs.map((p) => (
            <section key={p.id}>
              <h3 className="theater-history-title theater-watch-packhead">
                <label className="theater-layer theater-watch-packtoggle"><input type="checkbox" checked={p.enabled} onChange={(e) => void togglePack(p.id, e.target.checked)} /><span className="theater-layer-name">{p.label}</span><span className="theater-layer-count">{p.items.filter((i) => i.airborne).length}/{p.items.length}</span></label>
              </h3>
              <p className="theater-history-hint">{p.note}</p>
              {p.enabled && <ul className="theater-watch-list">{p.items.map((it) => <Row key={it.id} it={it} />)}</ul>}
            </section>
          ))}

          <button type="button" className="theater-pill" onClick={() => { setShowLog((v) => !v); void refresh(!showLog); }}>{showLog ? 'HIDE LOG' : 'SIGHTINGS LOG'}</button>
          {showLog && (
            <ul className="theater-watch-log">
              {(status?.sightings ?? []).slice(0, 40).map((s, i) => (
                <li key={i}><b>{String(s.label)}</b> {String(s.event)} · {String(s.callsign || '')} · {Number(s.lat).toFixed(2)}, {Number(s.lng).toFixed(2)} · {String(s.t).replace('T', ' ').slice(0, 16)}Z</li>
              ))}
              {!status?.sightings?.length && <li className="theater-history-hint">Nothing logged yet.</li>}
            </ul>
          )}
          <p className="theater-history-hint">Public ADS-B, community receivers. LADD hides an aircraft on FAA-fed sites only; PIA aircraft broadcast a rotating hex. No sighting means “not heard”, never “not there”.</p>
        </div>
      )}
    </div>
  );
}
