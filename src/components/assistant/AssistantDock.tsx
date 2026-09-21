'use client';
// Scout — the assistant dock (Assistant Standard v2.2 §G). Mounted once in the app shell so
// chat history and the voice call survive in-app navigation; a floating launcher, ⌘/ to toggle,
// draggable panel, first-visit welcome + interactive tour, push-to-talk voice with a spend clock.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { WelcomeModal } from '@/lib/assistant/kit/WelcomeModal';
import { ASSISTANT_NAME } from '@/lib/assistant/tools';
import { pageFromPath } from '@/lib/assistant/registry';
import { useAssistantChat, type ChatMessage } from './useAssistantChat';
import { useRealtimeVoice } from './useRealtimeVoice';

const OPEN_KEY = 'lookout.scout.open';
const NUDGE_KEY = 'lookout.scout.nudged';
const WELCOME_KEY = 'lookout:scout-welcome-seen';
const VOICE_USD_PER_MIN = Number(process.env.NEXT_PUBLIC_LOOKOUT_VOICE_USD_PER_MIN) || 0.3;
const VOICE_MAX_MIN = Number(process.env.NEXT_PUBLIC_LOOKOUT_VOICE_MAX_MIN) || 20;

const CHIPS: Record<string, string[]> = {
  map: ['Turn on flights and GPS interference', 'Fly to Santa Monica Pier', "What's on screen?"],
  theater: ['Switch to the thermal look', "What's within 80 km?", 'Follow the nearest aircraft'],
  console: ['Open my cases', 'What can you do here?'],
  reconstruction: ['Explain the basis labels', 'Open this in 3D'],
  other: ['Give me the tour', "What's on screen?"],
};

const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export default function AssistantDock() {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const navigate = useCallback((p: string) => router.push(p), [router]);
  // Tools run from event handlers, so the live URL is always available there.
  const getPath = useCallback(() => window.location.pathname + window.location.search, []);

  const chat = useAssistantChat({ navigate, getPath });
  const chatRef = useRef(chat);
  useEffect(() => { chatRef.current = chat; });

  const [open, setOpen] = useState(false);
  const [nudge, setNudge] = useState(false);
  // A page may offer a docking slot (the theater's command dock, id scout-dock-slot); when it
  // exists the launcher lives there instead of floating. Watched, because the slot mounts
  // after the page's engine is ready.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const find = () => setSlot(document.getElementById('scout-dock-slot'));
    find();
    const mo = new MutationObserver(find);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [pathname]);
  const [input, setInput] = useState('');
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Voice: transcript lines land in the chat as voice-flagged messages the model never re-reads
  // (they are display-only; the delegate turn carries the real request).
  const [voiceLines, setVoiceLines] = useState<ChatMessage[]>([]);
  const voice = useRealtimeVoice({
    maxMinutes: VOICE_MAX_MIN,
    usdPerMinute: VOICE_USD_PER_MIN,
    onTranscript: (role, text) => setVoiceLines((v) => [...v.slice(-40), { id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role, text, ts: Date.now(), voice: true }]),
    delegate: async (request) => {
      const reply = await chatRef.current.send(request, { voice: true });
      return reply || (chatRef.current.busy ? 'Scout is mid-task — ask again in a moment.' : "Scout couldn't complete that.");
    },
  });
  const voiceLive = voice.status.kind === 'live';

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restores persisted UI state after mount; must not run during render (hydration)
    try { setOpen(localStorage.getItem(OPEN_KEY) === '1'); setNudge(!localStorage.getItem(NUDGE_KEY)); } catch { /* fine */ }
  }, []);
  const toggle = useCallback((next?: boolean) => {
    setOpen((o) => {
      const v = next ?? !o;
      try { localStorage.setItem(OPEN_KEY, v ? '1' : '0'); if (v) { localStorage.setItem(NUDGE_KEY, '1'); } } catch { /* fine */ }
      if (v) setNudge(false);
      return v;
    });
  }, []);

  // ⌘/ toggles; Esc closes; Space (held) is push-to-talk while the call is live and no field is focused.
  useEffect(() => {
    const isField = (t: EventTarget | null) => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); toggle(); return; }
      if (e.key === 'Escape' && open && !isField(e.target)) { toggle(false); return; }
      if (e.code === 'Space' && voiceLive && voice.mode === 'ptt' && open && !isField(e.target) && !e.repeat) { e.preventDefault(); voice.hold(true); }
    };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && voiceLive && voice.mode === 'ptt') voice.hold(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [toggle, open, voiceLive, voice]);

  // Keep the newest message in view.
  const visible = useMemo(() => [...chat.messages, ...voiceLines].filter((m) => !m.hidden).sort((a, b) => a.ts - b.ts), [chat.messages, voiceLines]);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [visible, chat.pending, open]);

  const submit = useCallback(() => {
    const t = input.trim();
    if (!t || chat.busy) return;
    setInput('');
    void chat.send(t);
  }, [input, chat]);
  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } };

  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: drag.x, oy: drag.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setDrag({ x: Math.min(0, d.ox + e.clientX - d.sx), y: Math.min(0, d.oy + e.clientY - d.sy) });
  };
  const onDragEnd = () => { dragRef.current = null; };

  const page = pageFromPath(pathname);
  const chips = CHIPS[page] ?? CHIPS.other;
  const startVoice = (tour = false) => { toggle(true); void voice.start({ tour }); };
  const micDown = () => { if (voiceLive) voice.hold(true); };
  const micUp = () => { if (voiceLive) voice.hold(false); };

  return (
    <>
      <div style={{ position: 'relative', zIndex: 10000 }}>
        <WelcomeModal
          name={ASSISTANT_NAME}
          tagline="your eye on the world"
          storageKey={WELCOME_KEY}
          voiceEnabled
          blurb="Scout drives Lookout for you — the globe, the 3D theater, layers, contacts, scenes and cases. The tour is interactive: stop and ask anything, any time. Case and lookup results stay on this machine."
          onStartTextTour={() => { toggle(true); chat.startTextTour(); }}
          onStartVoiceTour={() => startVoice(true)}
        />
      </div>

      {nudge && !open && <div className="scout-nudge" role="status">Meet {ASSISTANT_NAME} — ⌘/ or the button below. It can fly the map, switch layers and open cases for you.</div>}

      {slot ? createPortal(
        <>
          <span className="theater-dock-title">Voice</span>
          <span className="kicker">⌘/</span>
          <button type="button" className={`scout-launcher in-dock ${voiceLive ? 'is-live' : ''} ${open ? 'is-open' : ''}`} onClick={() => toggle()} aria-label={`${open ? 'Minimize' : 'Open'} ${ASSISTANT_NAME}`} aria-expanded={open}>
            <span className="dot" aria-hidden />{voiceLive ? 'LIVE · ' : ''}{open ? 'HIDE' : 'TALK TO'} {ASSISTANT_NAME.toUpperCase()}
          </button>
        </>, slot,
      ) : !open && (
        <button type="button" className={`scout-launcher ${voiceLive ? 'is-live' : ''}`} onClick={() => toggle(true)} aria-label={`Open ${ASSISTANT_NAME}`} title="⌘/">
          <span className="dot" aria-hidden />◈ {ASSISTANT_NAME.toUpperCase()}{voiceLive ? ' · LIVE' : ''}
        </button>
      )}

      {open && (
        <section className={`scout-panel ${slot ? 'on-dock' : ''}`} role="complementary" aria-label={`${ASSISTANT_NAME} assistant`} style={{ transform: `translate(${drag.x}px, ${drag.y}px)` }}>
          <div className="scout-head" onPointerDown={onDragStart} onPointerMove={onDragMove} onPointerUp={onDragEnd} onPointerCancel={onDragEnd}>
            <span className="name">◈ {ASSISTANT_NAME}</span>
            <span className="sub">{chat.busy ? 'working…' : chat.tourActive ? 'tour' : page}</span>
            <span className="spacer" />
            {chat.tourActive && <button type="button" className="scout-iconbtn" onClick={() => chat.pauseTour()} disabled={chat.busy} title="Pause the tour">⏸</button>}
            {chat.tourActive && <button type="button" className="scout-iconbtn" onClick={() => chat.resumeTour()} disabled={chat.busy} title="Resume the tour">▶</button>}
            {chat.tourActive && <button type="button" className="scout-iconbtn" onClick={() => chat.endTour()} title="End the tour">END</button>}
            {chat.busy && <button type="button" className="scout-iconbtn" onClick={() => chat.stop()} title="Stop this turn">■</button>}
            <button type="button" className="scout-iconbtn" onClick={() => { if (confirm('Clear the conversation?')) chat.clear(); }} title="Clear history">✕ hist</button>
            <button type="button" className="scout-iconbtn" onClick={() => toggle(false)} aria-label="Minimize" title="Esc">—</button>
          </div>

          <div className="scout-voicebar" aria-live="polite">
            {voice.status.kind === 'idle' && <span>voice off · tap the mic to start{chat.usage.turns ? ` · ${chat.usage.turns} calls · ${(chat.usage.prompt + chat.usage.completion).toLocaleString()} tokens${chat.usage.cached ? ` (${chat.usage.cached.toLocaleString()} cached)` : ''}` : ''}</span>}
            {voice.status.kind === 'connecting' && <span className="warn">connecting voice…</span>}
            {voice.status.kind === 'error' && <span className="err" title={voice.status.message}>voice: {voice.status.message}</span>}
            {voiceLive && (
              <>
                <span className="live">● LIVE {fmtClock(voice.elapsedS)}</span>
                <span className={voice.estUsd > VOICE_USD_PER_MIN * VOICE_MAX_MIN * 0.75 ? 'warn' : ''} title={`estimate at $${VOICE_USD_PER_MIN.toFixed(2)}/min; hard stop at ${VOICE_MAX_MIN} min`}>~${voice.estUsd.toFixed(2)} est.</span>
                <span>{voice.speaking ? 'speaking' : voice.talking ? 'listening' : voice.mode === 'ptt' ? 'hold mic / space' : 'open mic'}</span>
                <span className="spacer" />
                <button type="button" className="scout-iconbtn" onClick={() => voice.setMode(voice.mode === 'ptt' ? 'open' : 'ptt')} title="Push-to-talk (default) or open mic">{voice.mode === 'ptt' ? 'PTT' : 'OPEN'}</button>
                <button type="button" className="scout-iconbtn" onClick={() => voice.stop()} title="End the call">END</button>
              </>
            )}
            {voice.status.kind === 'error' && <><span className="spacer" /><button type="button" className="scout-iconbtn" onClick={() => voice.stop()} title="Dismiss">ok</button></>}
          </div>

          <div className="scout-msgs" ref={listRef}>
            {visible.length === 0 && (
              <div className="scout-empty">
                <b>Ask {ASSISTANT_NAME} to drive.</b>
                Fly somewhere, switch layers, follow an aircraft, open a case. Case and lookup results stay on this machine — the model only learns that they were shown.
              </div>
            )}
            {visible.map((m, i) => (
              <MessageView key={m.id} m={m} streaming={chat.busy && i === visible.length - 1 && m.role === 'assistant' && !m.voice} />
            ))}
            {chat.pending && (
              <div className="scout-confirm" role="alertdialog" aria-label="Confirm">
                <div className="q">{chat.pending.summary}</div>
                <div className="row">
                  <button type="button" className="scout-btn is-primary" onClick={() => chat.answerConfirm(true)}>YES, DO IT</button>
                  <button type="button" className="scout-btn" onClick={() => chat.answerConfirm(false)}>NO</button>
                </div>
              </div>
            )}
          </div>

          {!chat.busy && !chat.pending && (
            <div className="scout-chips">
              {chips.map((c) => <button key={c} type="button" className="scout-chip" onClick={() => void chat.send(c)}>{c}</button>)}
              {visible.length === 0 && <button type="button" className="scout-chip" onClick={() => chat.startTextTour()}>Give me the tour</button>}
            </div>
          )}

          <div className="scout-compose">
            <button
              type="button"
              className={`scout-mic ${voiceLive ? 'is-live' : ''} ${voice.talking ? 'is-talking' : ''} ${voice.status.kind === 'connecting' ? 'is-busy' : ''}`}
              aria-label={voiceLive ? (voice.mode === 'ptt' ? 'Hold to talk' : 'Open mic') : 'Start voice'}
              title={voiceLive ? (voice.mode === 'ptt' ? 'Hold to talk (or hold Space)' : 'Open mic — tap END to stop') : 'Start a voice call'}
              disabled={voice.status.kind === 'connecting'}
              onClick={() => { if (!voiceLive && voice.status.kind !== 'connecting') startVoice(false); }}
              onPointerDown={micDown}
              onPointerUp={micUp}
              onPointerLeave={micUp}
              onPointerCancel={micUp}
            >
              {voiceLive ? '●' : '🎙'}
            </button>
            <textarea ref={inputRef} rows={1} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} placeholder={chat.busy ? 'working…' : `Ask ${ASSISTANT_NAME}…`} disabled={!!chat.pending} aria-label="Message" />
            <button type="button" className="scout-btn is-primary" onClick={submit} disabled={chat.busy || !input.trim()}>SEND</button>
            <span className="scout-hint">Enter to send · ⌘/ toggles · {voiceLive ? 'hold Space to talk' : 'mic starts a voice call (push-to-talk)'}</span>
          </div>
        </section>
      )}
    </>
  );
}

function MessageView({ m, streaming }: { m: ChatMessage; streaming: boolean }) {
  return (
    <>
      {(m.text || streaming) && (
        <div className={`scout-msg ${m.role} ${m.voice ? 'voice' : ''}`}>
          {m.text}
          {streaming && <span className="cursor" aria-hidden />}
        </div>
      )}
      {m.tools && m.tools.length > 0 && (
        <div className="scout-tools" aria-label="Actions">
          {m.tools.map((t) => <div key={t.id} className={`scout-tool ${t.status}`}>{t.name}{t.note ? ` · ${t.note}` : ''}</div>)}
        </div>
      )}
      {m.cards?.map((c, i) => (
        <div key={i} className="scout-card">
          <div className="t">{c.title}</div>
          {c.lines.map((l, j) => <div key={j} className="l">{l}</div>)}
          <div className="k">on this machine only — not sent to the model</div>
        </div>
      ))}
      {m.error && <div className="scout-err">{m.error}</div>}
    </>
  );
}
