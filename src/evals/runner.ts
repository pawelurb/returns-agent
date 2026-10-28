import type { LanguageModel } from "ai";
import { SupportAgent, type TurnResult } from "../harness/agent.js";
import type { HarnessConfig } from "../harness/versions.js";
import { ShopDb } from "../store/db.js";
import { DEFAULT_NOW, DEFAULT_USER_ID } from "../store/seed.js";
import { span } from "../telemetry.js";
import { grade, type Grade } from "./graders.js";
import type { Scenario } from "./scenarios.js";

export interface RunResult {
  scenarioId: string;
  harness: string;
  model: string;
  run: number;
  sessionId: string;
  grade: Grade;
  turns: TurnResult[];
  metrics: {
    llmCalls: number;
    toolCalls: number;
    blockedToolCalls: number;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  };
}

/** Runs one scenario on a fresh, isolated database and grades the result. */
export async function runScenario(args: {
  scenario: Scenario;
  config: HarnessConfig;
  model: LanguageModel;
  modelId: string;
  run: number;
  runTag: string;
}): Promise<RunResult> {
  const { scenario, config, model, modelId, run, runTag } = args;
  const sessionId = `${runTag}-${config.name}-${scenario.id}-r${run}`;
  const db = new ShopDb(DEFAULT_NOW, scenario.faults);
  const agent = new SupportAgent({
    model,
    modelId,
    db,
    session: { userId: DEFAULT_USER_ID, sessionId },
    config,
    retryDelayMs: 20,
  });

  return span(
    {
      name: `eval.${scenario.id}`,
      sessionId,
      userId: DEFAULT_USER_ID,
      input: scenario.turns.map((t) => t.user),
      metadata: { scenario: scenario.id, harness: config.name, model: modelId, run },
      tags: ["eval", config.name, scenario.id],
    },
    async () => {
      for (const turn of scenario.turns) await agent.send(turn.user);
      const result = grade(scenario, agent.turns, db, DEFAULT_USER_ID);
      const calls = agent.turns.flatMap((t) => t.toolCalls);
      return {
        scenarioId: scenario.id,
        harness: config.name,
        model: modelId,
        run,
        sessionId,
        grade: result,
        turns: agent.turns,
        metrics: {
          llmCalls: sum(agent.turns, (t) => t.llmCalls),
          toolCalls: calls.length,
          blockedToolCalls: calls.filter((c) => c.blockedBy).length,
          inputTokens: sum(agent.turns, (t) => t.usage.inputTokens),
          outputTokens: sum(agent.turns, (t) => t.usage.outputTokens),
          latencyMs: sum(agent.turns, (t) => t.latencyMs),
        },
      };
    },
  );
}

function sum<T>(xs: T[], f: (x: T) => number): number {
  return xs.reduce((s, x) => s + f(x), 0);
}
