import type { ChatContentPart, ChatMessage, ToolSpec } from "./chat-message.ts";
import type { Usage } from "./claude.ts";
import type { ChatClient, Dialect, ReadResult, TurnSettings } from "./dialect.ts";
import { ChatRequestError } from "./dialect.ts";
import { TG_SEND_TOOL } from "./tg-tools.ts";
import {
  executeOpenRouterTool,
  toolInput,
  type OpenRouterToolContext,
} from "./openrouter-tools.ts";

/**
 * The provider-neutral turn runner: one step loop from "the user said
 * something" to "the model stopped calling tools".
 *
 * Nothing in here knows which wire format is in play. It asks the {@link
 * Dialect} for a body, hands it to a {@link ChatClient}, and reads an assistant
 * message back. Tool execution, the Telegram approval flow, context
 * compaction, history persistence and the step limit are all properties of an
 * agent turn rather than of an HTTP API, so they stay here.
 */
export interface RunLoopArgs {
  dialect: Dialect;
  client: ChatClient;
  settings: TurnSettings;
  initialMessages: ChatMessage[];
  input: LoopInput;
  tools: ToolSpec[];
  maxSteps: number;
  maxToolOutput: number;
  signal: AbortSignal;
  deliverTelegram: boolean;
  /** Null for a side question: its turns are never written to the transcript. */
  history: ChatHistory | null;
  toolContext: Omit<OpenRouterToolContext, "signal" | "deliverTelegram">;
  onTool(name: string, input: unknown): void | Promise<void>;
  onModel?(model: string): void;
  onText?(text: string): void;
}

/**
 * Structurally an `AgentInput` minus the parts a loop has no business seeing,
 * so `agent-session.ts` does not have to be imported from here — and dragged
 * into a cycle with the session class that calls this module.
 */
export interface LoopInput {
  text: string;
  images: ReadonlyArray<{ data: string; mediaType: string }>;
}

/** The append-only transcript a live turn is recorded into as it happens. */
export interface ChatHistory {
  ensureSystem(content: string): ChatMessage[];
  append(message: ChatMessage): void;
}

export interface LoopResult {
  ok: boolean;
  failure: string | null;
  stopped: boolean;
  usage: Usage;
  answer: string;
  resolvedModel: string | null;
}

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inTokens: a.inTokens + b.inTokens,
    outTokens: a.outTokens + b.outTokens,
    costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}

function stoppedResult(usage: Usage, answer: string, resolvedModel: string | null): LoopResult {
  return { ok: false, failure: null, stopped: true, usage, answer, resolvedModel };
}

function failureResult(
  usage: Usage,
  answer: string,
  resolvedModel: string | null,
  failure: string,
): LoopResult {
  return { ok: false, failure, stopped: false, usage, answer, resolvedModel };
}

/** Transport errors carry their own message; anything else names the provider. */
export function formatError(err: unknown, label: string): string {
  if (err instanceof ChatRequestError) return `❌ ${err.message}`;
  return `❌ ${label} request failed: ${String(err)}`;
}

function inputMessage(input: LoopInput): ChatMessage {
  if (!input.images.length) return { role: "user", content: input.text };
  const content: ChatContentPart[] = [
    ...(input.text ? [{ type: "text" as const, text: input.text }] : []),
    ...input.images.map((image) => ({
      type: "image_url" as const,
      image_url: { url: `data:${image.mediaType};base64,${image.data}` },
    })),
  ];
  return { role: "user", content };
}

function textOf(message: ChatMessage | undefined): string {
  if (!message?.content) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function roughTokens(message: ChatMessage): number {
  const content =
    typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
  return Math.ceil((content.length + JSON.stringify(message.tool_calls ?? []).length) / 4);
}

function messageSummary(message: ChatMessage): string {
  const label = message.role === "tool" ? `tool ${message.name ?? "result"}` : message.role;
  return `${label}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")}`;
}

/**
 * Keep the original JSONL intact while sending a bounded, tool-pair-safe view.
 *
 * Runs on the normalized messages, so it works for every dialect: what is
 * dropped from the request is never dropped from the transcript.
 */
function contextMessages(messages: ChatMessage[], limit: number, reserve: number): ChatMessage[] {
  const budget = Math.max(1, Math.min(limit, limit - reserve));
  const system = messages.filter((message) => message.role === "system").slice(0, 1);
  const conversation = messages.filter((message) => message.role !== "system");
  const groups: ChatMessage[][] = [];
  for (const message of conversation) {
    const current = groups.at(-1);
    if (!current || (message.role === "user" && current.some((item) => item.role !== "tool"))) {
      groups.push([message]);
    } else current.push(message);
  }

  let used = system.reduce((sum, message) => sum + roughTokens(message), 0);
  const kept: ChatMessage[][] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]!;
    const size = group.reduce((sum, message) => sum + roughTokens(message), 0);
    if (kept.length && used + size > budget) break;
    kept.unshift(group);
    used += size;
  }
  const dropped = groups.slice(0, Math.max(0, groups.length - kept.length)).flat();
  const compacted: ChatMessage[] = [...system];
  if (dropped.length) {
    const summary = dropped.map(messageSummary).join("\n").slice(0, 8_000);
    compacted.push({
      role: "system",
      content: `Earlier context was compacted to fit the model window. The full append-only history remains on disk.\n${summary}`,
    });
  }
  compacted.push(...kept.flat());
  return compacted;
}

/** Run one turn to completion. Never throws: a failure comes back as `failure`. */
export async function runAgentLoop(args: RunLoopArgs): Promise<LoopResult> {
  const { dialect, client, settings, tools, maxSteps, maxToolOutput, signal, history } = args;
  const label = dialect.label;

  const messages = cloneMessages(args.initialMessages);
  const user = inputMessage(args.input);
  messages.push(user);
  if (history) history.append(user);

  let usage = zeroUsage();
  let answer = "";
  let resolvedModel: string | null = null;
  const hasImages = args.input.images.length > 0;

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return stoppedResult(usage, answer, resolvedModel);
    const metadata = await dialect.metadata(settings.model ?? "");
    if (signal.aborted) return stoppedResult(usage, answer, resolvedModel);
    const capabilityError = dialect.capabilityError(metadata, settings, hasImages);
    if (capabilityError) return failureResult(usage, answer, resolvedModel, `❌ ${capabilityError}`);

    const window = metadata?.context_length ?? dialect.defaultContextWindow;
    const body = dialect.buildRequest(
      {
        ...settings,
        messages: contextMessages(messages, window, settings.maxTokens ?? 4096),
        tools,
      },
      metadata,
    );

    let response: unknown;
    try {
      response = await client.complete(body, signal);
    } catch (err) {
      if (signal.aborted) return stoppedResult(usage, answer, resolvedModel);
      return failureResult(usage, answer, resolvedModel, formatError(err, label));
    }

    // A dialect may reject a response it cannot read — the `responses` API
    // carries its failures inside a 200 body — so this is a failure like any
    // other rather than something that escapes the loop.
    let read: ReadResult;
    try {
      read = dialect.readResponse(response);
    } catch (err) {
      return failureResult(usage, answer, resolvedModel, formatError(err, label));
    }
    usage = addUsage(usage, read.usage);
    if (read.resolvedModel) {
      resolvedModel = read.resolvedModel;
      args.onModel?.(read.resolvedModel);
    }
    if (!read.message) {
      return failureResult(usage, answer, resolvedModel, `❌ ${label} returned no assistant message`);
    }

    const message = read.message;
    messages.push(message);
    if (history) history.append(message);
    const text = textOf(message);
    if (text.trim()) {
      answer = text;
      args.onText?.(text);
    }

    const calls = message.tool_calls ?? [];
    if (!calls.length) return { ok: true, failure: null, stopped: false, usage, answer, resolvedModel };

    for (const call of calls) {
      const name = call.function?.name ?? "unknown";
      const input = toolInput(call.function?.arguments ?? "{}");
      if (name !== TG_SEND_TOOL) await args.onTool(name, input);

      let result: string;
      try {
        result = await executeOpenRouterTool(name, input, {
          ...args.toolContext,
          signal,
          deliverTelegram: args.deliverTelegram,
        });
      } catch (err) {
        result = signal.aborted
          ? "Tool execution stopped before completion."
          : `Tool error: ${String(err)}`;
      }

      const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: call.id,
        content: result.slice(0, maxToolOutput),
      };
      messages.push(toolMessage);
      if (history) history.append(toolMessage);
      if (signal.aborted) return stoppedResult(usage, answer, resolvedModel);
    }
  }

  return failureResult(
    usage,
    answer,
    resolvedModel,
    `⚠️ ${label} reached the ${maxSteps}-step tool limit`,
  );
}
