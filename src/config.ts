import "dotenv/config";
import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry, type LanguageModel } from "ai";

/**
 * Model swapping goes through the AI SDK provider registry: any "<provider>:<model>"
 * id works. To add a provider, install it (e.g. @ai-sdk/anthropic) and register it here.
 */
const registry = createProviderRegistry({
  openai: createOpenAI({ apiKey: process.env.OPENAI_KEY }),
});

export const DEFAULT_MODEL_ID = "openai:gpt-4.1-mini";

export function resolveModelId(id?: string): string {
  return id ?? process.env.MODEL ?? DEFAULT_MODEL_ID;
}

export function getModel(id?: string): LanguageModel {
  return registry.languageModel(resolveModelId(id) as `openai:${string}`);
}

/** Unset TEMPERATURE to omit the setting (needed for models that reject it). */
export function getTemperature(): number | undefined {
  const raw = process.env.TEMPERATURE ?? "0";
  return raw === "" ? undefined : Number(raw);
}
