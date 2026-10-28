import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { getTemperature } from "../config.js";
import type { ShopDb } from "../store/db.js";
import { span } from "../telemetry.js";
import { claimsReturnCreated, classifyConfirmation, extractReturnIds } from "./intent.js";
import { buildSystemPrompt } from "./prompt.js";
import { SessionState } from "./state.js";
import { ToolExecutor, toolDefinitions, type SessionContext, type ToolCallRecord, type ToolContext } from "./tools.js";
import type { HarnessConfig } from "./versions.js";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface TurnResult {
  turn: number;
  userText: string;
  text: string;
  /** Model text before the harness rewrote it (output verification / loop limit). */
  originalText?: string;
  toolCalls: ToolCallRecord[];
  llmCalls: number;
  usage: Usage;
  latencyMs: number;
  stopReason: "final_answer" | "max_steps" | "llm_error";
  error?: string;
}

export interface AgentOptions {
  model: LanguageModel;
  modelId: string;
  db: ShopDb;
  session: SessionContext;
  config: HarnessConfig;
  retryDelayMs?: number;
}

const MAX_STEPS_REPLY =
  "Przepraszam, nie udało mi się dokończyć obsługi tej prośby. Żadne nowe zgłoszenie nie zostało utworzone. Spróbuj proszę ponownie lub skontaktuj się z konsultantem.";

const UNVERIFIED_SUCCESS_REPLY =
  "Przepraszam, nie mogę potwierdzić utworzenia zgłoszenia zwrotu — system nie potwierdził tej operacji, więc zgłoszenie NIE zostało utworzone. Spróbuj proszę ponownie za chwilę.";

/**
 * Hand-rolled agentic loop. Each step is a single LLM call; tool calls are
 * executed by the harness (guardrails, retries, state) and fed back until the
 * model answers in plain text or the step budget runs out.
 */
export class SupportAgent {
  readonly messages: ModelMessage[] = [];
  readonly turns: TurnResult[] = [];
  readonly state: SessionState | null;
  private readonly tools: ToolExecutor;

  constructor(private readonly opts: AgentOptions) {
    this.state = opts.config.sessionState ? new SessionState() : null;
    this.tools = new ToolExecutor(opts.db, opts.config, opts.session, this.state, opts.retryDelayMs);
  }

  send(userText: string): Promise<TurnResult> {
    const turn = this.turns.length + 1;
    const { config, session } = this.opts;
    return span(
      {
        name: "agent.turn",
        input: userText,
        sessionId: session.sessionId,
        userId: session.userId,
        metadata: { harness: config.name, model: this.opts.modelId, turn },
      },
      () => this.runTurn(turn, userText),
    );
  }

  private async runTurn(turn: number, userText: string): Promise<TurnResult> {
    const { config, model, db, session } = this.opts;
    const started = Date.now();
    const result: TurnResult = {
      turn,
      userText,
      text: "",
      toolCalls: [],
      llmCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      stopReason: "max_steps",
    };

    this.state?.onUserMessage(userText);
    const ctx: ToolContext = { turn, step: 0, lastUserIntent: classifyConfirmation(userText), checkedTargets: [], fetchedTargets: [] };
    this.messages.push({ role: "user", content: userText });

    try {
      for (let step = 1; step <= config.maxSteps; step++) {
        ctx.step = step;
        const response = await generateText({
          model,
          system: buildSystemPrompt(session, db.now, this.state?.describe()),
          messages: this.messages,
          tools: toolDefinitions,
          stopWhen: stepCountIs(1),
          temperature: getTemperature(),
          maxRetries: 2,
          telemetry: { functionId: `returns-agent.${config.name}` },
        });
        result.llmCalls++;
        result.usage.inputTokens += response.usage.inputTokens ?? 0;
        result.usage.outputTokens += response.usage.outputTokens ?? 0;
        this.messages.push(...response.responseMessages);

        if (response.toolCalls.length === 0) {
          result.text = response.text;
          result.stopReason = "final_answer";
          break;
        }

        const toolResults = [];
        for (const call of response.toolCalls) {
          const record = await this.tools.execute(call.toolName, call.input, ctx);
          result.toolCalls.push(record);
          toolResults.push({
            type: "tool-result" as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: "json" as const, value: record.output as never },
          });
        }
        this.messages.push({ role: "tool", content: toolResults });
      }
    } catch (err) {
      result.stopReason = "llm_error";
      result.error = err instanceof Error ? err.message : String(err);
    }

    if (result.stopReason !== "final_answer") {
      result.originalText = result.text;
      result.text = MAX_STEPS_REPLY;
      this.messages.push({ role: "assistant", content: result.text });
    } else if (config.verifyOutput) {
      this.verifyFinalAnswer(result);
    }

    this.state?.onTurnEnd({ checked: ctx.checkedTargets, fetched: ctx.fetchedTargets, texts: [userText, result.text] });
    result.latencyMs = Date.now() - started;
    this.turns.push(result);
    return result;
  }

  /**
   * Operation verification: the answer may only claim a created return (or cite
   * a return id) if a createReturn call in this session actually produced it.
   */
  private verifyFinalAnswer(result: TurnResult): void {
    const confirmedIds = new Set(
      this.turns
        .concat(result)
        .flatMap((t) => t.toolCalls)
        .flatMap((c) => (c.toolName === "createReturn" && c.output.ok ? [(c.output.returnRequest as { id: string }).id] : [])),
    );
    const knownIds = new Set([...confirmedIds, ...this.opts.db.returns.filter((r) => r.customerId === this.opts.session.userId).map((r) => r.id)]);
    const unknownIdCited = extractReturnIds(result.text).some((id) => !knownIds.has(id));

    if ((claimsReturnCreated(result.text) && confirmedIds.size === 0) || unknownIdCited) {
      result.originalText = result.text;
      result.text = UNVERIFIED_SUCCESS_REPLY;
      const last = this.messages.at(-1);
      if (last?.role === "assistant") last.content = result.text;
    }
  }
}
