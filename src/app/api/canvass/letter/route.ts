/**
 * Lookout — footage preservation letter.
 * POST { investigator, matter, incident, cameras[] } → { html, text }
 * A deterministic template (no model in the loop — this goes out under the investigator's name).
 * The client prints/saves the HTML and can file it into a case as a finding.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface Body {
  investigator?: { name?: string; firm?: string; licence?: string; address?: string; phone?: string; email?: string };
  matter?: { reference?: string; client?: string };
  incident?: { location?: string; date?: string; timeStart?: string; timeEnd?: string; description?: string };
  recipient?: { name?: string; address?: string };
  cameras?: Array<{ id?: number; lat?: number; lng?: number; distanceM?: number; bearing?: string; zone?: string; type?: string; mount?: string; direction?: number | null; operator?: string; name?: string }>;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as Body;
  const inv = b.investigator || {}, m = b.matter || {}, inc = b.incident || {}, rcp = b.recipient || {};
  const cams = Array.isArray(b.cameras) ? b.cameras.slice(0, 50) : [];
  if (!inc.location || !inc.date) {
    return NextResponse.json({ error: 'incident.location and incident.date are required' }, { status: 400 });
  }
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const window = [clip(inc.date, 40), inc.timeStart || inc.timeEnd ? `${clip(inc.timeStart, 20) || '00:00'} – ${clip(inc.timeEnd, 20) || '23:59'}` : ''].filter(Boolean).join(', ');
  const camLines = cams.map((c, i) => {
    const bits = [
      c.name || c.operator ? `${clip(c.name || c.operator, 80)}` : `Mapped device #${c.id ?? i + 1}`,
      c.type === 'ALPR' ? 'licence-plate reader (plate reads and context images)' : c.type === 'gunshot_detector' ? 'acoustic gunshot sensor' : c.zone ? `${clip(c.zone, 30)} camera` : c.type ? clip(c.type, 30) : 'camera',
      c.mount ? `${clip(c.mount, 20)}-mounted` : '',
      typeof c.direction === 'number' ? `facing ${Math.round(c.direction)}°` : '',
      typeof c.distanceM === 'number' ? `≈${Math.round(c.distanceM)} m ${clip(c.bearing, 3)} of the incident location` : '',
      typeof c.lat === 'number' && typeof c.lng === 'number' ? `(${c.lat.toFixed(5)}, ${c.lng.toFixed(5)})` : '',
    ].filter(Boolean);
    return bits.join(', ');
  });

  const text = `${clip(inv.name, 80)}${inv.licence ? ` — California PI Licence ${clip(inv.licence, 20)}` : ''}
${clip(inv.firm, 80)}
${clip(inv.address, 200)}
${[clip(inv.phone, 40), clip(inv.email, 80)].filter(Boolean).join(' · ')}

${today}

${clip(rcp.name, 120) || 'Property Owner / Manager / Custodian of Records'}
${clip(rcp.address, 200)}

RE: REQUEST TO PRESERVE VIDEO SURVEILLANCE FOOTAGE${m.reference ? ` — Matter ${clip(m.reference, 60)}` : ''}

Dear Custodian of Records,

I am a private investigator licensed by the California Bureau of Security and Investigative Services${m.client ? `, retained on behalf of ${clip(m.client, 120)}` : ''}. I am investigating an incident that occurred at or near ${clip(inc.location, 200)} on ${window}.${inc.description ? `\n\n${clip(inc.description, 1500)}` : ''}

Publicly available mapping indicates that video surveillance camera(s) under your control may have captured the location during that period${cams.length ? ':' : '.'}
${camLines.map((l) => `  • ${l}`).join('\n')}

This letter is a request that you PRESERVE all video recordings, plate-reader records and context images from those devices (and any others covering the location) for the period ${window}, extending 60 minutes before and after, and that you suspend any automatic overwrite, deletion, or retention cycle that would otherwise erase them. Preservation costs nothing and protects all parties; a formal request for a copy, with any authorization or subpoena required, will follow separately.

Please confirm preservation by replying to the contact details above, and let me know the name of the person responsible for the recordings and the system's retention period. Thank you for your cooperation.

Sincerely,

${clip(inv.name, 80)}
${clip(inv.firm, 80)}`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Preservation request — ${esc(clip(inc.location, 80))}</title>
<style>body{font:12pt/1.5 Georgia,serif;max-width:7.2in;margin:1in auto;color:#111}pre{font:inherit;white-space:pre-wrap}@media print{body{margin:0}}</style></head>
<body><pre>${esc(text)}</pre></body></html>`;

  return NextResponse.json({ html, text, cameras: cams.length });
}
