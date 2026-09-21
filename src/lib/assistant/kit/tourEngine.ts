/**
 * Tour engine — the app-agnostic part of the interactive guided tour.
 * Part of the Assistant Standard kit.
 *
 * You define the STOPS (per-app). This module turns them into (a) a single
 * kickoff prompt for a text tour and (b) a "tutorial layer" appended to the
 * system/voice instructions that encodes the one-stop-then-pause protocol,
 * pause/resume, barge-in, and (optionally) a continuous cross-workspace tour.
 *
 * The defining property of our tours (the Rocky lesson): the assistant does not
 * just talk — at a stop it can perform a real DEMO action (navigate, fill a
 * sample form, run a real generate) via the standard UI-actuator tools.
 */

export type TourStop = {
  /** In-app route to navigate to for this stop (validated against your whitelist). */
  path: string;
  /** Short label for the stop, e.g. "Your morning brief". */
  label: string;
  /** What to say about this screen — 1-3 sentences of narration. */
  narration: string;
  /** Optional CSS selector to highlight while narrating. */
  highlight?: string;
  /**
   * Optional live DEMO the assistant performs here, phrased as an instruction to
   * itself, e.g. "Call set_form_fields on form 'task.create' with a sample task,
   * then explain what each field does. Do NOT submit." Keep demos non-destructive.
   */
  demo?: string;
};

export type Tour = {
  /** Persona/workspace this tour belongs to (for multi-role apps). */
  persona: string;
  /** One or two sentence intro the assistant opens with. */
  intro: string;
  stops: TourStop[];
};

const SEP = "\n\n";

/**
 * Marks a chat-message envelope as tutorial-layer plumbing: send it to the model, but never draw
 * it as a chat bubble. Spread this onto whatever message shape your app's dock uses for the
 * tourKickoff() seed turn, e.g.:
 *
 *   appendMessage({ id, role: "user", text: tourKickoff(tour), ...TOUR_KICKOFF_FLAGS, createdAt });
 *
 * and in your message-list renderer: `if (message.hidden) return null;`. Without this, the
 * kickoff's raw instruction text (stop list, DEMO directives, "do not submit forms" rules) shows
 * up as a giant user-style bubble instead of being consumed silently — the assistant's own
 * narration (opening with `tour.intro`) is the first thing the user should ever see.
 */
export const TOUR_KICKOFF_FLAGS = { hidden: true } as const;

/**
 * Single seed message that kicks off a TEXT tour. Sent as the first turn of the model-facing
 * conversation (so the model receives the full stop list + rules) — it is NOT something the user
 * typed and must never be rendered in the visible transcript. Mark the message you build from
 * this hidden (see TOUR_KICKOFF_FLAGS above); the model's reply (opening with `tour.intro`) is
 * the first visible bubble.
 */
export function tourKickoff(tour: Tour): string {
  return [
    `Start the guided tour for the ${tour.persona} workspace.`,
    `Open with: "${tour.intro}"`,
    `There are ${tour.stops.length} stops. Do ONE stop at a time, then pause and ask if they want to continue or have a question.`,
    `Stops:`,
    ...tour.stops.map((s, i) => stopLine(i + 1, tour.stops.length, s)),
    `Rules: navigate to each stop's path with the navigate tool before narrating it. If a stop has a DEMO, actually perform it with the form/actuator tools so they see it happen — never just describe it. Never submit forms or take irreversible actions during the tour. Track which stop you are on; never restart or repeat a stop.`,
  ].join(SEP);
}

function stopLine(n: number, total: number, s: TourStop): string {
  const parts = [
    `Stop ${n}/${total} — ${s.label} (navigate to ${s.path}): ${s.narration}`,
  ];
  if (s.highlight) parts.push(`  Highlight: ${s.highlight}`);
  if (s.demo) parts.push(`  DEMO (do this live): ${s.demo}`);
  return parts.join("\n");
}

export const TOUR_PAUSE_SIGNAL = "__TOUR_PAUSE__";
export const TOUR_RESUME_SIGNAL = "__TOUR_RESUME__";

/**
 * Tutorial layer appended to the system prompt (text) or session instructions
 * (voice). Encodes the "real person walking you through it" behavior. Voice mode
 * sets `voice: true` to enforce brevity and no markdown.
 */
export function buildTutorialLayer(tour: Tour, opts: { voice?: boolean } = {}): string {
  const lines = [
    `GUIDED TUTORIAL MODE — ${tour.persona}.`,
    `You are walking the user through the product like a real person on a call.`,
    `You have ${tour.stops.length} stops. At every moment you know which stop you are ON and which is NEXT. Never restart, never repeat a completed stop.`,
    `Protocol: do exactly ONE stop, then STOP TALKING and wait. After a stop, briefly offer to continue ("Want me to keep going?") and wait for them.`,
    `Each stop: (1) navigate to its path, (2) narrate its points, (3) if it has a DEMO, actually perform it with the form/actuator tools — they should see it happen, not hear it described.`,
    `Barge-in: if they interrupt with a question, stop the tour, answer it, then offer to resume from the stop you were on.`,
    `Pause/resume: the signal "${TOUR_PAUSE_SIGNAL}" means pause immediately (a button tap is as authoritative as them saying "pause"). "${TOUR_RESUME_SIGNAL}" means resume from the current stop. Treat both exactly like a spoken request.`,
    `Never submit a form, send anything, or take an irreversible action during the tour. Demos are non-destructive only.`,
  ];
  if (opts.voice) {
    lines.push(
      `Voice: speak naturally and briefly — one or two sentences per beat. No markdown, no emoji, no lists read aloud.`
    );
  }
  lines.push(`Stops:`);
  tour.stops.forEach((s, i) => lines.push(stopLine(i + 1, tour.stops.length, s)));
  return lines.join("\n");
}

/**
 * Continuous cross-workspace tour for multi-role apps: walk tour A fully, then
 * an explicit SWITCH beat (call switch_workspace), then walk tour B. Stops are
 * numbered continuously across the boundary.
 */
export function buildContinuousTutorialLayer(a: Tour, b: Tour): string {
  const total = a.stops.length + b.stops.length;
  const lines = [
    `CONTINUOUS CROSS-WORKSPACE TUTORIAL — ${total} stops across two workspaces.`,
    `Walk all of "${a.persona}" first, then do an explicit switch beat: tell them you're switching workspaces, call switch_workspace("${b.persona}"), then walk all of "${b.persona}".`,
    `Number stops continuously 1..${total}; never restart at the switch. One stop at a time, then pause.`,
    `Workspace A — ${a.persona}: ${a.intro}`,
    ...a.stops.map((s, i) => stopLine(i + 1, total, s)),
    `SWITCH BEAT: announce the switch, call switch_workspace("${b.persona}"), then continue.`,
    `Workspace B — ${b.persona}: ${b.intro}`,
    ...b.stops.map((s, i) => stopLine(a.stops.length + i + 1, total, s)),
  ];
  return lines.join("\n");
}
