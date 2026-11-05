/**
 * Map an answer to the option a site actually offers: "Egyptian" → "Egypt", "Islam" → "Muslim",
 * "married" → "Married". Deterministic first; the AI is only asked when this can't decide.
 */
const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const DEMONYMS: Record<string, string[]> = {
  egyptian: ["egypt"], saudi: ["saudi arabia", "kingdom of saudi arabia", "ksa"], jordanian: ["jordan"], lebanese: ["lebanon"], syrian: ["syria", "syrian arab republic"],
  sudanese: ["sudan"], emirati: ["united arab emirates", "uae"], kuwaiti: ["kuwait"], bahraini: ["bahrain"], omani: ["oman"], qatari: ["qatar"], yemeni: ["yemen"],
  iraqi: ["iraq"], palestinian: ["palestine", "palestinian territories"], tunisian: ["tunisia"], moroccan: ["morocco"], algerian: ["algeria"], libyan: ["libya"],
  indian: ["india"], pakistani: ["pakistan"], bangladeshi: ["bangladesh"], "sri lankan": ["sri lanka"], nepali: ["nepal"], nepalese: ["nepal"], filipino: ["philippines"],
  british: ["united kingdom", "uk", "great britain"], american: ["united states", "usa", "united states of america"], turkish: ["turkey", "turkiye", "türkiye"],
};
const GROUPS: string[][] = [
  ["islam", "muslim", "moslem"],
  ["christianity", "christian"],
  ["judaism", "jewish"],
  ["hinduism", "hindu"],
  ["buddhism", "buddhist"],
  ["married", "marriage"],
  ["single", "unmarried", "never married"],
  ["divorced"],
  ["widowed", "widow", "widower"],
  ["male", "man", "m"],
  ["female", "woman", "f"],
  ["yes", "y", "true"],
  ["no", "n", "false"],
  ["bachelor", "bachelor's degree", "bachelors", "bachelor degree", "bsc", "b.sc", "ba", "b.a", "beng", "b.eng"],
  ["master", "master's degree", "masters", "msc", "m.sc", "mba", "ma"],
  ["iqama", "residence permit", "resident id", "residency id"],
  ["national id", "national identity", "national id card"],
  ["passport"],
];

/** Other ways the same answer may be written (used to type a search prefix and to match). */
export function alternatives(wanted: string): string[] {
  const w = norm(wanted);
  const out = new Set<string>([w]);
  for (const [demonym, countries] of Object.entries(DEMONYMS)) {
    if (w === demonym || countries.includes(w)) [demonym, ...countries].forEach((x) => out.add(x));
  }
  for (const g of GROUPS) if (g.includes(w)) g.forEach((x) => out.add(x));
  return [...out];
}

/** The single option that means the wanted answer, or null when it isn't clear. */
export function bestOption(wanted: string, options: string[]): string | null {
  const opts = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
  if (!opts.length) return null;
  const alts = alternatives(wanted);
  const n = (o: string) => norm(o);
  const unique = (xs: string[]) => (xs.length === 1 ? xs[0]! : null);
  return (
    unique(opts.filter((o) => alts.includes(n(o)))) ??
    unique(opts.filter((o) => alts.some((a) => a.length >= 3 && (n(o).startsWith(a) || a.startsWith(n(o)) && n(o).length >= 3)))) ??
    unique(opts.filter((o) => alts.some((a) => a.length >= 4 && n(o).includes(a)))) ??
    null
  );
}
