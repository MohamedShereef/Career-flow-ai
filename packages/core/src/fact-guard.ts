/**
 * Deterministic guard against invented facts in AI-written CV text.
 * Any sentence containing a number that does not appear in the applicant's own
 * verified material is removed (and reported), whatever the model intended.
 */

const NUM_RE = /(\d[\d,]*(?:\.\d+)?)\s*(%|k\b|m\b|mn\b|million\b|bn\b|billion\b)?/gi;

function toValue(raw: string, suffix?: string): number {
  const n = Number(raw.replace(/,/g, ""));
  switch ((suffix ?? "").toLowerCase()) {
    case "k":
      return n * 1e3;
    case "m":
    case "mn":
    case "million":
      return n * 1e6;
    case "bn":
    case "billion":
      return n * 1e9;
    default:
      return n;
  }
}

/** All numeric values in a text, normalized (e.g. "SAR 60M" → 60000000, "15%" → 15). */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    const v = toValue(m[1]!, m[2]);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export class FactGuard {
  private allowed = new Set<number>();
  readonly removed: string[] = [];

  constructor(sources: Array<string | number | null | undefined>, private heldQualifications: string[] = []) {
    for (const s of sources) {
      if (s === null || s === undefined) continue;
      if (typeof s === "number") this.allow(s);
      else for (const n of numbersIn(s)) this.allow(n);
    }
    // Small ordinal words rendered as digits ("1 of 3 bidders") are rare in CVs; we
    // intentionally allow nothing implicitly.
  }

  private allow(n: number) {
    this.allowed.add(n);
    // Also accept the common short forms of large figures: 60000000 → 60 (as in "60M").
    if (n >= 1e9) this.allowed.add(n / 1e9);
    else if (n >= 1e6) this.allowed.add(n / 1e6);
    else if (n >= 1e3) this.allowed.add(n / 1e3);
  }

  private sentenceOk(sentence: string): boolean {
    if (numbersIn(sentence).some((n) => !this.allowed.has(n))) return false;
    // "Certified" claims must name a qualification the user actually holds.
    if (/\bcertified\b|\bcertification holder\b|\bchartered\b/i.test(sentence)) {
      const s = sentence.toLowerCase();
      if (!this.heldQualifications.some((q) => q && s.includes(q.toLowerCase()))) return false;
    }
    return true;
  }

  /** Keep a single statement (bullet) or drop it entirely. */
  keep(statement: string): boolean {
    const ok = this.sentenceOk(statement);
    if (!ok) this.removed.push(statement);
    return ok;
  }

  /** Filter a paragraph sentence by sentence. */
  paragraph(text: string): string {
    const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/);
    return parts.filter((p) => this.keep(p)).join(" ").trim();
  }

  /** Filter a multi-paragraph letter, keeping paragraph breaks. */
  letter(text: string): string {
    return text
      .split(/\n{2,}/)
      .map((p) => this.paragraph(p.replace(/\s*\n\s*/g, " ")))
      .filter(Boolean)
      .join("\n\n");
  }
}
