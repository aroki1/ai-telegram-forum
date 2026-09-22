import type { ChatMessage, ChatToolCall, ToolSpec } from "./chat-message.ts";
import type {
  ChatBody,
  Dialect,
  ModelMetadata,
  ReadResult,
  StepRequest,
  TurnSettings,
} from "./dialect.ts";
import { ChatRequestError } from "./dialect.ts";

/**
 * OpenAI's `responses` API — the format OpenCode Go serves Grok, GPT‑5.6 Luna
 * and Muse over, and the one dialect whose state cannot be reconstructed from
 * the normalized transcript alone.
 *
 * A `function_call` is invoked by `call_id`, not by an index, and with
 * `store: false` every `reasoning` item comes back **encrypted** and has to be
 * echoed before the items it produced, or the model loses the chain it was
 * reasoning about. That is what `ChatMessage.wire` is for: the normalized
 * fields stay canonical, and the opaque reasoning items ride along beside them
 * and are dropped only when a topic changes dialect.
 *
 * Verified against the live gateway rather than assumed: a tool round trip
 * (reasoning + function_call + function_call_output echoed back) answers 200
 * and the model reads the tool result.
 */

export interface ResponsesOptions {
  label: string;
  defaultContextWindow: number;
  metadata?(model: string): Promise<ModelMetadata | null>;
  capabilityError?(
    metadata: ModelMetadata | null,
    settings: TurnSettings,
    hasImages: boolean,
  ): string | null;
}

type Item = Record<string, unknown>;

/** `xhigh` and above have no Responses equivalent, so they clamp to `high`. */
const EFFORT: Record<string, "minimal" | "low" | "medium" | "high"> = {
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
  ultra: "high",
  persistent: "high",
};

interface ResponsesResponse {
  model?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: Item[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

function textOfContent(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!message.content) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** The opaque items a dialect kept for round-trip fidelity. */
function wireItems(message: ChatMessage): Item[] {
  const wire = message.wire as { items?: Item[] } | undefined;
  return Array.isArray(wire?.items) ? wire.items : [];
}

function userItem(message: ChatMessage): Item {
  if (typeof message.content !== "string" && message.content) {
    return {
      role: "user",
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image_url.url },
      ),
    };
  }
  return { role: "user", content: [{ type: "input_text", text: textOfContent(message) }] };
}

/** Reasoning first: the items it produced have to follow it. */
function assistantItems(message: ChatMessage): Item[] {
  const items: Item[] = [...wireItems(message)];
  const text = textOfContent(message);
  if (text) {
    items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  }
  for (const call of message.tool_calls ?? []) {
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  }
  return items;
}

function toItem(message: ChatMessage): Item[] {
  if (message.role === "user") return [userItem(message)];
  if (message.role === "assistant") return assistantItems(message);
  // The loop records a tool result as `role: "tool"` with the call's id; the
  // Responses API wants it as a first-class item rather than a message role.
  return [
    {
      type: "function_call_output",
      call_id: message.tool_call_id ?? "",
      output: textOfContent(message),
    },
  ];
}

/** Responses keeps tools flat, unlike `chat/completions`. */
function toTool(tool: ToolSpec): Item {
  return {
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  };
}

function reasoningBody(step: StepRequest): unknown {
  if (step.effort) return { effort: EFFORT[step.effort] ?? "medium" };
  // A preset may hand this dialect the exact shape it wants; anything else is
  // left for the API to reject rather than silently rewritten.
  return step.reasoning;
}

export function responsesDialect(options: ResponsesOptions): Dialect {
  return {
    format: "responses",
    label: options.label,
    defaultContextWindow: options.defaultContextWindow,

    metadata: (model) => options.metadata?.(model) ?? Promise.resolve(null),

    capabilityError: (metadata, settings, hasImages) =>
      options.capabilityError?.(metadata, settings, hasImages) ?? null,

    buildRequest: (step: StepRequest): ChatBody => {
      const instructions = step.messages
        .filter((message) => message.role === "system")
        .map(textOfContent)
        .filter(Boolean)
        .join("\n\n");
      const reasoning = reasoningBody(step);
      return {
        model: step.model,
        ...(instructions ? { instructions } : {}),
        input: step.messages.filter((message) => message.role !== "system").flatMap(toItem),
        tools: step.tools.map(toTool),
        ...(step.temperature === undefined ? {} : { temperature: step.temperature }),
        ...(step.maxTokens === undefined ? {} : { max_output_tokens: step.maxTokens }),
        ...(reasoning === undefined ? {} : { reasoning }),
        // Every transcript already lives on disk, append-only, and the
        // reasoning items ride back encrypted on each turn.
        store: false,
      };
    },

    readResponse: (body: unknown): ReadResult => {
      const response = body as ResponsesResponse;
      if (response.error) {
        throw new ChatRequestError(
          `${options.label} request failed: ${response.error.message ?? "unknown error"}`,
        );
      }
      const output = response.output ?? [];
      const reasoning = output.filter((item) => item.type === "reasoning");
      const message = output.find((item) => item.type === "message");
      const calls = output.filter((item) => item.type === "function_call");

      const text = ((message?.content as Item[] | undefined) ?? [])
        .filter((part) => part.type === "output_text")
        .map((part) => String(part.text ?? ""))
        .join("");

      const inTokens = Number(response.usage?.input_tokens ?? 0);
      const outTokens = Number(response.usage?.output_tokens ?? 0);

      if (!message && !calls.length) {
        return {
          message: null,
          resolvedModel: response.model ?? null,
          usage: {
            inTokens: Number.isFinite(inTokens) ? inTokens : 0,
            outTokens: Number.isFinite(outTokens) ? outTokens : 0,
            costUsd: null,
          },
        };
      }

      const toolCalls: ChatToolCall[] = calls.map((call) => ({
        id: String(call.call_id ?? ""),
        type: "function",
        function: {
          name: String(call.name ?? "unknown"),
          arguments: typeof call.arguments === "string" ? call.arguments : "{}",
        },
      }));

      return {
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          ...(reasoning.length ? { wire: { items: reasoning } } : {}),
        },
        resolvedModel: response.model ?? null,
        usage: {
          inTokens: Number.isFinite(inTokens) ? inTokens : 0,
          outTokens: Number.isFinite(outTokens) ? outTokens : 0,
          // Go reports tokens and never dollars, on this route as on the other.
          costUsd: null,
        },
      };
    },
  };
}
