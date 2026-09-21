// Scout's chat turn — a thin relay to an OpenAI-compatible chat endpoint (your gateway, OpenAI, Ollama…) that
// streams NDJSON events back: {t:'delta',text} · {t:'tool_call',id,name,args} · {t:'usage',…}
// · {t:'done',finish} · {t:'error',message}. The tool loop lives in the browser (Assistant
// Standard §A): tools run against the page, results come back as the next turn's messages.
// Access control is the app's own (middleware: loopback or Cloudflare Access), inherited here.
import { NextResponse } from 'next/server';
import { buildSystemBlocks, sanitizeMessages, scrubSensitiveResults, toolsForGateway } from '@/lib/assistant/tools';
import type { ViewState } from '@/lib/assistant/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GATEWAY = (process.env.LOOKOUT_GATEWAY_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
// Claude is the tool-caller (Standard §D); paid via the gateway's Anthropic route — usage is logged per turn.
const MODEL = process.env.LOOKOUT_ASSISTANT_MODEL || 'claude-opus-5';
const MAX_TOKENS = 1500;
const TIMEOUT_MS = 120_000;

type ToolAcc = { id: string; name: string; args: string };

function viewFrom(input: unknown): ViewState | null {
  if (!input || typeof input !== 'object') return null;
  const v = input as Record<string, unknown>;
  if (typeof v.page !== 'string' || typeof v.path !== 'string') return null;
  // Keep it small: the model gets a snapshot, not a dump.
  return JSON.parse(JSON.stringify(v).slice(0, 4000)) as ViewState;
}

export async function POST(req: Request) {
  // The console's own scoped principal (gateway: chat/models only, cloud capped to the two
  // assistant models) — the master key no longer lives on this process.
  const key = process.env.LOOKOUT_GATEWAY_KEY;
  if (!key) return NextResponse.json({ error: 'assistant is not configured (LOOKOUT_GATEWAY_KEY missing on the console)' }, { status: 503 });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }); }
  const s = sanitizeMessages(body.messages);
  if (!s.ok) return NextResponse.json({ error: s.error }, { status: 400 });
  const messages = scrubSensitiveResults(s.messages);
  // Prompt caching (Anthropic via the gateway; measured 2026-09-17): the tool block and the
  // stable persona block carry cache breakpoints, the per-turn view snapshot follows them
  // uncached. The gateway appends the date to the first system block — stable within a day.
  const blocks = buildSystemBlocks({ view: viewFrom(body.context), tour: body.tour === true });
  const systemContent: Record<string, unknown>[] = [{ type: 'text', text: blocks.stable, cache_control: { type: 'ephemeral' } }];
  if (blocks.volatile) systemContent.push({ type: 'text', text: blocks.volatile });
  const tools: Record<string, unknown>[] = toolsForGateway();
  tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' } };

  // The gateway's classification firewall: an unlabeled request defaults to "confidential" and
  // never reaches a cloud model. Scout's traffic is declared "internal" — map commands and public
  // feed data; sensitive tool results never enter the transcript (scrubbed above). The gateway
  // still scans content and raises the floor itself (a pasted card/SSN shape → 451), which is
  // reported to the operator as a refusal, never retried around.
  let upstream: Response;
  try {
    upstream = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-classification': 'internal' },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: MAX_TOKENS,
        // No sampling params: claude-opus-5 rejects `temperature` ("deprecated for this model").
        tools,
        tool_choice: 'auto',
        messages: [{ role: 'system', content: systemContent }, ...messages],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.error('[assistant] gateway unreachable', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'the local AI gateway did not answer' }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => '')).slice(0, 300);
    console.error('[assistant] gateway error', upstream.status, detail);
    if (upstream.status === 451) {
      return NextResponse.json({ error: 'the gateway refused to send this turn to a cloud model: its content scan rated it confidential', detail: 'Keep person-level data (numbers, emails, IDs) out of the chat — run those from the console directly.' }, { status: 502 });
    }
    return NextResponse.json({ error: `gateway ${upstream.status}`, detail }, { status: 502 });
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: Record<string, unknown>) => controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n'));
      const tools = new Map<number, ToolAcc>();
      let finish: string | null = null;
      let buffer = '';
      let closed = false;
      const flushTools = () => {
        for (const t of [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v)) send({ t: 'tool_call', id: t.id, name: t.name, args: t.args || '{}' });
        tools.clear();
      };
      const handle = (payload: string) => {
        if (payload === '[DONE]') { flushTools(); send({ t: 'done', finish: finish ?? 'stop' }); closed = true; return; }
        let json: Record<string, unknown>;
        try { json = JSON.parse(payload); } catch { return; }
        if (json.error) { send({ t: 'error', message: String((json.error as Record<string, unknown>).message ?? json.error).slice(0, 300) }); return; }
        const usage = json.usage as Record<string, number | undefined> | undefined;
        if (usage && (usage.prompt_tokens || usage.completion_tokens)) {
          const cached = usage.cache_read_input_tokens ?? 0, created = usage.cache_creation_input_tokens ?? 0;
          console.info(`[assistant] model=${MODEL} prompt=${usage.prompt_tokens ?? 0} completion=${usage.completion_tokens ?? 0} cache_read=${cached} cache_write=${created}`);
          send({ t: 'usage', prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0, cached, created });
        }
        const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0];
        if (!choice) return;
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        if (typeof delta.content === 'string' && delta.content) send({ t: 'delta', text: delta.content });
        if (Array.isArray(delta.tool_calls)) {
          for (const c of delta.tool_calls as Record<string, unknown>[]) {
            const idx = typeof c.index === 'number' ? c.index : 0;
            const fn = (c.function ?? {}) as Record<string, unknown>;
            const acc = tools.get(idx) ?? { id: '', name: '', args: '' };
            if (typeof c.id === 'string' && c.id) acc.id = c.id;
            if (typeof fn.name === 'string' && fn.name) acc.name = fn.name;
            if (typeof fn.arguments === 'string') acc.args += fn.arguments;
            tools.set(idx, acc);
          }
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
      };
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.startsWith('data:')) handle(line.slice(5).trim());
          }
        }
        if (!closed) { flushTools(); send({ t: 'done', finish: finish ?? 'stop' }); }
      } catch (e) {
        console.error('[assistant] stream broke', e instanceof Error ? e.message : e);
        send({ t: 'error', message: 'the model stream broke mid-turn' });
      } finally {
        controller.close();
      }
    },
    cancel() { void reader.cancel(); },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}
