'use client';
// Scout's voice channel — OpenAI Realtime over WebRTC (Assistant Standard §F, v2.1 mechanics).
// The voice model is transport: its one tool, delegate_to_scout, hands the request to the
// Claude chat loop and speaks what came back. Enforced in code, not prompt:
//   · push-to-talk by default (the mic track is enabled only while held; server VAD closes the turn),
//   · one in-flight response at a time — tool outputs queue until response.done,
//   · speakable() on everything the voice is handed,
//   · a live spend readout and a hard time cap that ends the call.
import { useCallback, useEffect, useRef, useState } from 'react';
import { speakable } from '@/lib/assistant/kit/speakable';

export type VoiceStatus = { kind: 'idle' } | { kind: 'connecting' } | { kind: 'live' } | { kind: 'error'; message: string };
export type VoiceMode = 'ptt' | 'open';

type Opts = {
  delegate: (request: string) => Promise<string>;
  onTranscript: (role: 'user' | 'assistant', text: string) => void;
  maxMinutes: number;
  usdPerMinute: number;
};

type Session = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  mic: MediaStream;
  audio: HTMLAudioElement;
  responseActive: boolean;
  queuedOutputs: { call_id: string; output: string }[];
  since: number;
};

const SDP_URL = 'https://api.openai.com/v1/realtime/calls';

export function useRealtimeVoice(opts: Opts) {
  const [status, setStatus] = useState<VoiceStatus>({ kind: 'idle' });
  const [mode, setModeState] = useState<VoiceMode>('ptt');
  const [talking, setTalking] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);
  const sessionRef = useRef<Session | null>(null);
  const modeRef = useRef<VoiceMode>('ptt');
  const optsRef = useRef(opts);
  useEffect(() => { optsRef.current = opts; });

  const stop = useCallback((reason?: string) => {
    const s = sessionRef.current;
    sessionRef.current = null;
    if (s) {
      try { s.dc.close(); } catch { /* already closed */ }
      try { s.pc.close(); } catch { /* already closed */ }
      s.mic.getTracks().forEach((t) => t.stop());
      s.audio.srcObject = null;
    }
    setTalking(false); setSpeaking(false); setElapsedS(0);
    setStatus(reason ? { kind: 'error', message: reason } : { kind: 'idle' });
  }, []);

  // Spend clock + hard cap.
  useEffect(() => {
    if (status.kind !== 'live') return;
    const t = setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      const secs = Math.round((Date.now() - s.since) / 1000);
      setElapsedS(secs);
      if (secs >= optsRef.current.maxMinutes * 60) stop(`voice ended: ${optsRef.current.maxMinutes}-minute cap reached`);
    }, 1000);
    return () => clearInterval(t);
  }, [status.kind, stop]);

  const sendEvent = (s: Session, ev: Record<string, unknown>) => { if (s.dc.readyState === 'open') s.dc.send(JSON.stringify(ev)); };

  const flushOutputs = (s: Session) => {
    if (s.responseActive || !s.queuedOutputs.length) return;
    for (const o of s.queuedOutputs.splice(0)) sendEvent(s, { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: o.call_id, output: o.output } });
    s.responseActive = true;
    sendEvent(s, { type: 'response.create' });
  };

  const handleFunctionCall = async (s: Session, callId: string, name: string, args: string) => {
    let output: string;
    if (name !== 'delegate_to_scout') output = JSON.stringify({ ok: false, note: `unknown tool ${name}` });
    else {
      let request = '';
      try { request = String((JSON.parse(args || '{}') as { request?: unknown }).request ?? ''); } catch { /* empty */ }
      if (!request.trim()) output = 'Nothing to hand over — the request was empty.';
      else {
        const reply = await optsRef.current.delegate(request).catch((e) => `Scout hit an error: ${e instanceof Error ? e.message : String(e)}`);
        output = speakable((reply || "Scout didn't answer that one — say it again?").slice(0, 1200));
      }
    }
    if (sessionRef.current !== s) return;
    s.queuedOutputs.push({ call_id: callId, output });
    flushOutputs(s);
  };

  const onMessage = (s: Session, raw: string) => {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(raw); } catch { return; }
    const type = String(ev.type ?? '');
    if (type === 'response.created') { s.responseActive = true; setSpeaking(true); return; }
    if (type === 'response.done') {
      s.responseActive = false; setSpeaking(false);
      const resp = (ev.response ?? {}) as { output?: { type?: string; call_id?: string; name?: string; arguments?: string }[]; status?: string; status_details?: { error?: { message?: string } } };
      if (resp.status === 'failed') { const m = resp.status_details?.error?.message; if (m) setStatus({ kind: 'error', message: m }); }
      for (const item of resp.output ?? []) if (item.type === 'function_call' && item.call_id && item.name) void handleFunctionCall(s, item.call_id, item.name, item.arguments ?? '');
      flushOutputs(s);
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed' && typeof ev.transcript === 'string' && ev.transcript.trim()) { optsRef.current.onTranscript('user', ev.transcript.trim()); return; }
    if ((type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') && typeof ev.transcript === 'string' && ev.transcript.trim()) { optsRef.current.onTranscript('assistant', ev.transcript.trim()); return; }
    if (type === 'error') {
      const err = (ev.error ?? {}) as { message?: string; code?: string };
      if (err.code === 'response_cancel_not_active' || err.code === 'conversation_already_has_active_response') return; // benign races
      setStatus({ kind: 'error', message: err.message ?? 'voice error' });
    }
  };

  const start = useCallback(async (init: { tour?: boolean } = {}) => {
    if (sessionRef.current) return;
    if (typeof RTCPeerConnection === 'undefined' || !navigator.mediaDevices?.getUserMedia) { setStatus({ kind: 'error', message: 'this browser cannot do WebRTC voice' }); return; }
    setStatus({ kind: 'connecting' });
    let mic: MediaStream | null = null;
    let pc: RTCPeerConnection | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mintRes = await fetch('/api/assistant/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tour: init.tour === true }), signal: AbortSignal.timeout(25_000) });
      const mint = (await mintRes.json().catch(() => ({}))) as { clientSecret?: string; model?: string; error?: string; detail?: string };
      if (!mintRes.ok || !mint.clientSecret || !mint.model) throw new Error(mint.error ? `${mint.error}${mint.detail ? ` — ${mint.detail}` : ''}` : `voice mint failed (${mintRes.status})`);

      pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const audio = new Audio();
      audio.autoplay = true;
      pc.ontrack = (e) => { audio.srcObject = e.streams[0]; void audio.play().catch(() => { /* autoplay policy: the user tapped to start, so this normally plays */ }); };
      const track = mic.getAudioTracks()[0];
      track.enabled = modeRef.current === 'open';
      pc.addTrack(track, mic);
      const dc = pc.createDataChannel('oai-events');
      const session: Session = { pc, dc, mic, audio, responseActive: false, queuedOutputs: [], since: Date.now() };
      dc.onmessage = (e) => onMessage(session, String(e.data));
      pc.onconnectionstatechange = () => {
        if (sessionRef.current !== session) return;
        if (pc!.connectionState === 'failed' || pc!.connectionState === 'closed') stop('voice connection dropped');
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpRes = await fetch(`${SDP_URL}?model=${encodeURIComponent(mint.model)}`, { method: 'POST', headers: { authorization: `Bearer ${mint.clientSecret}`, 'content-type': 'application/sdp' }, body: offer.sdp, signal: AbortSignal.timeout(25_000) });
      if (!sdpRes.ok) throw new Error(`SDP exchange failed (${sdpRes.status})`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });
      await new Promise<void>((resolve, reject) => {
        if (dc.readyState === 'open') { resolve(); return; }
        const t = setTimeout(() => reject(new Error('voice channel did not open')), 15_000);
        dc.onopen = () => { clearTimeout(t); resolve(); };
      });
      sessionRef.current = session;
      setStatus({ kind: 'live' });
    } catch (e) {
      mic?.getTracks().forEach((t) => t.stop());
      try { pc?.close(); } catch { /* fine */ }
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'could not start voice' });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop]);

  const setMode = useCallback((m: VoiceMode) => {
    modeRef.current = m; setModeState(m);
    const s = sessionRef.current;
    if (s) { const t = s.mic.getAudioTracks()[0]; if (t) t.enabled = m === 'open'; }
    if (m === 'open') setTalking(false);
  }, []);

  const hold = useCallback((down: boolean) => {
    const s = sessionRef.current;
    if (!s || modeRef.current !== 'ptt') return;
    const t = s.mic.getAudioTracks()[0];
    if (t) t.enabled = down;
    setTalking(down);
  }, []);

  useEffect(() => () => stop(), [stop]);

  const estUsd = (elapsedS / 60) * opts.usdPerMinute;
  return { status, mode, talking, speaking, elapsedS, estUsd, start, stop, setMode, hold };
}
