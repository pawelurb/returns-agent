/**
 * Harness variants compared in the experiment. Every flag is a single, isolated
 * mechanism so a version diff can be attributed to a specific change.
 */
export interface HarnessConfig {
  name: HarnessName;
  description: string;
  /** getOrder / checkExistingReturn hide orders that don't belong to the session user. */
  authorizeReads: boolean;
  /** createReturn is checked against ownership + policy + duplicates before it runs. */
  guardCreateReturn: boolean;
  /**
   * How user confirmation is enforced for createReturn:
   *  - "prompt": only the system prompt asks for it (model decides)
   *  - "lastMessage": the latest user message must be an explicit "yes"
   *  - "boundProposal": the "yes" must answer a proposal for the exact (orderId, itemId)
   */
  confirmation: "prompt" | "lastMessage" | "boundProposal";
  /** Track conversation state (current order, verified facts, pending proposal) and show it to the model. */
  sessionState: boolean;
  /** Add harness-computed eligibility to getOrder output (no date math left to the model). */
  enrichOrder: boolean;
  /** Retries for upstream 5xx errors (createReturn uses an idempotency key). */
  toolRetries: number;
  /** Replace a final answer that claims an unconfirmed success. */
  verifyOutput: boolean;
  maxSteps: number;
}

export type HarnessName = "v1" | "v2" | "v3";

export const HARNESS_VERSIONS: Record<HarnessName, HarnessConfig> = {
  v1: {
    name: "v1",
    description: "Basic: LLM + tool calling, rules only in the prompt",
    authorizeReads: false,
    guardCreateReturn: false,
    confirmation: "prompt",
    sessionState: false,
    enrichOrder: false,
    toolRetries: 0,
    verifyOutput: false,
    maxSteps: 8,
  },
  v2: {
    name: "v2",
    description: "Guardrails: deterministic checks before tool calls",
    authorizeReads: true,
    guardCreateReturn: true,
    confirmation: "lastMessage",
    sessionState: false,
    enrichOrder: false,
    toolRetries: 0,
    verifyOutput: false,
    maxSteps: 8,
  },
  v3: {
    name: "v3",
    description: "Stateful: session state, bound confirmation, retries, output verification",
    authorizeReads: true,
    guardCreateReturn: true,
    confirmation: "boundProposal",
    sessionState: true,
    enrichOrder: true,
    toolRetries: 2,
    verifyOutput: true,
    maxSteps: 8,
  },
};

export function getHarness(name: string): HarnessConfig {
  const config = HARNESS_VERSIONS[name as HarnessName];
  if (!config) throw new Error(`Unknown harness "${name}". Use one of: ${Object.keys(HARNESS_VERSIONS).join(", ")}`);
  return config;
}
