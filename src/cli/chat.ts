import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { getModel, resolveModelId } from "../config.js";
import { SupportAgent } from "../harness/agent.js";
import { getHarness } from "../harness/versions.js";
import { ShopDb } from "../store/db.js";
import { DEFAULT_USER_ID } from "../store/seed.js";
import { initTelemetry, shutdownTelemetry } from "../telemetry.js";

const { values } = parseArgs({
  options: {
    harness: { type: "string", default: "v3" },
    model: { type: "string" },
    user: { type: "string", default: DEFAULT_USER_ID },
    debug: { type: "boolean", default: false },
  },
});

const config = getHarness(values.harness);
const modelId = resolveModelId(values.model);
const tracing = initTelemetry();
const db = new ShopDb();
const agent = new SupportAgent({
  model: getModel(modelId),
  modelId,
  db,
  // In a real app this comes from the authenticated session, never from the chat.
  session: { userId: values.user, sessionId: `chat-${Date.now()}` },
  config,
});

console.log(`Returns agent · harness ${config.name} (${config.description}) · model ${modelId}`);
console.log(`Logged in as ${values.user} · Laminar ${tracing ? "on" : "off"} · type "exit" to quit\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
try {
  for (;;) {
    const text = (await rl.question("Ty: ")).trim();
    if (!text) continue;
    if (text === "exit") break;
    const turn = await agent.send(text);
    if (values.debug) {
      for (const c of turn.toolCalls) {
        const out = c.output.ok ? "ok" : c.output.error.code;
        console.log(`  ⚙ ${c.toolName}(${JSON.stringify(c.input)}) → ${out}${c.blockedBy ? ` [blocked: ${c.blockedBy}]` : ""}`);
      }
      if (turn.originalText !== undefined) console.log(`  ⚠ harness replaced reply: "${turn.originalText}"`);
      if (agent.state) console.log(agent.state.describe().replace(/^/gm, "  │ "));
    }
    console.log(`Agent: ${turn.text}\n`);
  }
} finally {
  rl.close();
  await shutdownTelemetry();
}
