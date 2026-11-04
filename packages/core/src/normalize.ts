/** Normalization helpers shared by discovery, saved answers and email matching. */

const COMPANY_SUFFIXES =
  /\b(co|company|corp|corporation|inc|llc|ltd|limited|plc|gmbh|sa|s\.a|spa|ag|bv|wll|w\.l\.l|est|establishment|group|holding|holdings|ksa|saudi arabia)\b\.?/g;

/** "FCC Construcción S.A." → "fcc construccion" */
export function employerKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s.]/gu, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/[.\s]+/g, " ")
    .trim();
}

/**
 * Canonical form of an application question so "Are you legally authorized to
 * work in Saudi Arabia? *" and "are you legally authorised to work in saudi arabia"
 * resolve to the same saved answer.
 */
export function normalizeQuestion(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\(required\)|\(optional\)|\*/g, " ")
    .replace(/authorised/g, "authorized")
    .replace(/organisation/g, "organization")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
