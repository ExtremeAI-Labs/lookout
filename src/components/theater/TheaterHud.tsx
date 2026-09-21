'use client';
import type { ReactNode } from 'react';
import { THEATER_LAYERS, formatAltitude, type NearbyContact, type TheaterContact, type TheaterLayerId } from '@/lib/theater/layers';
import type { FeedStatus } from './useTheaterFeeds';

function ago(ts: number | null, now: number) {
  if (!ts) return 'no data yet';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
}

export function TheaterLayerPanel({ active, status, onToggle, open, onOpenChange, now }: {
  active: Set<TheaterLayerId>; status: Record<TheaterLayerId, FeedStatus>; onToggle: (id: TheaterLayerId) => void;
  open: boolean; onOpenChange: (o: boolean) => void; now: number;
}) {
  const groups = [...new Set(THEATER_LAYERS.map((l) => l.group))];
  return (
    <aside className={`theater-panel ${open ? 'is-open' : ''}`} aria-label="Data layers">
      <button className="theater-btn theater-panel-toggle" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        {open ? '◂ LAYERS' : '▸ LAYERS'}
      </button>
      {open && (
        <div className="theater-panel-body">
          {groups.map((g) => (
            <section key={g}>
              <h2>{g}</h2>
              {THEATER_LAYERS.filter((l) => l.group === g).map((l) => {
                const s = status[l.id];
                const on = active.has(l.id);
                return (
                  <label key={l.id} className={`theater-layer ${on ? 'is-on' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => onToggle(l.id)} />
                    <span className="theater-layer-name">{l.label}</span>
                    <span className="theater-layer-count" aria-live="polite">
                      {on ? (s.error ? 'feed error' : s.loading && !s.updatedAt ? 'loading…' : s.count.toLocaleString()) : ''}
                    </span>
                    <span className="theater-layer-src">
                      {on && s.error ? `${s.error}${s.updatedAt ? ` · last good ${ago(s.updatedAt, now)}` : ''}` : on ? `${l.source}${s.note ? ` · ${s.note}` : ''}${s.updatedAt ? ` · ${ago(s.updatedAt, now)}` : ''}` : l.source}
                    </span>
                  </label>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

const KIND_LABEL: Record<string, string> = { commercial: 'AIRCRAFT · COMMERCIAL', private: 'AIRCRAFT · PRIVATE', jet: 'AIRCRAFT · PRIVATE JET', military: 'AIRCRAFT · MILITARY', satellite: 'SATELLITE', earthquake: 'EARTHQUAKE', camera: 'PUBLIC CAMERA', 'live camera': 'PUBLIC CAMERA · LIVE', 'plate reader': 'CANVASS · PLATE READER', 'gunshot sensor': 'CANVASS · GUNSHOT SENSOR' };

export function TheaterInfoCard({ contact, raw, onClose, onFollow, following, onFly, onTrace, traceActive, traceBusy, onDetect, detectBusy, onNearestCam, children }: {
  contact: TheaterContact; raw?: Record<string, unknown>; onClose: () => void; onFollow?: () => void; following?: boolean; onFly: () => void;
  onTrace?: () => void; traceActive?: boolean; traceBusy?: boolean; onDetect?: () => void; detectBusy?: boolean; onNearestCam?: () => void; children?: ReactNode;
}) {
  const isAir = contact.layer === 'flights';
  const isCam = contact.layer === 'cctv';
  const feed = isCam && raw ? String(raw.feed_url || '') : '';
  const isJpg = isCam && raw ? raw.stream_type === 'jpg' : false;
  const external = isCam && raw ? String(raw.external_url || '') : '';
  const mapHref = `/?lat=${contact.lat.toFixed(5)}&lon=${contact.lng.toFixed(5)}&zoom=${isAir ? 9 : contact.layer === 'satellites' ? 3 : 15}`;
  return (
    <div className="theater-card" role="dialog" aria-label={contact.name}>
      <div className="theater-card-head">
        <span className="theater-card-kind">{KIND_LABEL[contact.kind] || contact.kind.toUpperCase()}</span>
        <button className="theater-card-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="theater-card-name">{contact.name}</div>
      {contact.detail && <div className="theater-card-detail">{contact.detail}</div>}
      <div className="theater-card-grid">
        <div><span>POSITION</span>{contact.lat.toFixed(4)}°, {contact.lng.toFixed(4)}°</div>
        {contact.alt > 0 && <div><span>ALTITUDE</span>{formatAltitude(contact.alt)}</div>}
      </div>
      {isCam && feed && isJpg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="theater-card-img" src={`/api/cctv/proxy?url=${encodeURIComponent(feed)}`} alt={`Latest frame from ${contact.name}`} loading="lazy" />
      )}
      {isCam && feed && !isJpg && <div className="theater-card-detail">Live stream — open it on the map to play.</div>}
      {children}
      <div className="theater-card-actions">
        {isAir && onFollow && <button className="theater-btn" onClick={onFollow}>{following ? 'STOP FOLLOWING' : 'FOLLOW'}</button>}
        {isAir && onTrace && <button className="theater-btn" onClick={onTrace} disabled={traceBusy} aria-pressed={!!traceActive}>{traceBusy ? 'TRACE…' : traceActive ? 'HIDE TRACE' : 'TRACE 24 H'}</button>}
        {isCam && onDetect && <button className="theater-btn" onClick={onDetect} disabled={detectBusy}>{detectBusy ? 'DETECTING…' : 'DETECT'}</button>}
        {!isCam && onNearestCam && <button className="theater-btn" onClick={onNearestCam} title="Select the nearest public camera and fly to it">NEAREST CAM</button>}
        <button className="theater-btn" onClick={onFly}>FLY TO</button>
        <a className="theater-btn" href={mapHref}>ON MAP</a>
        {external && <a className="theater-btn" href={external} target="_blank" rel="noopener">OPERATOR</a>}
      </div>
    </div>
  );
}

export function TheaterContactsPanel({ around, contacts, onPick, onClose }: { around: TheaterContact; contacts: NearbyContact[]; onPick: (c: NearbyContact) => void; onClose: () => void }) {
  const groups: Record<string, NearbyContact[]> = {};
  for (const c of contacts) (groups[c.layer] ??= []).push(c);
  const label = (id: string) => THEATER_LAYERS.find((l) => l.id === id)?.label || (id === 'tracks' ? 'Recorded tracks' : id);
  return (
    <aside className="theater-contacts" aria-label="Contacts within 250 km">
      <div className="theater-card-head">
        <span className="theater-card-kind">CONTACTS · 250 KM OF {around.name.toUpperCase()}</span>
        <button className="theater-card-close" onClick={onClose} aria-label="Close contacts">×</button>
      </div>
      {contacts.length === 0 && <div className="theater-card-detail">Nothing from the layers that are switched on. Missing broadcasts and unloaded layers are not evidence of absence.</div>}
      {Object.entries(groups).map(([layer, list]) => (
        <section key={layer}>
          <h3>{label(layer)} · {list.length}</h3>
          <ul>
            {list.slice(0, 40).map((c) => (
              <li key={`${c.layer}:${c.id}`}>
                <button onClick={() => onPick(c)}>
                  <span className="theater-contact-name">{c.name}</span>
                  <span className="theater-contact-dist">{c.distanceKm < 10 ? c.distanceKm.toFixed(1) : Math.round(c.distanceKm)} km · {String(Math.round(c.bearingDeg)).padStart(3, '0')}°</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
