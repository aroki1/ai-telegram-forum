import type { ChatMessage, ToolSpec } from "./chat-message.ts";
import type { Usage } from "./claude.ts";
import type { Effort } from "./effort.ts";

/**
 * One provider's wire format: everything that differs between HTTP APIs.
 *
 * The agent loop owns everything that does *not* differ — tool execution, the
 * Telegram approval flow, context compaction, history, the step limit. A
 * dialect is only asked to turn a settled request into bytes and an assistant
 * message back out of the response.
 */
export interface Dialect {
  readonly format: WireFormat;
  /** How errors and summaries name this provider: "OpenRouter", "OpenCode Go". */
  readonly label: string;
  /** Window assumed when the provider publishes no catalog row. */
  readonly defaultContextWindow: number;

  /** A catalog row, or null when the provider publishes none. Never blocks a turn. */
  metadata(model: string): Promise<ModelMetadata | null>;

  /** A request this model cannot serve. Null means "send it". */
  capabilityError(
    metadata: ModelMetadata | null,
    settings: TurnSettings,
    hasImages: boolean,
  ): string | null;

  /** The HTTP body for one step. `messages` arrives already compacted. */
  buildRequest(step: StepRequest, metadata: ModelMetadata | null): ChatBody;

  /** One assistant message out of a successful response body. */
  readResponse(body: unknown): ReadResult;
}

export type WireFormat = "oa-compat" | "messages" | "responses";

/**
 * What a turn resolves before anything is serialized — model choice, sampling
 * and reasoning, with the wire details deliberately absent.
 */
export interface TurnSettings {
  model?: string;
  /** OpenRouter-style fallback chain. A dialect without one ignores this. */
  models?: string[];
  temperature?: number;
  maxTokens?: number;
  /** What a preset asked for, unmixed with `effort`. */
  reasoning?: unknown;
  /** The `/effort` level; each dialect decides how to encode it, if at all. */
  effort?: Effort;
  provider?: Record<string, unknown>;
}

export interface StepRequest extends TurnSettings {
  messages: ChatMessage[];
  tools: ToolSpec[];
}

/** The opaque JSON handed to a {@link ChatClient}. */
export type ChatBody = Record<string, unknown>;

/**
 * A request that failed before a response came back.
 *
 * Transport errors extend this so one `instanceof` check in the loop covers
 * every provider's retries, auth and HTTP failures.
 */
export class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ChatRequestError";
  }
}

export interface ReadResult {
  /** Null when the provider answered without an assistant message. */
  message: ChatMessage | null;
  resolvedModel: string | null;
  usage: Usage;
}

/** A catalog row. Providers that publish none return null instead of inventing one. */
export interface ModelMetadata {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  supported_parameters?: string[];
}

/** The surface a dialect is driven through; any fetch client with retries fits. */
export interface ChatClient {
  complete(body: ChatBody, signal?: AbortSignal): Promise<unknown>;
}
