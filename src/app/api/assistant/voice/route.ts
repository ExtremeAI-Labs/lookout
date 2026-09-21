// Scout's voice — mints an ephemeral OpenAI Realtime client secret with the full session
// config applied (Assistant Standard §F: the long-lived key never reaches the browser; the
// browser then posts its SDP offer straight to OpenAI with the short-lived secret). The voice
// model is transport only: its single tool delegates every Lookout request to Scout (Claude)
// in the browser's chat loop — §D / §6.3.
//
// Env (all optional but the key): OPENAI_API_KEY · LOOKOUT_REALTIME_MODEL (gpt-realtime-2.1) ·
// LOOKOUT_TRANSCRIPTION_MODEL (gpt-live-transcribe) · LOOKOUT_REALTIME_VOICE (marin) ·
// LOOKOUT_REALTIME_REASONING (minimal). Hardcoded model ids are what turn a deprecation date
// into an outage — keep them here, env-overridable.
import { NextResponse } from 'next/server';
import { VOICE_DELEGATE_TOOL, buildVoiceInstructions } from '@/lib/assistant/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REALTIME_MODEL = process.env.LOOKOUT_REALTIME_MODEL || 'gpt-realtime-2.1';
const TRANSCRIPTION_MODEL = process.env.LOOKOUT_TRANSCRIPTION_MODEL || 'gpt-live-transcribe';
const VOICE = process.env.LOOKOUT_REALTIME_VOICE || 'marin';
const REASONING = process.env.LOOKOUT_REALTIME_REASONING || 'minimal';
const SECRET_TTL_S = 600;

export async function POST(req: Request) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: 'voice is not configured (OPENAI_API_KEY missing on the console)' }, { status: 503 });
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* an empty body is fine */ }
  const tour = body.tour === true;

  const mint = {
    expires_after: { anchor: 'created_at', seconds: SECRET_TTL_S },
    session: {
      type: 'realtime',
      model: REALTIME_MODEL,
      instructions: buildVoiceInstructions({ tour }),
      tools: [VOICE_DELEGATE_TOOL],
      output_modalities: ['audio'],
      reasoning: { effort: REASONING },
      audio: {
        input: {
          transcription: { model: TRANSCRIPTION_MODEL },
          // Push-to-talk is enforced in the browser by enabling the mic track only while held;
          // server VAD then closes each utterance and creates the response.
          turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
        },
        output: { voice: VOICE },
      },
    },
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(mint),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    console.error('[assistant/voice] mint unreachable', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'could not reach OpenAI to start voice' }, { status: 502 });
  }
  const text = await res.text();
  if (!res.ok) {
    console.error('[assistant/voice] mint failed', res.status, text.slice(0, 300));
    return NextResponse.json({ error: `voice session refused (${res.status})`, detail: text.slice(0, 300) }, { status: 502 });
  }
  let json: { value?: string; client_secret?: { value?: string }; expires_at?: number } = {};
  try { json = JSON.parse(text); } catch { /* handled below */ }
  const clientSecret = json.value ?? json.client_secret?.value;
  if (!clientSecret) {
    console.error('[assistant/voice] mint returned no secret', text.slice(0, 200));
    return NextResponse.json({ error: 'voice session came back without a secret' }, { status: 502 });
  }
  console.info(`[assistant/voice] session minted model=${REALTIME_MODEL} tour=${tour}`);
  return NextResponse.json({ clientSecret, model: REALTIME_MODEL, transcriptionModel: TRANSCRIPTION_MODEL, expiresAt: json.expires_at ?? null }, { headers: { 'cache-control': 'no-store' } });
}
