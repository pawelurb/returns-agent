import { ACTIVE_RETURN_STATUSES, type Order, type ReturnPolicy, type ReturnRequest } from "../store/types.js";

export const RETURN_POLICY: ReturnPolicy = {
  version: "2026-01",
  windowDays: 14,
  windowStartsAt: "delivery",
  windowInclusive: true,
  personalizedItemsReturnable: false,
  requiresDelivered: true,
  oneActiveReturnPerItem: true,
  rules: [
    "Zwrot jest możliwy do 14 dni od doręczenia (włącznie z 14. dniem).",
    "Produkty personalizowane (grawer, nadruk, inicjały itp.) nie podlegają zwrotowi.",
    "Zwrot można zgłosić tylko dla zamówienia należącego do zalogowanego klienta.",
    "Zamówienie musi mieć status 'delivered' (doręczone).",
    "Dla jednego produktu z zamówienia może istnieć tylko jedno aktywne zgłoszenie zwrotu.",
  ],
};

export type IneligibilityReason =
  | "ORDER_NOT_FOUND"
  | "NOT_OWNER"
  | "ITEM_NOT_FOUND"
  | "NOT_DELIVERED"
  | "WINDOW_EXPIRED"
  | "PERSONALIZED"
  | "ACTIVE_RETURN_EXISTS";

export interface Eligibility {
  eligible: boolean;
  reasons: IneligibilityReason[];
  daysSinceDelivery: number | null;
}

/** Whole calendar days (UTC) between delivery and `now`. */
export function daysSinceDelivery(deliveredAt: string, now: Date): number {
  const d = new Date(deliveredAt);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((end - start) / 86_400_000);
}

export function isActiveReturn(r: ReturnRequest): boolean {
  return ACTIVE_RETURN_STATUSES.includes(r.status);
}

/**
 * Single source of truth for the business rules. Used by the V2/V3 guardrails
 * and by the eval graders (against the seed state) — never by the model.
 */
export function evaluateEligibility(args: {
  order: Order | undefined;
  itemId: string;
  userId: string;
  returns: ReturnRequest[];
  now: Date;
  policy?: ReturnPolicy;
}): Eligibility {
  const { order, itemId, userId, returns, now, policy = RETURN_POLICY } = args;
  if (!order) return { eligible: false, reasons: ["ORDER_NOT_FOUND"], daysSinceDelivery: null };
  if (order.customerId !== userId) return { eligible: false, reasons: ["NOT_OWNER"], daysSinceDelivery: null };

  const reasons: IneligibilityReason[] = [];
  const item = order.items.find((i) => i.id === itemId);
  if (!item) reasons.push("ITEM_NOT_FOUND");

  let days: number | null = null;
  if (policy.requiresDelivered && (order.status !== "delivered" || !order.deliveredAt)) {
    reasons.push("NOT_DELIVERED");
  } else if (order.deliveredAt) {
    days = daysSinceDelivery(order.deliveredAt, now);
    const withinWindow = policy.windowInclusive ? days <= policy.windowDays : days < policy.windowDays;
    if (!withinWindow) reasons.push("WINDOW_EXPIRED");
  }

  if (item?.personalized && !policy.personalizedItemsReturnable) reasons.push("PERSONALIZED");

  if (
    policy.oneActiveReturnPerItem &&
    returns.some((r) => r.orderId === order.id && r.itemId === itemId && isActiveReturn(r))
  ) {
    reasons.push("ACTIVE_RETURN_EXISTS");
  }

  return { eligible: reasons.length === 0, reasons, daysSinceDelivery: days };
}
