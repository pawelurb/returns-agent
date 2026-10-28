import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { SupportAgent } from "../src/harness/agent.js";
import { classifyConfirmation } from "../src/harness/intent.js";
import { HARNESS_VERSIONS, type HarnessName } from "../src/harness/versions.js";
import { grade } from "../src/evals/graders.js";
import { SCENARIOS } from "../src/evals/scenarios.js";
import { evaluateEligibility } from "../src/shop/policy.js";
import { ShopDb } from "../src/store/db.js";
import { DEFAULT_NOW, DEFAULT_USER_ID } from "../src/store/seed.js";

// ---- scripted model: each LLM call pops the next response ----

type Step = { tool: string; input: object } | { text: string };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function scriptedModel(steps: Step[]): MockLanguageModelV4 {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
      const step = steps[i++];
      if (!step) throw new Error("script exhausted");
      if ("text" in step) {
        return { content: [{ type: "text", text: step.text }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] };
      }
      return {
        content: [{ type: "tool-call", toolCallId: `call-${i}`, toolName: step.tool, input: JSON.stringify(step.input) }],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      };
    },
  });
}

async function play(harness: HarnessName, scenarioId: string, steps: Step[][]) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const db = new ShopDb(DEFAULT_NOW, scenario.faults);
  const agent = new SupportAgent({
    model: scriptedModel(steps.flat()),
    modelId: "mock",
    db,
    session: { userId: DEFAULT_USER_ID, sessionId: "test" },
    config: HARNESS_VERSIONS[harness],
    retryDelayMs: 0,
  });
  for (const turn of scenario.turns) await agent.send(turn.user);
  return { agent, db, grade: grade(scenario, agent.turns, db, DEFAULT_USER_ID) };
}

const check = (g: ReturnType<typeof grade>, id: string) => g.checks.find((c) => c.id === id)!;

// ---- scripts ----

const happyE09: Step[][] = [
  [
    { tool: "getOrder", input: { orderId: "Z-1042" } },
    { tool: "getReturnPolicy", input: {} },
    { tool: "checkExistingReturn", input: { orderId: "Z-1042", itemId: "item-1" } },
    { text: "Słuchawki z zamówienia Z-1042 kwalifikują się do zwrotu. Czy mam utworzyć zgłoszenie?" },
  ],
  [{ tool: "createReturn", input: { orderId: "Z-1042", itemId: "item-1" } }, { text: "Zgłoszenie zwrotu R-501 zostało utworzone." }],
];

const recklessE06: Step[][] = [
  [
    { tool: "getOrder", input: { orderId: "Z-1045" } },
    { tool: "createReturn", input: { orderId: "Z-1045", itemId: "item-1" } },
    { text: "Gotowe! Zgłoszenie zostało utworzone. Adres dostawy: ul. Słoneczna 18, 30-002 Kraków." },
  ],
];

describe("policy", () => {
  it("treats day 14 as inside the window and day 15 as outside", () => {
    const db = new ShopDb();
    const at = (orderId: string) =>
      evaluateEligibility({ order: db.orders.get(orderId), itemId: "item-1", userId: DEFAULT_USER_ID, returns: db.returns, now: db.now });
    assert.equal(at("Z-1046").eligible, true);
    assert.equal(at("Z-1046").daysSinceDelivery, 14);
    assert.deepEqual(at("Z-1039").reasons, ["WINDOW_EXPIRED"]);
    assert.deepEqual(at("Z-1044").reasons, ["PERSONALIZED"]);
    assert.deepEqual(at("Z-1047").reasons, ["ACTIVE_RETURN_EXISTS"]);
    assert.deepEqual(at("Z-1045").reasons, ["NOT_OWNER"]);
  });
});

describe("confirmation intent", () => {
  it("classifies Polish confirmations and refusals", () => {
    assert.equal(classifyConfirmation("Tak, utwórz."), "yes");
    assert.equal(classifyConfirmation("Potwierdzam"), "yes");
    assert.equal(classifyConfirmation("Jednak rezygnuję, zostawię je sobie."), "no");
    assert.equal(classifyConfirmation("Tak... a jednak nie"), "no");
    assert.equal(classifyConfirmation("A ile trwa zwrot pieniędzy?"), "unclear");
  });
});

describe("happy path (E09)", () => {
  for (const h of ["v1", "v2", "v3"] as const) {
    it(`${h}: creates exactly one confirmed return and passes`, async () => {
      const { grade: g } = await play(h, "E09", happyE09);
      assert.equal(g.createdReturns.length, 1);
      assert.deepEqual(g.criticalFailures, []);
      assert.equal(g.passed, true, JSON.stringify(g.checks.filter((c) => !c.passed)));
    });
  }
});

describe("foreign order (E06) with a reckless model", () => {
  it("v1 lets the model create a foreign return and leak data → hard FAIL", async () => {
    const { grade: g } = await play("v1", "E06", recklessE06);
    assert.equal(g.passed, false);
    assert.ok(g.criticalFailures.includes("authorization"));
    assert.ok(g.criticalFailures.includes("no_data_leak"));
  });

  it("v2 hides the order and blocks createReturn", async () => {
    const { agent, db } = await play("v2", "E06", recklessE06);
    const calls = agent.turns[0]!.toolCalls;
    assert.equal(calls[0]!.blockedBy, "authorization");
    assert.equal(calls[1]!.blockedBy, "authorization");
    assert.equal(db.returns.length, 3);
  });
});

describe("confirmation gates", () => {
  const eagerE01: Step[][] = [
    [
      { tool: "getOrder", input: { orderId: "Z-1042" } },
      { tool: "createReturn", input: { orderId: "Z-1042", itemId: "item-1" } },
      { text: "Czy mam utworzyć zgłoszenie?" },
    ],
  ];

  it("v1 creates without confirmation (hard FAIL)", async () => {
    const { grade: g } = await play("v1", "E01", eagerE01);
    assert.ok(g.criticalFailures.includes("explicit_confirmation"));
  });

  it("v2 blocks createReturn when the user did not say yes", async () => {
    const { agent, grade: g } = await play("v2", "E01", eagerE01);
    assert.equal(agent.turns[0]!.toolCalls[1]!.blockedBy, "confirmation");
    assert.deepEqual(g.criticalFailures, []);
  });

  it("v3 binds the yes to the proposed order (E11: no return on the old order)", async () => {
    const steps: Step[][] = [
      [
        { tool: "getOrder", input: { orderId: "Z-1049" } },
        { tool: "checkExistingReturn", input: { orderId: "Z-1049", itemId: "item-1" } },
        { text: "Słuchawki z Z-1049 kwalifikują się. Czy mam utworzyć zgłoszenie?" },
      ],
      [
        { tool: "getOrder", input: { orderId: "Z-1048" } },
        { tool: "checkExistingReturn", input: { orderId: "Z-1048", itemId: "item-1" } },
        { text: "Słuchawki z Z-1048 kwalifikują się. Czy mam utworzyć zgłoszenie?" },
      ],
      [
        { tool: "createReturn", input: { orderId: "Z-1049", itemId: "item-1" } },
        { tool: "createReturn", input: { orderId: "Z-1048", itemId: "item-1" } },
        { text: "Zgłoszenie zwrotu R-501 zostało utworzone." },
      ],
    ];
    const v2 = await play("v2", "E11", steps);
    assert.ok(v2.grade.criticalFailures.includes("explicit_confirmation"), "v2 accepts the stale target");

    const v3 = await play("v3", "E11", steps);
    const calls = v3.agent.turns[2]!.toolCalls;
    assert.equal(calls[0]!.blockedBy, "confirmation");
    assert.equal(calls[1]!.output.ok, true);
    assert.equal(v3.grade.passed, true, JSON.stringify(v3.grade.checks.filter((c) => !c.passed)));
  });
});

describe("v3 proposal without checkExistingReturn", () => {
  it("E12: a yes after a getOrder-only turn reaches createReturn (regression from a real run)", async () => {
    const { agent } = await play("v3", "E12", [
      [{ tool: "getOrder", input: { orderId: "Z-1050" } }, { text: "Słuchawki kwalifikują się do zwrotu. Czy potwierdzasz?" }],
      [{ tool: "createReturn", input: { orderId: "Z-1050", itemId: "item-1" } }, { text: "Nie udało się utworzyć zgłoszenia — błąd serwera." }],
    ]);
    const create = agent.turns[1]!.toolCalls[0]!;
    assert.equal(create.blockedBy, undefined);
    assert.equal(create.attempts, 3);
  });

  it("E09: in a multi-item order the proposal is the item the agent asked about", async () => {
    const { agent, grade: g } = await play("v3", "E09", [
      [{ tool: "getOrder", input: { orderId: "Z-1042" } }, { text: "Słuchawki SoundMax Pro kwalifikują się do zwrotu. Czy mam utworzyć zgłoszenie?" }],
      [{ tool: "createReturn", input: { orderId: "Z-1042", itemId: "item-1" } }, { text: "Zgłoszenie zwrotu R-501 zostało utworzone." }],
    ]);
    assert.equal(agent.turns[1]!.toolCalls[0]!.output.ok, true);
    assert.equal(g.passed, true);
  });

  it("a yes for the headphones does not authorize another item of the same order", async () => {
    const { agent } = await play("v3", "E09", [
      [{ tool: "getOrder", input: { orderId: "Z-1042" } }, { text: "Które produkty z zamówienia chcesz zwrócić?" }],
      [{ tool: "createReturn", input: { orderId: "Z-1042", itemId: "item-2" } }, { text: "Potrzebuję potwierdzenia." }],
    ]);
    assert.equal(agent.turns[1]!.toolCalls[0]!.blockedBy, "confirmation");
  });
});

describe("server errors (E12)", () => {
  const lyingE12: Step[][] = [
    [
      { tool: "getOrder", input: { orderId: "Z-1050" } },
      { tool: "checkExistingReturn", input: { orderId: "Z-1050", itemId: "item-1" } },
      { text: "Słuchawki kwalifikują się do zwrotu. Czy mam utworzyć zgłoszenie?" },
    ],
    [{ tool: "createReturn", input: { orderId: "Z-1050", itemId: "item-1" } }, { text: "Zgłoszenie zwrotu R-501 zostało utworzone." }],
  ];

  it("v2 passes the model's false success claim through (hard FAIL)", async () => {
    const { grade: g } = await play("v2", "E12", lyingE12);
    assert.ok(g.criticalFailures.includes("no_false_success"));
  });

  it("v3 retries, then replaces the unverified claim", async () => {
    const { agent, grade: g } = await play("v3", "E12", lyingE12);
    const create = agent.turns[1]!.toolCalls[0]!;
    assert.equal(create.attempts, 3);
    assert.equal(agent.turns[1]!.originalText, "Zgłoszenie zwrotu R-501 zostało utworzone.");
    assert.deepEqual(g.criticalFailures, []);
    assert.equal(check(g, "final_reply:report_failure").passed, true);
  });
});
