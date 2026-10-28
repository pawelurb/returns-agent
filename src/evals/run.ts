import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getModel, resolveModelId } from "../config.js";
import { getHarness, HARNESS_VERSIONS } from "../harness/versions.js";
import { initTelemetry, shutdownTelemetry } from "../telemetry.js";
import { PASS_THRESHOLD, WEIGHTS } from "./graders.js";
import { printReport } from "./report.js";
import { runScenario, type RunResult } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

const { values } = parseArgs({
  options: {
    harness: { type: "string", default: Object.keys(HARNESS_VERSIONS).join(",") },
    scenarios: { type: "string" },
    runs: { type: "string", default: "1" },
    model: { type: "string" },
    concurrency: { type: "string", default: "4" },
    verbose: { type: "boolean", default: false },
  },
});

const harnesses = values.harness.split(",").map((h) => getHarness(h.trim()));
const wanted = values.scenarios?.split(",").map((s) => s.trim().toUpperCase());
const scenarios = wanted ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS;
const runs = Number(values.runs);
const modelId = resolveModelId(values.model);
const model = getModel(modelId);
const runTag = new Date().toISOString().replace(/[:.]/g, "-");

if (!process.env.OPENAI_KEY && modelId.startsWith("openai:")) {
  console.error("OPENAI_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const tracing = initTelemetry();
console.log(
  `Model ${modelId} · harness ${harnesses.map((h) => h.name).join(", ")} · ${scenarios.length} scenarios × ${runs} run(s)` +
    ` · Laminar ${tracing ? "on" : "off (set LAMINAR_KEY)"}\n`,
);

const jobs = harnesses.flatMap((config) =>
  scenarios.flatMap((scenario) => Array.from({ length: runs }, (_, i) => ({ config, scenario, run: i + 1 }))),
);

const results: RunResult[] = [];
let done = 0;
await pool(jobs, Number(values.concurrency), async (job) => {
  const r = await runScenario({ ...job, model, modelId, runTag });
  results.push(r);
  done++;
  const mark = r.grade.passed ? "PASS" : "FAIL";
  process.stdout.write(`[${done}/${jobs.length}] ${job.config.name} ${job.scenario.id} r${job.run}: ${mark} (${r.grade.score})\n`);
});

printReport(results, harnesses.map((h) => h.name), scenarios, values.verbose);

mkdirSync("results", { recursive: true });
const file = `results/eval-${runTag}.json`;
writeFileSync(file, JSON.stringify({ model: modelId, runs, weights: WEIGHTS, passThreshold: PASS_THRESHOLD, results }, null, 2));
console.log(`\nFull transcripts and checks: ${file}`);
await shutdownTelemetry();

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.max(1, size) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
    }),
  );
}
