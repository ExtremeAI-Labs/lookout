// Next.js server start hook — the one place a long-lived job may begin.
//   The track recorder runs for the life of the process; it is a no-op unless LOOKOUT_RECEIVER_URL
//   points at your own receiver (readsb / dump1090 / tar1090 aircraft.json).
//   The public aircraft registry (tar1090-db, ~8 MB gz, weekly) is fetched in the background so
//   "who is that?" and the watchlist packs answer within a minute of start.
// The hosted demo (LOOKOUT_DEMO=1) starts neither: it makes no outbound call at server start.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.LOOKOUT_DEMO === '1') { console.info('[kit] demo mode: recorder and registry off'); return; }
  try {
    const { startRecorderFromEnv } = await import('./lib/tracks/service');
    const h = await startRecorderFromEnv();
    if (h.reason) console.info(`[tracks] recorder off: ${h.reason}`);
  } catch (e) {
    console.error('[tracks] recorder failed to start', e instanceof Error ? e.message : e);
  }
  void (async () => {
    try {
      const { aircraftDb } = await import('./lib/aircraft-db');
      const r = await aircraftDb().ensure();
      console.info(`[aircraft-db] ${r.refreshed ? 'refreshed' : 'current'} · ${r.rows.toLocaleString()} rows`);
      const { watchlist } = await import('./lib/watchlist');
      const st = await watchlist().status();
      console.info(`[watchlist] packs: ${st.packs.map((p) => `${p.id}=${p.items.length}`).join(' ')} · custom=${st.custom.length}`);
    } catch (e) {
      console.error('[aircraft-db] not available', e instanceof Error ? e.message : e);
    }
  })();
}
