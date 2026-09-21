import { readCase } from '@/lib/cases';
import { collectionLagMinutes, sortByEvent } from '@/lib/reconstruction';

export const dynamic = 'force-dynamic';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function when(ts: string): string { return (ts || '').replace('T', ' ').slice(0, 16) + ' UTC'; }
function toParas(t: string): string {
  return esc(t).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const c = await readCase(id);
  if (!c) return new Response('Case not found', { status: 404 });
  const autoPrint = new URL(req.url).searchParams.get('print') === '1';
  const reconItems = sortByEvent(c.reconstruction?.items || []);
  const reconstruction = reconItems.length ? `
    <section class="recon">
      <h2>Reconstruction</h2>
      <p class="recon-note">Each item carries two clocks: when it happened (event) and when it entered this case (collected). Basis: REPORTED = someone said so · OBSERVED = a sensor or witness recorded it · DERIVED = inferred by the investigator, not observed.</p>
      <table class="recon-table"><thead><tr><th>#</th><th>Event time</th><th>Collected</th><th>Basis</th><th>Kind</th><th>Item</th><th>Where</th><th>Source</th></tr></thead><tbody>
      ${reconItems.map((i, n) => `<tr class="basis-${i.basis}">
        <td>${n + 1}</td>
        <td>${i.eventTime ? esc(when(i.eventTime.start)) + (i.eventTime.end ? ' – ' + esc(when(i.eventTime.end)) : '') : '<em>unknown</em>'}</td>
        <td>${esc(when(i.collectedTime))}${collectionLagMinutes(i) !== null ? ` <small>(+${collectionLagMinutes(i)} min)</small>` : ''}</td>
        <td><b>${i.basis.toUpperCase()}</b></td>
        <td>${esc(i.kind.replace('_', ' '))}</td>
        <td>${esc(i.title)}${i.note ? `<div class="recon-item-note">${esc(i.note)}</div>` : ''}</td>
        <td>${i.at ? `${i.at.lat.toFixed(5)}, ${i.at.lng.toFixed(5)}${i.at.headingDeg !== undefined ? ` · ${Math.round(i.at.headingDeg)}°` : ''}` : '—'}</td>
        <td>${esc(i.source.label)}${i.source.url ? ` <a href="${esc(i.source.url)}">link</a>` : ''}${i.source.sha256 ? `<div class="hash">sha256 ${esc(i.source.sha256)}</div>` : ''}</td>
      </tr>`).join('')}
      </tbody></table>
    </section>` : '';

  const findings = (c.findings || []).map((f) => `
    <section class="f">
      <div class="fh"><span class="tool">${esc(f.tool)}</span><span class="q">${esc(f.query)}</span><span class="ts">${esc(when(f.ts))}</span></div>
      ${f.sha256 ? `<div class="coc">collected ${esc(when(f.ts))} · SHA-256 ${esc(f.sha256)}</div>` : ''}
      ${f.analysis ? `<div class="brief"><div class="blabel">Analyst brief</div>${toParas(f.analysis)}</div>` : ''}
      ${!f.analysis && f.summary ? `<p class="sum">${esc(f.summary)}</p>` : ''}
      ${f.data ? `<details class="raw"><summary>raw data</summary><pre>${esc(JSON.stringify(f.data, null, 2)).slice(0, 12000)}</pre></details>` : ''}
    </section>`).join('') || '<p class="empty">No findings recorded in this case.</p>';

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lookout dossier — ${esc(c.name)}</title>
<style>
  :root{--ink:#111;--muted:#555;--faint:#888;--line:#ddd;--gold:#8a6d1a;--accent:#0b60b0}
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:var(--ink);font:13.5px/1.55 -apple-system,system-ui,"Segoe UI",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .wrap{max-width:820px;margin:0 auto;padding:40px 44px 80px}
  .brand{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid var(--ink);padding-bottom:10px}
  .brand .mark{font:700 15px/1 ui-monospace,Menlo,monospace;letter-spacing:.34em;color:var(--gold)}
  .brand .kind{font:11px/1 ui-monospace,monospace;letter-spacing:.14em;color:var(--faint);text-transform:uppercase}
  h1{font-size:24px;margin:22px 0 2px}
  .meta{color:var(--muted);font:12px/1.5 ui-monospace,monospace;margin-bottom:6px}
  .notes{background:#f7f7f5;border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:16px 0;white-space:pre-wrap}
  .notes .nlabel,.section-label{font:600 10px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:6px;display:block}
  .section-label{margin:26px 0 6px}
  .f{border:1px solid var(--line);border-radius:9px;padding:13px 15px;margin:10px 0;break-inside:avoid}
  .fh{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:7px;margin-bottom:8px}
  .fh .tool{font:700 10px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#fff;background:var(--accent);padding:4px 7px;border-radius:4px}
  .fh .q{font:600 14px/1.2 ui-monospace,monospace}
  .fh .ts{margin-left:auto;color:var(--faint);font:11px/1 ui-monospace,monospace}
  .brief .blabel{font:600 10px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--gold);margin-bottom:4px}
  .brief p,.sum{margin:0 0 8px;max-width:70ch}
  .raw{margin-top:8px}
  .raw summary{cursor:pointer;color:var(--faint);font:11px/1 ui-monospace,monospace}
  .raw pre{background:#f5f5f3;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;font:11px/1.45 ui-monospace,monospace;max-height:360px}
  .empty{color:var(--faint)}
  .coc{font:10.5px/1.4 ui-monospace,monospace;color:var(--faint);margin:-2px 0 8px;word-break:break-all}
  .foot{margin-top:34px;padding-top:12px;border-top:1px solid var(--line);color:var(--faint);font:11px/1.5 ui-monospace,monospace}
  .recon-table{width:100%;border-collapse:collapse;font-size:11.5px} .recon-table th,.recon-table td{border-bottom:1px solid #ddd;padding:5px 6px;vertical-align:top;text-align:left} .recon-table tr.basis-derived td{color:#6b5b00;background:#fffbe6} .recon-note{font-size:12px;color:#555} .recon-item-note{color:#555;font-size:11px;margin-top:2px}
  @media print{ .wrap{padding:0} a{color:inherit;text-decoration:none} .raw{display:none} }
</style></head>
<body><div class="wrap">
  <div class="brand"><span class="mark">◑ LOOKOUT</span><span class="kind">Case Dossier · Confidential</span></div>
  <h1>${esc(c.name)}</h1>
  <div class="meta">Opened ${esc(when(c.created))} · ${(c.findings || []).length} finding${(c.findings || []).length === 1 ? '' : 's'} · generated ${esc(when(new Date().toISOString()))}</div>
  ${c.notes ? `<div class="notes"><span class="nlabel">Notes</span>${toParas(c.notes)}</div>` : ''}
  <span class="section-label">Findings (newest first)</span>
  ${findings}
  ${reconstruction}
  <div class="foot">Lookout · personal intelligence · lawful, authorized investigation only. Each finding is stamped with its collection time and a SHA-256 of the raw data captured at that moment; re-hashing detects any later alteration. Generated locally; not for redistribution without a permissible purpose.</div>
</div>
${autoPrint ? '<script>window.addEventListener("load",()=>setTimeout(()=>window.print(),350))</script>' : ''}
</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
