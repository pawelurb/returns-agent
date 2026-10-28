import { buildSeed, DEFAULT_NOW } from "./seed.js";
import type { Order, ReturnRequest } from "./types.js";

export type ToolName = "getOrder" | "getReturnPolicy" | "checkExistingReturn" | "createReturn";

/** Injected failure: the next `times` calls of `tool` throw a server error (Infinity = always). */
export interface FaultSpec {
  tool: ToolName;
  times: number;
  status?: number;
}

export class ServerError extends Error {
  constructor(public readonly status: number, message = `Upstream service returned HTTP ${status}`) {
    super(message);
    this.name = "ServerError";
  }
}

/**
 * In-memory shop database. Every eval run gets its own instance built from the
 * same seed, so scenarios are isolated and reproducible.
 */
export class ShopDb {
  readonly orders = new Map<string, Order>();
  readonly returns: ReturnRequest[] = [];
  private nextReturnSeq = 501;
  private readonly faults: FaultSpec[];

  constructor(readonly now: Date = DEFAULT_NOW, faults: FaultSpec[] = []) {
    const seed = structuredClone(buildSeed(now));
    for (const order of seed.orders) this.orders.set(order.id, order);
    this.returns.push(...seed.returns);
    this.faults = faults.map((f) => ({ ...f }));
  }

  /** Throws a ServerError if a fault is armed for this tool. */
  maybeFail(tool: ToolName): void {
    const fault = this.faults.find((f) => f.tool === tool && f.times > 0);
    if (!fault) return;
    fault.times -= 1;
    throw new ServerError(fault.status ?? 500);
  }

  nextReturnId(): string {
    return `R-${this.nextReturnSeq++}`;
  }

  snapshotReturns(): ReturnRequest[] {
    return structuredClone(this.returns);
  }
}
