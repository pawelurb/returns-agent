import type { ShopDb } from "../store/db.js";
import type { Order, ReturnPolicy, ReturnRequest } from "../store/types.js";
import { RETURN_POLICY } from "./policy.js";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Simulated shop backend. Like a typical internal API it trusts its caller:
 * it does NOT check ownership or business rules. Those are the harness's job.
 */
export class ShopApi {
  constructor(private readonly db: ShopDb) {}

  async getOrder(orderId: string): Promise<Order> {
    this.db.maybeFail("getOrder");
    const order = this.db.orders.get(orderId.trim().toUpperCase());
    if (!order) throw new NotFoundError(`Order ${orderId} not found`);
    return structuredClone(order);
  }

  async getReturnPolicy(): Promise<ReturnPolicy> {
    this.db.maybeFail("getReturnPolicy");
    return structuredClone(RETURN_POLICY);
  }

  async listReturns(orderId: string, itemId?: string): Promise<ReturnRequest[]> {
    this.db.maybeFail("checkExistingReturn");
    const id = orderId.trim().toUpperCase();
    return structuredClone(
      this.db.returns.filter((r) => r.orderId === id && (itemId === undefined || r.itemId === itemId)),
    );
  }

  async createReturn(input: {
    orderId: string;
    itemId: string;
    customerId: string;
    idempotencyKey?: string;
  }): Promise<ReturnRequest> {
    const orderId = input.orderId.trim().toUpperCase();
    if (input.idempotencyKey) {
      const existing = this.db.returns.find((r) => r.idempotencyKey === input.idempotencyKey);
      if (existing) return structuredClone(existing);
    }
    this.db.maybeFail("createReturn");
    const order = this.db.orders.get(orderId);
    if (!order) throw new NotFoundError(`Order ${input.orderId} not found`);
    if (!order.items.some((i) => i.id === input.itemId)) {
      throw new NotFoundError(`Item ${input.itemId} not found in order ${orderId}`);
    }
    const created: ReturnRequest = {
      id: this.db.nextReturnId(),
      orderId,
      itemId: input.itemId,
      customerId: input.customerId,
      status: "requested",
      createdAt: this.db.now.toISOString(),
      idempotencyKey: input.idempotencyKey,
    };
    this.db.returns.push(created);
    return structuredClone(created);
  }
}
