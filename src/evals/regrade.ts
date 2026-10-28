import { readFileSync, readdirSync } from "node:fs";
import { ShopDb } from "../store/db.js";
import { DEFAULT_NOW, DEFAULT_USER_ID } from "../store/seed.js";
import { grade } from "./graders.js";
import { printReport } from "./report.js";
import type { RunResult } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";

/**
 * Re-scores saved transcripts with the current graders — no LLM calls.
 * Usage: npm run regrade [file.json] [--verbose]   (defaults to the newest results/eval-*.json)
 *   e.g. npm run regrade results/baselines/2026-10-28-runs5-after-fixes.json
 */
const newest = readdirSync("results").filter((f) => f.startsWith("eval-") && f.endsWith(".json")).sort().at(-1);
const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? (newest && `results/${newest}`);
if (!file) {
  console.error("No results/eval-*.json found. Pass a file, e.g. results/baselines/<name>.json");
  process.exit(1);
}
const saved = JSON.parse(readFileSync(file, "utf8")) as { model: string; results: RunResult[] };

const results = saved.results.map((r) => {
  const scenario = SCENARIOS.find((s) => s.id === r.scenarioId);
  if (!scenario) throw new Error(`Unknown scenario ${r.scenarioId}`);
  // Rebuild the final DB state: seed + the returns this run created.
  const db = new ShopDb(DEFAULT_NOW);
  db.returns.push(...r.grade.createdReturns);
  const before = r.grade;
  const after = grade(scenario, r.turns, db, DEFAULT_USER_ID);
  if (before.passed !== after.passed || before.score !== after.score) {
    console.log(`${r.harness} ${r.scenarioId} r${r.run}: ${verdict(before)} → ${verdict(after)}`);
  }
  return { ...r, grade: after };
});

console.log(`\nRegraded ${file} (model ${saved.model})`);
const names = [...new Set(results.map((r) => r.harness))];
const ids = new Set(results.map((r) => r.scenarioId));
printReport(results, names, SCENARIOS.filter((s) => ids.has(s.id)), process.argv.includes("--verbose"));

function verdict(g: { passed: boolean; score: number }): string {
  return `${g.passed ? "PASS" : "FAIL"} ${g.score}`;
}
