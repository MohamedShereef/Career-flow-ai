const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", bull: "•" };

/** HTML → readable plain text (keeps list items and paragraphs as lines). */
export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let s = String(html);
  // Some APIs return entity-escaped HTML (Greenhouse).
  if (/&lt;\/?[a-z]/i.test(s)) s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  s = s
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<\s*(br|\/p|\/div|\/h\d|\/ul|\/ol|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s || null;
}

const GCC: Array<[RegExp, string]> = [
  [/\b(saudi|ksa|riyadh|jeddah|jiddah|dammam|khobar|dhahran|makkah|mecca|madinah|medina|neom|tabuk|jubail|yanbu|abha|al ula|alula|qassim|hail|taif)\b/i, "Saudi Arabia"],
  [/\b(uae|united arab emirates|dubai|abu dhabi|sharjah|ajman|ras al khaimah)\b/i, "United Arab Emirates"],
  [/\b(qatar|doha|lusail)\b/i, "Qatar"],
  [/\b(kuwait)\b/i, "Kuwait"],
  [/\b(bahrain|manama)\b/i, "Bahrain"],
  [/\b(oman|muscat)\b/i, "Oman"],
  [/\b(egypt|cairo|alexandria)\b/i, "Egypt"],
];

export function guessCountry(...parts: Array<string | null | undefined>): string | null {
  const s = parts.filter(Boolean).join(" ");
  if (!s) return null;
  if (/^(sa|sau)$/i.test(s.trim())) return "Saudi Arabia";
  for (const [re, c] of GCC) if (re.test(s)) return c;
  return null;
}

export const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined || v === "") return null;
  const d = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
