import { classifyConfirmation, extractOrderIds, type ConfirmationIntent } from "./intent.js";

export interface ReturnTarget {
  orderId: string;
  itemId: string;
}

export interface VerifiedItem extends ReturnTarget {
  itemName: string;
  eligible: boolean;
  reasons: string[];
  hasActiveReturn: boolean | null;
}

/**
 * Conversation state owned by the harness (not by the model). A confirmation is
 * only valid when it answers a proposal for one exact (orderId, itemId).
 */
export class SessionState {
  currentOrderId: string | null = null;
  readonly verified = new Map<string, VerifiedItem>();
  /** Set at the end of an agent turn that established an eligible return target. */
  pendingProposal: ReturnTarget | null = null;
  /** Set when the user's next message accepts the pending proposal; consumed by createReturn. */
  confirmed: ReturnTarget | null = null;
  readonly createdReturnIds: string[] = [];
  lastUserIntent: ConfirmationIntent = "unclear";

  onUserMessage(text: string): void {
    const mentioned = extractOrderIds(text);
    const switchedOrder = mentioned.length > 0 && mentioned.at(-1) !== this.currentOrderId;
    if (mentioned.length > 0) this.currentOrderId = mentioned.at(-1)!;

    this.lastUserIntent = classifyConfirmation(text);
    // A "yes" that also names a different order is not an answer to the old proposal.
    if (this.lastUserIntent === "yes" && this.pendingProposal && !switchedOrder) {
      this.confirmed = this.pendingProposal;
    } else {
      this.confirmed = null;
    }
    if (this.lastUserIntent === "no" || switchedOrder) this.pendingProposal = null;
  }

  recordVerified(item: VerifiedItem): void {
    this.verified.set(key(item), item);
    this.currentOrderId = item.orderId;
  }

  markActiveReturn(target: ReturnTarget, hasActive: boolean): void {
    const v = this.verified.get(key(target));
    if (v) {
      v.hasActiveReturn = hasActive;
      if (hasActive && !v.reasons.includes("ACTIVE_RETURN_EXISTS")) v.reasons.push("ACTIVE_RETURN_EXISTS");
      v.eligible = v.eligible && !hasActive;
    }
  }

  /**
   * Called after each agent turn. The proposal is the eligible item the agent
   * checked for duplicates last; if it skipped that check, the eligible item of
   * the fetched order that the conversation is about (by name, see pickByName).
   */
  onTurnEnd(turn: { checked: ReturnTarget[]; fetched: ReturnTarget[]; texts: string[] }): void {
    const eligible = (targets: ReturnTarget[]) =>
      targets
        .map((t) => this.verified.get(key(t)))
        .filter((v): v is VerifiedItem => !!v && v.eligible && v.hasActiveReturn === false);

    const lastFetchedOrder = turn.fetched.at(-1)?.orderId;
    const fetched = eligible(turn.fetched.filter((t) => t.orderId === lastFetchedOrder));
    const pick = eligible(turn.checked).at(-1) ?? (fetched.length === 1 ? fetched[0] : pickByName(fetched, turn.texts));
    if (pick) this.pendingProposal = { orderId: pick.orderId, itemId: pick.itemId };
  }

  onReturnCreated(returnId: string): void {
    this.createdReturnIds.push(returnId);
    if (this.confirmed) this.markActiveReturn(this.confirmed, true);
    this.confirmed = null;
    this.pendingProposal = null;
  }

  isConfirmed(target: ReturnTarget): boolean {
    return !!this.confirmed && sameTarget(this.confirmed, target);
  }

  /** Compact state summary injected into the system prompt each step. */
  describe(): string {
    const lines = [
      `- Bieżące zamówienie w rozmowie: ${this.currentOrderId ?? "brak (zapytaj klienta o numer zamówienia)"}`,
    ];
    for (const v of this.verified.values()) {
      const status = v.eligible ? "kwalifikuje się" : `NIE kwalifikuje się (${v.reasons.join(", ")})`;
      const dup = v.hasActiveReturn === null ? "duplikaty niesprawdzone" : v.hasActiveReturn ? "ma aktywny zwrot" : "brak aktywnego zwrotu";
      lines.push(`- Zweryfikowano ${v.orderId}/${v.itemId} (${v.itemName}): ${status}; ${dup}`);
    }
    lines.push(
      `- Oczekująca propozycja zwrotu: ${this.pendingProposal ? fmt(this.pendingProposal) : "brak"}`,
      `- Potwierdzenie klienta dla: ${this.confirmed ? fmt(this.confirmed) : "brak — NIE wywołuj createReturn"}`,
    );
    if (this.createdReturnIds.length) lines.push(`- Utworzone w tej rozmowie zgłoszenia: ${this.createdReturnIds.join(", ")}`);
    return lines.join("\n");
  }
}

/**
 * Picks the item whose name the texts mention best. Words are compared by a
 * 5-letter stem (Polish inflection: "słuchawki" / "słuchawek"); the first word
 * of a name (its head noun) counts double. A tie means ambiguity → no pick.
 */
function pickByName(items: VerifiedItem[], texts: string[]): VerifiedItem | undefined {
  const stems = new Set(texts.flatMap(words).map(stem));
  const scored = items
    .map((item) => ({
      item,
      score: words(item.itemName).reduce((s, w, i) => s + (stems.has(stem(w)) ? (i === 0 ? 2 : 1) : 0), 0),
    }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  return best && best.score > 0 && best.score !== second?.score ? best.item : undefined;
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\d]{3,}/gu) ?? [];
}

function stem(word: string): string {
  return word.slice(0, 5);
}

function key(t: ReturnTarget): string {
  return `${t.orderId}/${t.itemId}`;
}

function fmt(t: ReturnTarget): string {
  return `${t.orderId}, ${t.itemId}`;
}

export function sameTarget(a: ReturnTarget, b: ReturnTarget): boolean {
  return a.orderId.toUpperCase() === b.orderId.toUpperCase() && a.itemId === b.itemId;
}
