import { tool } from "ai";
import { z } from "zod";
import { NotFoundError, ShopApi } from "../shop/api.js";
import { evaluateEligibility, isActiveReturn } from "../shop/policy.js";
import { ServerError, type ShopDb, type ToolName } from "../store/db.js";
import { span } from "../telemetry.js";
import type { SessionState, ReturnTarget } from "./state.js";
import type { HarnessConfig } from "./versions.js";
import type { ConfirmationIntent } from "./intent.js";

/** Trusted identity from the application session — never parsed from chat text. */
export interface SessionContext {
  userId: string;
  sessionId: string;
}

const orderIdSchema = z.string().describe("Numer zamówienia, np. Z-1042");
const itemIdSchema = z.string().describe("Identyfikator pozycji w zamówieniu, np. item-1");

const inputSchemas = {
  getOrder: z.object({ orderId: orderIdSchema }),
  getReturnPolicy: z.object({}),
  checkExistingReturn: z.object({ orderId: orderIdSchema, itemId: itemIdSchema }),
  createReturn: z.object({ orderId: orderIdSchema, itemId: itemIdSchema }),
} satisfies Record<ToolName, z.ZodType>;

/**
 * Tool definitions WITHOUT `execute`: the AI SDK only returns the model's tool
 * calls, and the harness executes them itself (see SupportAgent).
 */
export const toolDefinitions = {
  getOrder: tool({
    description: "Zwraca zamówienie (pozycje, status, datę doręczenia).",
    inputSchema: inputSchemas.getOrder,
  }),
  getReturnPolicy: tool({
    description: "Zwraca aktualną politykę zwrotów sklepu.",
    inputSchema: inputSchemas.getReturnPolicy,
  }),
  checkExistingReturn: tool({
    description: "Sprawdza istniejące zgłoszenia zwrotu dla pozycji zamówienia.",
    inputSchema: inputSchemas.checkExistingReturn,
  }),
  createReturn: tool({
    description: "Tworzy zgłoszenie zwrotu. Wywołuj wyłącznie po wyraźnym potwierdzeniu klienta.",
    inputSchema: inputSchemas.createReturn,
  }),
};

export type ToolOutput = { ok: true; [key: string]: unknown } | { ok: false; error: ToolError };

export interface ToolError {
  code:
    | "ORDER_NOT_FOUND"
    | "ITEM_NOT_FOUND"
    | "RETURN_NOT_ALLOWED"
    | "CONFIRMATION_REQUIRED"
    | "SERVER_ERROR"
    | "INVALID_INPUT"
    | "UNKNOWN_TOOL";
  message: string;
  reasons?: string[];
}

export interface ToolCallRecord {
  turn: number;
  step: number;
  toolName: string;
  input: unknown;
  output: ToolOutput;
  /** Set when a harness guardrail (not the backend) rejected the call. */
  blockedBy?: "authorization" | "policy" | "confirmation";
  attempts: number;
  durationMs: number;
}

export interface ToolContext {
  turn: number;
  step: number;
  lastUserIntent: ConfirmationIntent;
  /** (orderId, itemId) pairs checked for duplicates in the current turn. */
  checkedTargets: ReturnTarget[];
  /** Items of orders fetched (and authorized) in the current turn. */
  fetchedTargets: ReturnTarget[];
}

export class ToolExecutor {
  private readonly api: ShopApi;

  constructor(
    private readonly db: ShopDb,
    private readonly config: HarnessConfig,
    private readonly session: SessionContext,
    private readonly state: SessionState | null,
    private readonly retryDelayMs = 200,
  ) {
    this.api = new ShopApi(db);
  }

  async execute(toolName: string, rawInput: unknown, ctx: ToolContext): Promise<ToolCallRecord> {
    const started = Date.now();
    const record: ToolCallRecord = {
      turn: ctx.turn,
      step: ctx.step,
      toolName,
      input: rawInput,
      output: { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown tool ${toolName}` } },
      attempts: 0,
      durationMs: 0,
    };

    await span(
      { name: `tool.${toolName}`, spanType: "TOOL", input: rawInput, metadata: { harness: this.config.name, turn: ctx.turn } },
      async () => {
        if (!(toolName in inputSchemas)) return record.output;
        const parsed = inputSchemas[toolName as ToolName].safeParse(rawInput ?? {});
        if (!parsed.success) {
          record.output = fail("INVALID_INPUT", parsed.error.message);
          return record.output;
        }
        const input = parsed.data as Record<string, string>;
        switch (toolName as ToolName) {
          case "getOrder":
            record.output = await this.getOrder(input.orderId!, record, ctx);
            break;
          case "getReturnPolicy":
            record.output = await this.withRetries(record, async () => ({ ok: true, policy: await this.api.getReturnPolicy() }));
            break;
          case "checkExistingReturn":
            record.output = await this.checkExistingReturn(input.orderId!, input.itemId!, record, ctx);
            break;
          case "createReturn":
            record.output = await this.createReturn(input.orderId!, input.itemId!, record, ctx);
            break;
        }
        return record.output;
      },
    );

    record.durationMs = Date.now() - started;
    return record;
  }

  private async getOrder(orderId: string, record: ToolCallRecord, ctx: ToolContext): Promise<ToolOutput> {
    return this.withRetries(record, async () => {
      const order = await this.api.getOrder(orderId);
      if (this.config.authorizeReads && order.customerId !== this.session.userId) {
        // Same answer as a missing order: don't even confirm that it exists.
        record.blockedBy = "authorization";
        return notFound(orderId);
      }
      if (!this.config.enrichOrder && !this.state) return { ok: true, order };

      const items = order.items.map((item) => {
        // The harness checks duplicates itself, so a skipped checkExistingReturn can't leave a gap.
        const verdict = evaluateEligibility({ order, itemId: item.id, userId: this.session.userId, returns: this.db.returns, now: this.db.now });
        this.state?.recordVerified({
          orderId: order.id,
          itemId: item.id,
          itemName: item.name,
          eligible: verdict.eligible,
          reasons: verdict.reasons,
          hasActiveReturn: verdict.reasons.includes("ACTIVE_RETURN_EXISTS"),
        });
        ctx.fetchedTargets.push({ orderId: order.id, itemId: item.id });
        return this.config.enrichOrder ? { ...item, returnEligibility: verdict } : item;
      });
      return { ok: true, order: { ...order, items } };
    });
  }

  private async checkExistingReturn(orderId: string, itemId: string, record: ToolCallRecord, ctx: ToolContext): Promise<ToolOutput> {
    if (this.config.authorizeReads && !this.ownsOrder(orderId)) {
      record.blockedBy = "authorization";
      return notFound(orderId);
    }
    return this.withRetries(record, async () => {
      const returns = await this.api.listReturns(orderId, itemId);
      const hasActiveReturn = returns.some(isActiveReturn);
      const target = { orderId: orderId.toUpperCase(), itemId };
      ctx.checkedTargets.push(target);
      if (this.state) {
        if (!this.state.verified.has(`${target.orderId}/${itemId}`)) this.verifySilently(target);
        this.state.markActiveReturn(target, hasActiveReturn);
      }
      return {
        ok: true,
        hasActiveReturn,
        returns: returns.map(({ id, status, createdAt }) => ({ id, status, createdAt })),
      };
    });
  }

  private async createReturn(orderId: string, itemId: string, record: ToolCallRecord, ctx: ToolContext): Promise<ToolOutput> {
    const target = { orderId: orderId.toUpperCase(), itemId };

    if (this.config.guardCreateReturn) {
      const order = this.db.orders.get(target.orderId);
      const verdict = evaluateEligibility({ order, itemId, userId: this.session.userId, returns: this.db.returns, now: this.db.now });
      if (!verdict.eligible) {
        const authz = verdict.reasons.includes("NOT_OWNER") || verdict.reasons.includes("ORDER_NOT_FOUND");
        record.blockedBy = authz ? "authorization" : "policy";
        if (authz) return notFound(orderId);
        return {
          ok: false,
          error: { code: "RETURN_NOT_ALLOWED", message: "Zwrot niedozwolony przez politykę sklepu. Zgłoszenie NIE zostało utworzone.", reasons: verdict.reasons },
        };
      }
    }

    const confirmed =
      this.config.confirmation === "prompt" ||
      (this.config.confirmation === "lastMessage" && ctx.lastUserIntent === "yes") ||
      (this.config.confirmation === "boundProposal" && !!this.state?.isConfirmed(target));
    if (!confirmed) {
      record.blockedBy = "confirmation";
      const pending = this.state?.pendingProposal;
      return {
        ok: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message:
            "Brak wyraźnego potwierdzenia klienta dla tego zwrotu. Zgłoszenie NIE zostało utworzone. " +
            (pending && this.config.confirmation === "boundProposal"
              ? `Oczekująca propozycja dotyczy ${pending.orderId}/${pending.itemId} — zapytaj klienta o potwierdzenie.`
              : "Podsumuj zwrot i zapytaj klienta o potwierdzenie."),
        },
      };
    }

    return this.withRetries(record, async () => {
      const created = await this.api.createReturn({
        ...target,
        customerId: this.session.userId,
        // Makes retries safe: a repeated attempt can never create a second request.
        idempotencyKey: this.config.toolRetries > 0 ? `${this.session.sessionId}:${target.orderId}:${itemId}:t${ctx.turn}` : undefined,
      });
      this.state?.onReturnCreated(created.id);
      return { ok: true, returnRequest: { id: created.id, orderId: created.orderId, itemId: created.itemId, status: created.status } };
    });
  }

  private ownsOrder(orderId: string): boolean {
    return this.db.orders.get(orderId.trim().toUpperCase())?.customerId === this.session.userId;
  }

  private verifySilently(target: ReturnTarget): void {
    const order = this.db.orders.get(target.orderId);
    const item = order?.items.find((i) => i.id === target.itemId);
    if (!order || !item) return;
    const verdict = evaluateEligibility({ order, itemId: item.id, userId: this.session.userId, returns: [], now: this.db.now });
    this.state?.recordVerified({ ...target, itemName: item.name, eligible: verdict.eligible, reasons: verdict.reasons, hasActiveReturn: null });
  }

  private async withRetries(record: ToolCallRecord, fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
    for (let attempt = 0; ; attempt++) {
      record.attempts = attempt + 1;
      try {
        return await fn();
      } catch (err) {
        if (err instanceof NotFoundError) {
          return fail(err.message.startsWith("Item") ? "ITEM_NOT_FOUND" : "ORDER_NOT_FOUND", err.message);
        }
        if (err instanceof ServerError) {
          if (attempt < this.config.toolRetries) {
            await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
            continue;
          }
          return fail("SERVER_ERROR", `${err.message}. Operacja nie została wykonana.`);
        }
        throw err;
      }
    }
  }
}

function fail(code: ToolError["code"], message: string): ToolOutput {
  return { ok: false, error: { code, message } };
}

function notFound(orderId: string): ToolOutput {
  return fail("ORDER_NOT_FOUND", `Nie znaleziono zamówienia ${orderId} na koncie zalogowanego klienta.`);
}
