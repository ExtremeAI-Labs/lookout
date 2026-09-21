"use client";

/**
 * First-visit welcome modal — part of the Assistant Standard kit.
 *
 * Shows once per browser (storage-gated). Introduces the assistant by name, sets
 * the expectation that the tour is INTERACTIVE ("stop and ask anything, anytime"),
 * and offers a text tour and (if enabled) a voice tour.
 *
 * Portable React. No app-specific deps. Style via the design-token CSS vars your
 * app already defines (--background, --foreground, --primary, --border, --muted).
 */

import { useEffect, useState } from "react";

export type WelcomeModalProps = {
  /** Assistant name, e.g. "Olive", "Rocky", "Nova". */
  name: string;
  /** One-line who-am-I, e.g. "your family-office chief of staff". */
  tagline: string;
  /** localStorage key so it only shows once. e.g. "olive:assistant-welcome-seen". */
  storageKey: string;
  /** Whether to show the "Start voice tour" button. */
  voiceEnabled?: boolean;
  /** Called when the user picks the text tour. */
  onStartTextTour: () => void;
  /** Called when the user picks the voice tour. */
  onStartVoiceTour?: () => void;
  /** Optional persona-tailored blurb under the tagline. */
  blurb?: string;
};

export function WelcomeModal({
  name,
  tagline,
  storageKey,
  voiceEnabled,
  onStartTextTour,
  onStartVoiceTour,
  blurb,
}: WelcomeModalProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(storageKey)) setOpen(true);
    } catch {
      /* storage blocked — just don't show */
    }
  }, [storageKey]);

  function dismiss() {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const start = (voice: boolean) => {
    dismiss();
    if (voice && onStartVoiceTour) onStartVoiceTour();
    else onStartTextTour();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Meet ${name}`}
      onClick={dismiss}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        background: "rgba(0,0,0,0.45)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(460px, calc(100vw - 32px))",
          background: "var(--background, #fff)",
          color: "var(--foreground, #111)",
          border: "1px solid var(--border, #e5e7eb)",
          // Hosts with their own design system override these four (see ASSISTANT_STANDARD.md
          // "Theming"): --assistant-radius / --assistant-shadow / --assistant-control-radius /
          // --assistant-display-font. Defaults are the kit's own look, so existing hosts are unchanged.
          borderRadius: "var(--assistant-radius, 16px)",
          boxShadow: "var(--assistant-shadow, 0 24px 64px rgba(0,0,0,0.35))",
          padding: 24,
          position: "relative",
        }}
      >
        <button
          aria-label="Close"
          onClick={dismiss}
          style={{
            // 44×44 hit area (WCAG 2.5.8 floor is 24; hosts with hand-pain users need 44) —
            // the glyph stays small, the target does not.
            position: "absolute",
            top: 4,
            right: 4,
            width: 44,
            height: 44,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "var(--muted-foreground, #888)",
            fontSize: 20,
            cursor: "pointer",
            lineHeight: 1,
            borderRadius: "var(--assistant-control-radius, 10px)",
          }}
        >
          ×
        </button>

        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            marginBottom: 4,
            fontFamily: "var(--assistant-display-font, inherit)",
            letterSpacing: "var(--assistant-display-tracking, normal)",
            textTransform: "var(--assistant-display-transform, none)" as React.CSSProperties["textTransform"],
          }}
        >
          Meet {name}
        </div>
        <div style={{ color: "var(--muted-foreground, #666)", marginBottom: 14 }}>
          {tagline}
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.5, marginBottom: 8 }}>
          {blurb ??
            `I can answer questions, pull up the right screen, and fill things out for you. Want a quick interactive tour?`}
        </p>
        <p style={{ fontSize: 13, color: "var(--muted-foreground, #666)", marginBottom: 20 }}>
          The tour is interactive — <strong>stop and ask me anything, anytime</strong>. I'll
          actually show you, not just talk.
        </p>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {voiceEnabled && onStartVoiceTour && (
            <button
              onClick={() => start(true)}
              style={primaryBtn}
            >
              🎙 Start voice tour
            </button>
          )}
          <button
            onClick={() => start(false)}
            style={voiceEnabled ? secondaryBtn : primaryBtn}
          >
            Start text tour
          </button>
          <button onClick={dismiss} style={ghostBtn}>
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}

const primaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: "var(--assistant-control-radius, 10px)",
  border: "none",
  background: "var(--primary, #6366f1)",
  color: "var(--primary-foreground, #fff)",
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: "var(--assistant-control-radius, 10px)",
  border: "1px solid var(--border, #e5e7eb)",
  background: "transparent",
  color: "var(--foreground, #111)",
  fontWeight: 600,
  cursor: "pointer",
};
const ghostBtn: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: "var(--assistant-control-radius, 10px)",
  border: "none",
  background: "transparent",
  color: "var(--muted-foreground, #888)",
  cursor: "pointer",
};
