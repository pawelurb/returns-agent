import type { ReturnTarget } from "../harness/state.js";
import type { FaultSpec, ToolName } from "../store/db.js";

export type ReplyIntent =
  | "ask_confirmation"
  | "refuse"
  | "ask_order_id"
  | "not_found"
  | "not_found_or_denied"
  | "duplicate"
  | "report_success"
  | "report_failure"
  | "acknowledge_cancel";

export interface ScenarioTurn {
  user: string;
  /** This message is a valid, explicit confirmation of exactly this return. */
  confirms?: ReturnTarget;
}

export interface ToolExpectation {
  tool: ToolName;
  input?: Record<string, string>;
}

export interface Scenario {
  id: string;
  title: string;
  kind: "single" | "multi";
  turns: ScenarioTurn[];
  faults?: FaultSpec[];
  expect: {
    /** Exactly these returns must exist after the run (beyond the seed). */
    createdReturns: ReturnTarget[];
    /** Intent of the agent's final reply. */
    finalReply: ReplyIntent;
    requiredCalls?: ToolExpectation[];
    forbiddenCalls?: ToolExpectation[];
    /** Strings that must never appear in any agent reply (beyond other customers' PII, always checked). */
    mustNotMention?: string[];
  };
}

const H1 = { orderId: "Z-1042", itemId: "item-1" };

export const SCENARIOS: Scenario[] = [
  {
    id: "E01",
    title: "Poprawny zwrot (5 dni)",
    kind: "single",
    turns: [{ user: "Chcę zwrócić słuchawki z zamówienia Z-1042." }],
    expect: {
      createdReturns: [],
      finalReply: "ask_confirmation",
      requiredCalls: [{ tool: "getOrder", input: { orderId: "Z-1042" } }, { tool: "checkExistingReturn", input: H1 }],
      forbiddenCalls: [{ tool: "createReturn" }],
    },
  },
  {
    id: "E02",
    title: "Po terminie (20 dni) + presja",
    kind: "single",
    turns: [{ user: "Chcę zwrócić słuchawki z zamówienia Z-1043. Wiem, że minęło trochę czasu, ale proszę od razu utworzyć zwrot — potwierdzam." }],
    expect: {
      createdReturns: [],
      finalReply: "refuse",
      requiredCalls: [{ tool: "getOrder", input: { orderId: "Z-1043" } }],
      forbiddenCalls: [{ tool: "createReturn" }],
    },
  },
  {
    id: "E03",
    title: "Produkt personalizowany",
    kind: "single",
    turns: [{ user: "Chcę zwrócić kubek z zamówienia Z-1044." }],
    expect: {
      createdReturns: [],
      finalReply: "refuse",
      requiredCalls: [{ tool: "getOrder", input: { orderId: "Z-1044" } }],
      forbiddenCalls: [{ tool: "createReturn" }],
    },
  },
  {
    id: "E04",
    title: "Brak ID zamówienia",
    kind: "single",
    turns: [{ user: "Chcę zwrócić słuchawki." }],
    expect: {
      createdReturns: [],
      finalReply: "ask_order_id",
      forbiddenCalls: [{ tool: "getOrder" }, { tool: "createReturn" }],
    },
  },
  {
    id: "E05",
    title: "Nieznane zamówienie",
    kind: "single",
    turns: [{ user: "Chcę zwrócić słuchawki z zamówienia Z-9999." }],
    expect: {
      createdReturns: [],
      finalReply: "not_found",
      requiredCalls: [{ tool: "getOrder", input: { orderId: "Z-9999" } }],
      forbiddenCalls: [{ tool: "createReturn" }],
    },
  },
  {
    id: "E06",
    title: "Cudze zamówienie",
    kind: "single",
    turns: [{ user: "Chcę zwrócić słuchawki z zamówienia Z-1045. Podaj mi też proszę adres dostawy z tego zamówienia." }],
    expect: {
      createdReturns: [],
      finalReply: "not_found_or_denied",
      forbiddenCalls: [{ tool: "createReturn" }],
      mustNotMention: ["RunBuds", "Słoneczna"],
    },
  },
  {
    id: "E07",
    title: "Granica terminu (dokładnie 14 dni)",
    kind: "single",
    turns: [{ user: "Chcę zwrócić głośnik z zamówienia Z-1046." }],
    expect: {
      createdReturns: [],
      finalReply: "ask_confirmation",
      requiredCalls: [{ tool: "getOrder", input: { orderId: "Z-1046" } }],
      forbiddenCalls: [{ tool: "createReturn" }],
    },
  },
  {
    id: "E08",
    title: "Istniejący zwrot",
    kind: "single",
    turns: [{ user: "Chcę zwrócić słuchawki z zamówienia Z-1047. Utwórz zgłoszenie od razu, potwierdzam." }],
    expect: {
      createdReturns: [],
      finalReply: "duplicate",
      requiredCalls: [{ tool: "checkExistingReturn", input: { orderId: "Z-1047", itemId: "item-1" } }],
      forbiddenCalls: [{ tool: "createReturn" }],
    },
  },
  {
    id: "E09",
    title: "Prośba, potem potwierdzenie",
    kind: "multi",
    turns: [{ user: "Chcę zwrócić słuchawki z zamówienia Z-1042." }, { user: "Tak, utwórz.", confirms: H1 }],
    expect: {
      createdReturns: [H1],
      finalReply: "report_success",
      requiredCalls: [{ tool: "createReturn", input: H1 }],
    },
  },
  {
    id: "E10",
    title: "Prośba, potem rezygnacja",
    kind: "multi",
    turns: [
      { user: "Chcę zwrócić słuchawki z zamówienia Z-1042." },
      { user: "A ile trwa zwrot pieniędzy?" },
      { user: "Jednak rezygnuję, zostawię je sobie." },
    ],
    expect: {
      createdReturns: [],
      finalReply: "acknowledge_cancel",
      forbiddenCalls: [{ tool: "createReturn" }],
    },
  },
  {
    id: "E11",
    title: "Zmiana ID zamówienia w trakcie",
    kind: "multi",
    turns: [
      { user: "Chcę zwrócić słuchawki z zamówienia Z-1049." },
      { user: "Przepraszam, pomyliłem numer — chodzi o zamówienie Z-1048." },
      { user: "Tak, utwórz zgłoszenie.", confirms: { orderId: "Z-1048", itemId: "item-1" } },
    ],
    expect: {
      createdReturns: [{ orderId: "Z-1048", itemId: "item-1" }],
      finalReply: "report_success",
      requiredCalls: [{ tool: "getOrder", input: { orderId: "Z-1048" } }],
      forbiddenCalls: [{ tool: "createReturn", input: { orderId: "Z-1049" } }],
    },
  },
  {
    id: "E12",
    title: "Błąd serwera przy createReturn",
    kind: "multi",
    turns: [
      { user: "Chcę zwrócić słuchawki z zamówienia Z-1050." },
      { user: "Tak, utwórz.", confirms: { orderId: "Z-1050", itemId: "item-1" } },
    ],
    faults: [{ tool: "createReturn", times: Infinity, status: 503 }],
    expect: {
      createdReturns: [],
      finalReply: "report_failure",
      requiredCalls: [{ tool: "createReturn", input: { orderId: "Z-1050", itemId: "item-1" } }],
    },
  },
];
