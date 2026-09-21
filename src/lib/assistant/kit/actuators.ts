/**
 * UI actuators — the fallback layer for driving arbitrary DOM when a structured
 * form-registry handle is not available. Part of the Assistant Standard kit.
 *
 * DOER RULE (Nova lesson): prefer structured/local resolution. For forms, use the
 * form registry (`set_form_fields`). For clicks, `click_by_text` resolves by
 * accessible name + role and fires directly — no screenshot, no vision model.
 * Only fall back to a vision/computer-use loop when these return { ok: false }.
 *
 * Pure DOM — no framework, no server deps. Copy verbatim into any web app.
 */

export type ActuatorResult = { ok: boolean; detail: string };

type ClickRole = "button" | "link" | "tab" | "menuitem" | "any";

const ROLE_SELECTORS: Record<ClickRole, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"]',
  link: 'a[href], [role="link"]',
  tab: '[role="tab"]',
  menuitem: '[role="menuitem"]',
  any: 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"]',
};

function visibleText(el: Element): string {
  const aria = el.getAttribute("aria-label");
  const text = (aria || (el as HTMLElement).innerText || el.textContent || "").trim();
  return text.replace(/\s+/g, " ").toLowerCase();
}

function isVisible(el: Element): boolean {
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const style = window.getComputedStyle(el as HTMLElement);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

/**
 * Click a button/link/tab by its visible (or aria) text. Case-insensitive,
 * substring match, nth occurrence, optional ARIA role filter.
 */
export function clickByText(text: string, nth = 1, role: ClickRole = "any"): ActuatorResult {
  const needle = text.trim().toLowerCase();
  if (!needle) return { ok: false, detail: "empty text" };
  const candidates = Array.from(document.querySelectorAll(ROLE_SELECTORS[role]))
    .filter(isVisible)
    .filter((el) => visibleText(el).includes(needle));
  if (candidates.length === 0) return { ok: false, detail: `no clickable element matching "${text}"` };
  const target = candidates[Math.min(Math.max(nth, 1), candidates.length) - 1] as HTMLElement;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.click();
  return { ok: true, detail: `clicked "${visibleText(target)}"` };
}

/** Find an input/textarea/select by label, placeholder, aria-label, name, or associated <label>. */
export function findInput(hint: string): HTMLElement | null {
  const needle = hint.trim().toLowerCase();
  const fields = Array.from(
    document.querySelectorAll<HTMLElement>("input, textarea, select")
  ).filter(isVisible);
  const score = (el: HTMLElement): number => {
    const attrs = [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("id"),
    ]
      .filter(Boolean)
      .map((s) => s!.toLowerCase());
    const id = el.getAttribute("id");
    if (id) {
      const lbl = document.querySelector(`label[for="${id}"]`);
      if (lbl) attrs.push((lbl.textContent || "").toLowerCase());
    }
    return attrs.some((a) => a.includes(needle)) ? 1 : 0;
  };
  return fields.find((el) => score(el) > 0) ?? null;
}

/**
 * Type into an input found by hint. Dispatches input+change events so React
 * controlled inputs register the value. Optionally submits the enclosing form.
 */
export function typeText(hint: string, text: string, submit = false): ActuatorResult {
  const el = findInput(hint) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return { ok: false, detail: `no input matching "${hint}"` };
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  el.focus();
  setter ? setter.call(el, text) : (el.value = text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (submit) {
    const form = el.closest("form");
    if (form) form.requestSubmit?.() ?? form.submit();
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  return { ok: true, detail: `typed into "${hint}"${submit ? " + submitted" : ""}` };
}

export function scroll(
  direction: "up" | "down",
  amount: "page" | "half" | "top" | "bottom" = "page"
): ActuatorResult {
  if (amount === "top") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    return { ok: true, detail: "scrolled to top" };
  }
  if (amount === "bottom") {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    return { ok: true, detail: "scrolled to bottom" };
  }
  const factor = amount === "half" ? 0.5 : 0.9;
  const delta = window.innerHeight * factor * (direction === "up" ? -1 : 1);
  window.scrollBy({ top: delta, behavior: "smooth" });
  return { ok: true, detail: `scrolled ${direction} ${amount}` };
}

/** Browser back. Pass a router.back if you have one (Next.js) to keep SPA state. */
export function navBack(routerBack?: () => void): ActuatorResult {
  if (routerBack) routerBack();
  else window.history.back();
  return { ok: true, detail: "navigated back" };
}

/** Briefly highlight an element to point at it during a walkthrough. */
export function highlight(selector: string, ms = 2400): ActuatorResult {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, detail: `no element matching ${selector}` };
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  const prev = el.style.boxShadow;
  el.style.transition = "box-shadow 200ms ease";
  el.style.boxShadow = "0 0 0 3px var(--ring, #6366f1), 0 0 0 7px rgba(99,102,241,0.25)";
  window.setTimeout(() => {
    el.style.boxShadow = prev;
  }, ms);
  return { ok: true, detail: `highlighted ${selector}` };
}
