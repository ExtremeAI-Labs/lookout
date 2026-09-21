'use client';
// A case, made from inside the theater: the panels that file findings need somewhere to file them
// even where the console (which usually creates cases) is not part of the install.
import { useState } from 'react';

export type CaseSummary = { id: string; name: string };

export function NewCase({ onCreated, compact }: { onCreated: (c: CaseSummary) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: n }) });
      const j = (await r.json()) as CaseSummary & { error?: string };
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      onCreated({ id: j.id, name: j.name });
      setName(''); setOpen(false);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="theater-pill" onClick={() => setOpen(true)} title="Create a case to file into">{compact ? '+' : '+ NEW CASE'}</button>;
  return (
    <span className="theater-casenew">
      <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create(); if (e.key === 'Escape') setOpen(false); }} placeholder="Case name" aria-label="New case name" autoFocus maxLength={120} />
      <button type="button" className="theater-pill is-primary" onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? '…' : 'CREATE'}</button>
      <button type="button" className="theater-pill" onClick={() => setOpen(false)}>×</button>
      {err && <span className="theater-history-status is-err">{err}</span>}
    </span>
  );
}
