import type { RunResult } from "./runner.js";
import type { Scenario } from "./scenarios.js";

export function printReport(all: RunResult[], names: string[], scenarios: Scenario[], verbose = false): void {
  const cell = (rs: RunResult[]) => {
    if (!rs.length) return "-";
    const pass = rs.filter((r) => r.grade.passed).length;
    const avg = Math.round(rs.reduce((s, r) => s + r.grade.score, 0) / rs.length);
    const crit = rs.some((r) => r.grade.criticalFailures.length) ? "!" : "";
    return `${pass}/${rs.length} ${String(avg).padStart(3)}${crit}`;
  };

  console.log(`\n${"Scenario".padEnd(44)}${names.map((n) => n.padEnd(14)).join("")}`);
  for (const s of scenarios) {
    const row = names.map((n) => cell(all.filter((r) => r.harness === n && r.scenarioId === s.id)).padEnd(14));
    console.log(`${`${s.id} ${s.title}`.padEnd(44)}${row.join("")}`);
  }

  console.log(`\n${"Summary".padEnd(44)}${names.map((n) => n.padEnd(14)).join("")}`);
  const stat = (label: string, f: (rs: RunResult[]) => string) =>
    console.log(`${label.padEnd(44)}${names.map((n) => f(all.filter((r) => r.harness === n)).padEnd(14)).join("")}`);
  stat("Scenarios passing on every run", (rs) => {
    const ok = scenarios.filter((s) => {
      const sr = rs.filter((r) => r.scenarioId === s.id);
      return sr.length > 0 && sr.every((r) => r.grade.passed);
    }).length;
    return `${ok}/${scenarios.length}`;
  });
  stat("Run pass rate", (rs) => `${pct(rs.filter((r) => r.grade.passed).length, rs.length)}`);
  stat("Avg weighted score", (rs) => `${avg(rs, (r) => r.grade.score)}`);
  stat("Runs with critical violations", (rs) => `${rs.filter((r) => r.grade.criticalFailures.length).length}`);
  stat("Avg tool calls / blocked by harness", (rs) => `${avg(rs, (r) => r.metrics.toolCalls)} / ${avg(rs, (r) => r.metrics.blockedToolCalls)}`);
  stat("Avg tokens (in+out)", (rs) => `${avg(rs, (r) => r.metrics.inputTokens + r.metrics.outputTokens)}`);
  stat("Avg latency (s)", (rs) => `${(avg(rs, (r) => r.metrics.latencyMs) / 1000).toFixed(1)}`);
  console.log(`\nCell = passed runs / runs, avg score; "!" = at least one critical (hard-constraint) violation.`);

  const failures = all.filter((r) => !r.grade.passed).sort((a, b) => (a.harness + a.scenarioId).localeCompare(b.harness + b.scenarioId));
  if (failures.length) console.log("\nFailures:");
  for (const r of failures) {
    console.log(`  ${r.harness} ${r.scenarioId} r${r.run} (score ${r.grade.score}, session ${r.sessionId})`);
    for (const c of r.grade.checks.filter((c) => !c.passed)) {
      console.log(`    ${c.critical ? "✖ HARD" : "· soft"} ${c.id}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    if (verbose) {
      for (const t of r.turns) {
        console.log(`      user: ${t.userText}`);
        for (const c of t.toolCalls) console.log(`      tool: ${c.toolName}(${JSON.stringify(c.input)}) → ${c.output.ok ? "ok" : c.output.error.code}${c.blockedBy ? ` [blocked: ${c.blockedBy}]` : ""}`);
        console.log(`      agent: ${t.text.replace(/\s+/g, " ")}`);
      }
    }
  }
}

function avg(rs: RunResult[], f: (r: RunResult) => number): number {
  return rs.length ? Math.round(rs.reduce((s, r) => s + f(r), 0) / rs.length) : 0;
}

function pct(n: number, d: number): string {
  return d ? `${Math.round((100 * n) / d)}%` : "-";
}
