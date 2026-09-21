'use client';
// Scout's brain loop, in the browser (Assistant Standard §A/§C): send the transcript, stream
// the reply, run every tool call against the page, send the results back, repeat — at most
// MAX_ROUNDS per turn. History persists in localStorage so the dock survives reloads.
import { useCallback, useEffect, useRef, useState } from 'react';
import { currentView } from '@/lib/assistant/registry';
import type { WireMessage, WireToolCall } from '@/lib/assistant/tools';
import { TOUR_KICKOFF_FLAGS, TOUR_PAUSE_SIGNAL, TOUR_RESUME_SIGNAL, tourKickoff } from '@/lib/assistant/kit/tourEngine';
import { LOOKOUT_TOUR } from '@/lib/assistant/tour';
import { executeTool, type ToolCard, type ToolDeps } from './runTool';

export type ToolRow = { id: string; name: string; status: 'run' | 'ok' | 'fail'; note?: string };
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** tutorial-layer plumbing: sent to the model, never drawn (kit TOUR_KICKOFF_FLAGS) */
  hidden?: boolean;
  /** came in through the voice channel */
  voice?: boolean;
  toolCalls?: WireToolCall[];
  /** what went back to the model — already tier-scrubbed by the runner */
  toolResults?: { id: string; content: string }[];
  tools?: ToolRow[];
  /** local-only cards (sensitive data the model never sees) */
  cards?: ToolCard[];
  error?: string;
};
export type PendingConfirm = { summary: string; resolve: (yes: boolean) => void };
export type Usage = { prompt: number; completion: number; cached: number; turns: number };

const STORAGE_KEY = 'lookout.scout.history.v1';
const MAX_HISTORY = 60;
const MAX_ROUNDS = 8;
const MAX_USER_TURNS_SENT = 12;

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
    return Array.isArray(arr) ? arr.filter((m) => m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant')).slice(-MAX_HISTORY) : [];
  } catch { return []; }
}
function saveHistory(msgs: ChatMessage[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs.slice(-MAX_HISTORY))); } catch { /* storage may be unavailable; the session still works */ }
}

/** The wire transcript: the last N user turns, tool groups intact, failed empties dropped. */
function toWire(history: ChatMessage[]): WireMessage[] {
  let userTurns = 0, start = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user' && ++userTurns >= MAX_USER_TURNS_SENT) { start = i; break; }
  }
  const out: WireMessage[] = [];
  for (const m of history.slice(start)) {
    if (m.role === 'user') { if (m.text.trim()) out.push({ role: 'user', content: m.text }); continue; }
    if (m.toolCalls?.length) {
      out.push({ role: 'assistant', content: m.text || null, tool_calls: m.toolCalls });
      for (const c of m.toolCalls) out.push({ role: 'tool', tool_call_id: c.id, content: m.toolResults?.find((r) => r.id === c.id)?.content ?? '{"ok":false,"note":"no result recorded"}' });
    } else if (m.text.trim()) {
      out.push({ role: 'assistant', content: m.text });
    }
  }
  // A transcript must open with a user turn.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

type StreamOutcome = { toolCalls: WireToolCall[]; finish: string; usage?: { prompt: number; completion: number; cached: number }; error?: string };
async function consumeStream(res: Response, onDelta: (text: string) => void, signal: AbortSignal): Promise<StreamOutcome> {
  const reader = res.body?.getReader();
  if (!reader) return { toolCalls: [], finish: 'stop', error: 'empty response' };
  const dec = new TextDecoder();
  const out: StreamOutcome = { toolCalls: [], finish: 'stop' };
  let buf = '';
  const handle = (line: string) => {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.t === 'delta' && typeof ev.text === 'string') onDelta(ev.text);
    else if (ev.t === 'tool_call' && typeof ev.name === 'string') out.toolCalls.push({ id: String(ev.id || uid()), type: 'function', function: { name: ev.name, arguments: typeof ev.args === 'string' ? ev.args : '{}' } });
    else if (ev.t === 'usage') out.usage = { prompt: Number(ev.prompt) || 0, completion: Number(ev.completion) || 0, cached: Number(ev.cached) || 0 };
    else if (ev.t === 'done') out.finish = typeof ev.finish === 'string' ? ev.finish : 'stop';
    else if (ev.t === 'error') out.error = typeof ev.message === 'string' ? ev.message : 'model error';
  };
  while (!signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (line) handle(line); }
  }
  if (buf.trim()) handle(buf.trim());
  return out;
}

export function useAssistantChat(deps: { navigate: (path: string) => void; getPath: () => string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [usage, setUsage] = useState<Usage>({ prompt: 0, completion: 0, cached: 0, turns: 0 });
  const [tourActive, setTourActive] = useState(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  const tourRef = useRef(false);
  const depsRef = useRef(deps);
  useEffect(() => { depsRef.current = deps; });

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads persisted history after mount; must not run during render (hydration)
    const h = loadHistory(); messagesRef.current = h; setMessages(h);
  }, []);

  const commit = useCallback((next: ChatMessage[]) => { messagesRef.current = next; setMessages(next); }, []);

  const confirm = useCallback((summary: string) => new Promise<boolean>((resolve) => {
    const p: PendingConfirm = { summary, resolve: (yes) => { pendingRef.current = null; setPending(null); resolve(yes); } };
    pendingRef.current = p;
    setPending(p);
  }), []);

  /** One full turn. Resolves with the final assistant text ('' on failure). */
  const send = useCallback(async (text: string, opts: { hidden?: boolean; voice?: boolean } = {}): Promise<string> => {
    const clean = text.trim();
    if (!clean) return '';
    if (busyRef.current) return '';
    busyRef.current = true; setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const toolDeps: ToolDeps = { navigate: (p) => depsRef.current.navigate(p), confirm, path: () => depsRef.current.getPath() };
    let history = [...messagesRef.current, { id: uid(), role: 'user' as const, text: clean, ts: Date.now(), hidden: opts.hidden, voice: opts.voice }];
    commit(history);
    let finalText = '';
    let asst: ChatMessage | null = null;
    const update = (m: ChatMessage) => { history = history.map((x) => (x.id === m.id ? { ...m } : x)); commit(history); };
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        asst = { id: uid(), role: 'assistant', text: '', ts: Date.now(), tools: [] };
        history = [...history, asst]; commit(history);
        const res = await fetch('/api/assistant/chat', {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ messages: toWire(history), context: currentView(depsRef.current.getPath()), tour: tourRef.current }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
          throw new Error(j.error ? `${j.error}${j.detail ? ` — ${j.detail}` : ''}` : `HTTP ${res.status}`);
        }
        const cur = asst;
        const out = await consumeStream(res, (d) => { cur.text += d; update(cur); }, controller.signal);
        if (out.usage) setUsage((u) => ({ prompt: u.prompt + out.usage!.prompt, completion: u.completion + out.usage!.completion, cached: u.cached + out.usage!.cached, turns: u.turns + 1 }));
        if (out.error) throw new Error(out.error);
        if (!out.toolCalls.length) { finalText = cur.text; break; }
        cur.toolCalls = out.toolCalls; cur.toolResults = []; cur.tools = out.toolCalls.map((c) => ({ id: c.id, name: c.function.name, status: 'run' as const }));
        update(cur);
        for (const call of out.toolCalls) {
          if (controller.signal.aborted) break;
          const r = await executeTool(call.function.name, call.function.arguments, toolDeps);
          cur.tools = cur.tools!.map((t) => (t.id === call.id ? { ...t, status: r.ok ? 'ok' : 'fail', note: r.note } : t));
          if (r.card) cur.cards = [...(cur.cards ?? []), r.card];
          cur.toolResults!.push({ id: call.id, content: r.forModel });
          update(cur);
        }
        if (controller.signal.aborted) break;
        if (round === MAX_ROUNDS - 1) { cur.text = (cur.text ? cur.text + '\n' : '') + '(stopped: too many tool rounds in one turn)'; update(cur); }
      }
    } catch (e) {
      const msg = controller.signal.aborted ? 'stopped' : e instanceof Error ? e.message : String(e);
      if (asst) { asst.error = msg; update(asst); }
    } finally {
      if (pendingRef.current) pendingRef.current.resolve(false);
      busyRef.current = false; setBusy(false); abortRef.current = null;
      saveHistory(messagesRef.current);
    }
    return finalText;
  }, [commit, confirm]);

  const stop = useCallback(() => { abortRef.current?.abort(); pendingRef.current?.resolve(false); }, []);
  const clear = useCallback(() => { stop(); commit([]); try { localStorage.removeItem(STORAGE_KEY); } catch { /* fine */ } }, [commit, stop]);
  const answerConfirm = useCallback((yes: boolean) => { pendingRef.current?.resolve(yes); }, []);

  const startTextTour = useCallback(() => { tourRef.current = true; setTourActive(true); void send(tourKickoff(LOOKOUT_TOUR), { ...TOUR_KICKOFF_FLAGS }); }, [send]);
  const pauseTour = useCallback(() => { void send(TOUR_PAUSE_SIGNAL, { hidden: true }); }, [send]);
  const resumeTour = useCallback(() => { void send(TOUR_RESUME_SIGNAL, { hidden: true }); }, [send]);
  const endTour = useCallback(() => { tourRef.current = false; setTourActive(false); }, []);

  return { messages, busy, pending, usage, tourActive, send, stop, clear, answerConfirm, startTextTour, pauseTour, resumeTour, endTour };
}
