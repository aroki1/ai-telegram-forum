import type { ChatMessage } from "./chat-message.ts";
import type {
  ChatBody,
  Dialect,
  ModelMetadata,
  ReadResult,
  StepRequest,
  TurnSettings,
} from "./dialect.ts";

/**
 * OpenAI's `chat/completions` shape — the dialect OpenRouter speaks natively
 * and the one OpenCode Go labels `oa-compat`.
 *
 * Everything here is wire-level: how `reasoning` folds in, which token limit
 * key the model accepts, how an assistant message and its usage come back.
 * Catalog and capability policy belong to whoever configures the dialect.
 */
export interface OaCompatOptions {
  label: string;
  defaultContextWindow: number;
  /** A catalog row, or null when the provider publishes none. */
  metadata?(model: string): Promise<ModelMetadata | null>;
  capabilityError?(
    metadata: ModelMetadata | null,
    settings: TurnSettings,
    hasImages: boolean,
  ): string | null;
}

export interface OaCompatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: ChatMessage;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number | string;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

/**
 * Fold `/effort` into a preset's reasoning blob the way OpenRouter reads it:
 * a preset object gains `effort`, anything else is replaced by it.
 */
function reasoningBody(reasoning: unknown, effort: TurnSettings["effort"]): unknown {
  if (!effort) return reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    return { ...(reasoning as Record<string, unknown>), effort };
  }
  return { effort };
}

function tokenLimitKey(metadata: ModelMetadata | null, maxTokens: number): ChatBody {
  const parameters = metadata?.supported_parameters;
  return parameters?.includes("max_completion_tokens") && !parameters.includes("max_tokens")
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/**
 * Tokens and, where the host reports one, dollars. `cost` is OpenRouter's
 * addition — hosts without it return `costUsd: null` rather than a guess.
 */
export function oaCompatUsage(response: OaCompatResponse): {
  inTokens: number;
  outTokens: number;
  costUsd: number | null;
} {
  const usage = response.usage;
  const inTokens = Number(usage?.prompt_tokens ?? 0);
  const outTokens = Number(usage?.completion_tokens ?? 0);
  const rawCost = usage?.cost;
  const cost = rawCost === undefined || rawCost === null || rawCost === "" ? null : Number(rawCost);
  return {
    inTokens: Number.isFinite(inTokens) ? inTokens : 0,
    outTokens: Number.isFinite(outTokens) ? outTokens : 0,
    costUsd: cost !== null && Number.isFinite(cost) ? cost : null,
  };
}

export function oaCompatDialect(options: OaCompatOptions): Dialect {
  return {
    format: "oa-compat",
    label: options.label,
    defaultContextWindow: options.defaultContextWindow,

    metadata: (model) => options.metadata?.(model) ?? Promise.resolve(null),

    capabilityError: (metadata, settings, hasImages) =>
      options.capabilityError?.(metadata, settings, hasImages) ?? null,

    buildRequest: (step: StepRequest, metadata: ModelMetadata | null): ChatBody => {
      const reasoning = reasoningBody(step.reasoning, step.effort);
      return {
        ...(step.models?.length ? { models: step.models } : { model: step.model }),
        messages: step.messages,
        tools: step.tools,
        ...(step.temperature === undefined ? {} : { temperature: step.temperature }),
        ...(step.maxTokens === undefined ? {} : tokenLimitKey(metadata, step.maxTokens)),
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(step.provider === undefined ? {} : { provider: { ...step.provider } }),
      };
    },

    readResponse: (body: unknown): ReadResult => {
      const response = body as OaCompatResponse;
      return {
        message: response.choices?.[0]?.message ?? null,
        resolvedModel: response.model ?? null,
        usage: oaCompatUsage(response),
      };
    },
  };
}
