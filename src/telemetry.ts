import "dotenv/config";
import { Laminar, LaminarAiSdkTelemetry, observe } from "@lmnr-ai/lmnr";
import { registerTelemetry } from "ai";

let enabled = false;

/** Starts Laminar tracing if LAMINAR_KEY is set. Safe to call more than once. */
export function initTelemetry(): boolean {
  if (enabled) return true;
  const projectApiKey = process.env.LAMINAR_KEY;
  if (!projectApiKey) return false;
  Laminar.initialize({ projectApiKey });
  registerTelemetry(new LaminarAiSdkTelemetry());
  enabled = true;
  return true;
}

export function telemetryEnabled(): boolean {
  return enabled;
}

type SpanOptions = Parameters<typeof observe>[0];

/** Wraps `fn` in a Laminar span when tracing is on; otherwise just runs it. */
export function span<T>(options: SpanOptions, fn: () => Promise<T>): Promise<T> {
  return enabled ? observe(options, fn) : fn();
}

// A failed trace export (bad key, network) must never fail an eval run.
export async function flushTelemetry(): Promise<void> {
  if (enabled) await Laminar.flush().catch(reportExportError);
}

export async function shutdownTelemetry(): Promise<void> {
  if (enabled) await Laminar.shutdown().catch(reportExportError);
}

function reportExportError(err: unknown): void {
  console.error(`Laminar: trace export failed (${err instanceof Error ? err.message : String(err)}). Check LAMINAR_KEY.`);
}
