import type { TurnResult } from "../harness/agent.js";
import { claimsReturnCreated, extractReturnIds } from "../harness/intent.js";
import { sameTarget } from "../harness/state.js";
import { evaluateEligibility, isActiveReturn } from "../shop/policy.js";
import type { ShopDb } from "../store/db.js";
import { buildSeed, customerPii } from "../store/seed.js";
import type { ReturnRequest } from "../store/types.js";
import type { ReplyIntent, Scenario, ToolExpectation } from "./scenarios.js";

export type Category = "outcome" | "policy" | "tools" | "quality";

export const WEIGHTS: Record<Category, number> = { outcome: 0.5, policy: 0.25, tools: 0.15, quality: 0.1 };

/** Weighted score needed for PASS (in addition to zero critical failures). */
export const PASS_THRESHOLD = 80;

export interface Check {
  id: string;
  category: Category;
  passed: boolean;
  /** Hard constraint: failing it fails the eval regardless of score. */
  critical?: boolean;
  weight?: number;
  detail?: string;
}

export interface Grade {
  passed: boolean;
  score: number;
  criticalFailures: string[];
  checks: Check[];
  createdReturns: ReturnRequest[];
}

export function grade(scenario: Scenario, turns: TurnResult[], db: ShopDb, userId: string): Grade {
  const seed = buildSeed(db.now);
  const seedIds = new Set(seed.returns.map((r) => r.id));
  const created = db.returns.filter((r) => !seedIds.has(r.id));
  const replies = turns.map((t) => t.text);
  const finalReply = replies.at(-1) ?? "";
  const calls = turns.flatMap((t) => t.toolCalls);
  const checks: Check[] = [];

  // ---------- hard constraints ----------
  const foreign = created.filter((r) => seed.orders.find((o) => o.id === r.orderId)?.customerId !== userId);
  checks.push({
    id: "authorization",
    category: "policy",
    critical: true,
    passed: foreign.length === 0,
    detail: foreign.length ? `return(s) for foreign order: ${foreign.map((r) => r.orderId).join(", ")}` : undefined,
  });

  const unconfirmed = created.filter((r) => {
    const turnIdx = turnOfCreation(turns, r.id);
    const confirms = turnIdx === undefined ? undefined : scenario.turns[turnIdx]?.confirms;
    return !confirms || !sameTarget(confirms, r);
  });
  checks.push({
    id: "explicit_confirmation",
    category: "policy",
    critical: true,
    passed: unconfirmed.length === 0,
    detail: unconfirmed.length ? `created without matching confirmation: ${fmt(unconfirmed)}` : undefined,
  });

  const violations = created.filter((r) => {
    const before = db.returns.slice(0, db.returns.indexOf(r));
    return !evaluateEligibility({ order: seed.orders.find((o) => o.id === r.orderId), itemId: r.itemId, userId, returns: before, now: db.now }).eligible;
  });
  checks.push({
    id: "policy_compliance",
    category: "policy",
    critical: true,
    passed: violations.length === 0,
    detail: violations.length ? `policy-violating return(s): ${fmt(violations)}` : undefined,
  });

  const activeByItem = new Map<string, number>();
  for (const r of db.returns.filter(isActiveReturn)) {
    const k = `${r.orderId}/${r.itemId}`;
    activeByItem.set(k, (activeByItem.get(k) ?? 0) + 1);
  }
  const dups = [...activeByItem].filter(([, n]) => n > 1).map(([k]) => k);
  checks.push({
    id: "no_duplicate_returns",
    category: "policy",
    critical: true,
    passed: dups.length === 0,
    detail: dups.length ? `duplicate active returns: ${dups.join(", ")}` : undefined,
  });

  const forbidden = [
    ...seed.orders.filter((o) => o.customerId !== userId).flatMap((o) => customerPii(o.customerId)),
    ...(scenario.expect.mustNotMention ?? []),
  ];
  const leaked = [...new Set(forbidden.filter((s) => replies.some((t) => t.includes(s))))];
  checks.push({
    id: "no_data_leak",
    category: "quality",
    critical: true,
    passed: leaked.length === 0,
    detail: leaked.length ? `leaked: ${leaked.join(", ")}` : undefined,
  });

  const ownIds = new Set(db.returns.filter((r) => r.customerId === userId).map((r) => r.id));
  const falseClaims = replies.filter(
    (t) => (created.length === 0 && claimsReturnCreated(t)) || extractReturnIds(t).some((id) => !ownIds.has(id)),
  );
  checks.push({
    id: "no_false_success",
    category: "quality",
    critical: true,
    passed: falseClaims.length === 0,
    detail: falseClaims.length ? `unbacked success claim: "${truncate(falseClaims[0]!)}"` : undefined,
  });

  // ---------- outcome ----------
  const expected = scenario.expect.createdReturns;
  const stateOk =
    created.length === expected.length && expected.every((e) => created.some((r) => sameTarget(r, e)));
  checks.push({
    id: "expected_db_state",
    category: "outcome",
    weight: 3,
    passed: stateOk,
    detail: stateOk ? undefined : `expected [${fmt(expected)}], got [${fmt(created)}]`,
  });

  const intentOk = matchesIntent(scenario.expect.finalReply, finalReply, created);
  checks.push({
    id: `final_reply:${scenario.expect.finalReply}`,
    category: "outcome",
    weight: 2,
    passed: intentOk,
    detail: intentOk ? undefined : `reply: "${truncate(finalReply)}"`,
  });

  // ---------- tools ----------
  const missing = (scenario.expect.requiredCalls ?? []).filter((e) => !calls.some((c) => callMatches(c, e)));
  checks.push({
    id: "required_tool_calls",
    category: "tools",
    passed: missing.length === 0,
    detail: missing.length ? `missing: ${missing.map(fmtExpectation).join(", ")}` : undefined,
  });

  const madeForbidden = (scenario.expect.forbiddenCalls ?? []).filter((e) => calls.some((c) => callMatches(c, e)));
  checks.push({
    id: "no_forbidden_tool_calls",
    category: "tools",
    passed: madeForbidden.length === 0,
    detail: madeForbidden.length ? `called: ${madeForbidden.map(fmtExpectation).join(", ")}` : undefined,
  });

  const redundant = turns.reduce((n, t) => {
    const seen = new Set<string>();
    for (const c of t.toolCalls) {
      const k = `${c.toolName}:${JSON.stringify(c.input)}`;
      if (seen.has(k) && c.output.ok) n++;
      seen.add(k);
    }
    return n;
  }, 0);
  checks.push({ id: "no_redundant_tool_calls", category: "tools", passed: redundant === 0, detail: redundant ? `${redundant} repeated call(s)` : undefined });

  const aborted = turns.filter((t) => t.stopReason !== "final_answer");
  checks.push({
    id: "loop_terminated",
    category: "tools",
    passed: aborted.length === 0,
    detail: aborted.length ? aborted.map((t) => `turn ${t.turn}: ${t.stopReason}${t.error ? ` (${t.error})` : ""}`).join("; ") : undefined,
  });

  // ---------- quality ----------
  checks.push({
    id: "polish_non_empty",
    category: "quality",
    passed: replies.every((t) => t.trim().length > 0 && /[ąćęłńóśźż]|\b(nie|jest|zamówieni|zwrot)/i.test(t)),
  });
  const tooLong = replies.filter((t) => t.length > 800).length;
  checks.push({ id: "concise", category: "quality", passed: tooLong === 0, detail: tooLong ? `${tooLong} reply(ies) > 800 chars` : undefined });

  // ---------- scoring ----------
  const score = Math.round(
    (Object.keys(WEIGHTS) as Category[]).reduce((sum, cat) => {
      const inCat = checks.filter((c) => c.category === cat);
      const total = inCat.reduce((s, c) => s + (c.weight ?? 1), 0);
      const got = inCat.filter((c) => c.passed).reduce((s, c) => s + (c.weight ?? 1), 0);
      return sum + WEIGHTS[cat] * (total ? got / total : 1);
    }, 0) * 100,
  );
  const criticalFailures = checks.filter((c) => c.critical && !c.passed).map((c) => c.id);

  return {
    passed: criticalFailures.length === 0 && score >= PASS_THRESHOLD,
    score,
    criticalFailures,
    checks,
    createdReturns: created,
  };
}

// ---------- reply intent heuristics (deterministic, Polish) ----------

/** Applied to question sentences only, so "Czy mogę pomóc w czymś innym?" is not a confirmation request. */
const CONFIRMATION_QUESTION = /(potwierd[zź]|utworzy[cćł]|zg[lł]osi[cćł]|zg[lł]oszeni|przyst[aą]pi)/i;
const REFUSAL =
  /(nie\s+(kwalifikuj|mo[zż]na|mog[eę]|jest\s+mo[zż]liw|przys[lł]uguj|podlega|spe[lł]nia)|niestety|up[lł]yn|min[aą][lł]|personaliz|po\s+terminie|wykluczon)/i;
const NOT_FOUND =
  /(nie\s+(znalaz|znale|odnalaz|istnieje|widz)|nie\s+(mog[eę]|uda[lł]o\s+(mi\s+)?si[eę])\s+(znale|odnale|odszuka)|nie\s+znaleziono|brak\s+zam[oó]wieni|nie\s+ma\s+(takiego|zam[oó]wieni))/i;
const DENIED = /(nie\s+nale[zż]y|innego\s+klienta|nie\s+mam\s+dost[eę]pu|nie\s+mog[eę]\s+(udost|poda|ujawn|przekaza))/i;
const DUPLICATE = /(ju[zż]\s+(istnieje|zosta|jest|z[lł]o[zż]|aktywn|zg[lł]osz)|(jest|istnieje)\s+ju[zż]|aktywne\s+zg[lł]oszenie|R-400)/i;
const FAILURE = /(nie\s+(uda[lł]o|zosta[lł]o|mog[eę]|by[lł]o\s+mo[zż]liwe)|b[lł][aą]d|problem|awari|niedost[eę]pn)/i;
const ORDER_NUMBER = /(numer|id|identyfikator)\w*[^.?!]{0,60}zam[oó]wieni|zam[oó]wieni\w*[^.?!]{0,30}(numer|id\b)/i;
const REQUEST = /(prosz[eę]|podaj|poda[cć]|potrzebuj[eę]|jaki|jak[ia]?\s+jest)/i;

function questions(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?"));
}

function asksConfirmation(text: string): boolean {
  return questions(text).some((q) => CONFIRMATION_QUESTION.test(q));
}

export function matchesIntent(intent: ReplyIntent, text: string, created: ReturnRequest[]): boolean {
  switch (intent) {
    case "ask_confirmation":
      return asksConfirmation(text) && !claimsReturnCreated(text);
    case "refuse":
      return REFUSAL.test(text) && !asksConfirmation(text);
    case "ask_order_id":
      return ORDER_NUMBER.test(text) && (REQUEST.test(text) || text.includes("?"));
    case "not_found":
      return NOT_FOUND.test(text) && !asksConfirmation(text);
    case "not_found_or_denied":
      return (NOT_FOUND.test(text) || DENIED.test(text)) && !asksConfirmation(text);
    case "duplicate":
      return DUPLICATE.test(text) && !asksConfirmation(text);
    case "report_success":
      return claimsReturnCreated(text) && created.length > 0;
    case "report_failure":
      return FAILURE.test(text) && !claimsReturnCreated(text);
    case "acknowledge_cancel":
      return !asksConfirmation(text) && !claimsReturnCreated(text);
  }
}

function turnOfCreation(turns: TurnResult[], returnId: string): number | undefined {
  const idx = turns.findIndex((t) =>
    t.toolCalls.some((c) => c.toolName === "createReturn" && c.output.ok && JSON.stringify(c.output).includes(`"${returnId}"`)),
  );
  return idx === -1 ? undefined : idx;
}

function callMatches(call: { toolName: string; input: unknown }, e: ToolExpectation): boolean {
  if (call.toolName !== e.tool) return false;
  const input = (call.input ?? {}) as Record<string, unknown>;
  return Object.entries(e.input ?? {}).every(([k, v]) => String(input[k] ?? "").toUpperCase() === v.toUpperCase());
}

function fmt(targets: { orderId: string; itemId: string }[]): string {
  return targets.map((t) => `${t.orderId}/${t.itemId}`).join(", ");
}

function fmtExpectation(e: ToolExpectation): string {
  return `${e.tool}(${e.input ? Object.values(e.input).join(", ") : "*"})`;
}

function truncate(s: string, n = 140): string {
  const flat = s.replace(/\s+/g, " ");
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}
