// KIT COPY (canonical: aperture/lib/deckTour/speakable.ts; keep in sync).
// What the voice actually SAYS (humanness gauntlet round 0, 2026-09-04). The model writes for
// the eye — "$13.5M", "7.4x", "20-25%", markdown emphasis — and TTS models read that with the
// flat "reading a symbol" cadence that screams AI (ElevenLabs' realtime models keep text
// normalization off for latency, so nobody else fixes it either). This transform runs at the
// single choke point (the /tts route) so the TRANSCRIPT keeps the written form the pointing
// matchers rely on, while the ear gets words a person would say. Pure; unit-tested.

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function intWords(n: number): string {
  if (n < 0 || !Number.isFinite(n)) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) { const o = n % 10; return o ? `${TENS[Math.floor(n / 10)]}-${ONES[o]}` : TENS[Math.floor(n / 10)]; }
  if (n < 1000) { const r = n % 100; return `${ONES[Math.floor(n / 100)]} hundred${r ? ` ${intWords(r)}` : ""}`; }
  if (n < 1000000) { const r = n % 1000; return `${intWords(Math.floor(n / 1000))} thousand${r ? ` ${intWords(r)}` : ""}`; }
  return String(n);
}

function numWords(num: string): string {
  const [i, d] = num.split(".");
  const n = Number(i);
  if (!Number.isFinite(n) || n >= 1000000) return num;
  if (!d) return intWords(n);
  if (d === "5") return `${intWords(n)} and a half`;
  if (d === "25") return `${intWords(n)} and a quarter`;
  return `${intWords(n)} point ${d.split("").map((c) => ONES[Number(c)] ?? c).join(" ")}`;
}

const UNIT: Record<string, string> = { k: "thousand", m: "million", b: "billion", t: "trillion" };

/** Rewrite text for the ear. Idempotent on already-speakable text. */
export function speakable(text: string): string {
  let s = text;

  // Markdown / typography the ear can't hear.
  s = s.replace(/[*_`#]+/g, "");
  s = s.replace(/\s*[—–]\s*/g, ", ");
  s = s.replace(/[""]/g, '"').replace(/['']/g, "'");

  // Ranges before single figures: "$10-20M" / "20-25%" → "ten to twenty million dollars" / "twenty to twenty-five percent".
  s = s.replace(/\$\s?(\d+(?:\.\d+)?)\s?[-–]\s?\$?\s?(\d+(?:\.\d+)?)\s?([kKmMbBtT])\b/g, (_, a, b, u) => `${numWords(a)} to ${numWords(b)} ${UNIT[u.toLowerCase()]} dollars`);
  s = s.replace(/(\d+(?:\.\d+)?)\s?[-–]\s?(\d+(?:\.\d+)?)\s?%/g, (_, a, b) => `${numWords(a)} to ${numWords(b)} percent`);

  // Money: "$13.5M" → "thirteen and a half million dollars"; "$500K"; bare "$2,400".
  s = s.replace(/\$\s?(\d+(?:\.\d+)?)\s?([kKmMbBtT])\b/g, (_, n, u) => `${numWords(n)} ${UNIT[u.toLowerCase()]} dollars`);
  s = s.replace(/(\d+(?:\.\d+)?)\s?(million|billion|thousand|trillion)\s+dollars/gi, (_, n, u) => `${numWords(n)} ${u.toLowerCase()} dollars`);
  s = s.replace(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?!\.?\d*\s?[kKmMbBtT%])/g, (_, n: string) => { const v = Number(n.replace(/,/g, "")); return v < 1000000 ? `${intWords(v)} dollars` : `${n.replace(/,/g, "")} dollars`; });

  // Multiples and percents: "7.4x" → "seven point four x"; "2.5%" → "two and a half percent".
  s = s.replace(/\b(\d+(?:\.\d+)?)\s?x\b/gi, (_, n) => `${numWords(n)} x`);
  s = s.replace(/(\d+(?:\.\d+)?)\s?%/g, (_, n) => `${numWords(n)} percent`);

  // Slide references stay ordinal-ish but digits are fine ("slide 19" reads naturally); years stay digits.

  // Abbreviations that read wrong aloud.
  s = s.replace(/\bvs\.?(?=[\s,.!?]|$)/gi, "versus").replace(/\be\.g\.\s*/gi, "for example, ").replace(/\bi\.e\.\s*/gi, "that is, ");

  return s.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}
