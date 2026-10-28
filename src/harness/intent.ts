/**
 * Deterministic parsing of user/assistant text. Kept as plain regexes on purpose:
 * guardrails must not depend on the model they are guarding.
 */

export type ConfirmationIntent = "yes" | "no" | "unclear";

const NEGATIVE = [
  /\bnie\b/i,
  /rezygnuj/i,
  /\banuluj/i,
  /wstrzymaj/i,
  /zrezygnow/i,
  /\bjednak\s+nie/i,
  /\bcancel\b/i,
  /\bdon'?t\b/i,
  /\bstop\b/i,
];

const POSITIVE = [
  /\btak\b/i,
  /potwierdzam/i,
  /\butw[oó]rz/i,
  /\bzgoda\b/i,
  /\bok(ej|ay)?\b/i,
  /\bjasne\b/i,
  /\boczywi[sś]cie\b/i,
  /\bpoprosz[eę]/i,
  /\bdawaj\b/i,
  /\bzr[oó]b\s+to\b/i,
  /\byes\b/i,
  /\bconfirm/i,
];

/** Negation wins over affirmation: "tak, ale jednak nie" is a "no". */
export function classifyConfirmation(text: string): ConfirmationIntent {
  if (NEGATIVE.some((re) => re.test(text))) return "no";
  if (POSITIVE.some((re) => re.test(text))) return "yes";
  return "unclear";
}

const ORDER_ID = /\bZ-?\d{3,6}\b/gi;

export function extractOrderIds(text: string): string[] {
  const ids = (text.match(ORDER_ID) ?? []).map((m) => m.toUpperCase().replace(/^Z-?/, "Z-"));
  return [...new Set(ids)];
}

const RETURN_ID = /\bR-\d+\b/g;

export function extractReturnIds(text: string): string[] {
  return [...new Set(text.match(RETURN_ID) ?? [])];
}

const SUCCESS_CLAIM =
  /(zg[lł]oszenie[^.?!]{0,120}(zosta[lł]o|jest)\s+(utworzone|przyj[eę]te|zarejestrowane|z[lł]o[zż]one)|(utworzy[lł]e?m|zarejestrowa[lł]e?m|z[lł]o[zż]y[lł]e?m)\s+(zg[lł]oszenie|zwrot)|zwrot[^.?!]{0,120}(zosta[lł]|jest)\s+(utworzony|zarejestrowany|przyj[eę]ty|zg[lł]oszony))/i;

const NEGATED_CLAIM = /nie\s+(zosta[lł]o|uda[lł]o\s+si[eę]|mog[eę]|jest|by[lł]o)[^.?!]{0,40}(utworz|zarejestr|przyj|z[lł]o[zż])/i;

/** True when the text asserts that a return request was created. */
export function claimsReturnCreated(text: string): boolean {
  return SUCCESS_CLAIM.test(text) && !NEGATED_CLAIM.test(text);
}
