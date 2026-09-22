import { cfg } from "./config.ts";
import { ChatRequestError } from "./dialect.ts";
import type {
  ChatBody,
  Dialect,
  ModelMetadata,
  ReadResult,
  StepRequest,
  TurnSettings,
} from "./dialect.ts";
import type { ChatContentPart, ChatMessage, ChatToolCall, ToolSpec } from "./chat-message.ts";
import type { OpenRouterProviderPreferences } from "./openrouter-config.ts";

// The wire names are kept as aliases rather than definitions: OpenRouter
// speaks `chat/completions` natively, so its messages *are* the normalized
// transcript, and history written before the split keeps parsing.
export type OpenRouterContentPart = ChatContentPart;
export type OpenRouterToolCall = ChatToolCall;
export type OpenRouterMessage = ChatMessage;
export type OpenRouterTool = ToolSpec;

export interface OpenRouterChatRequest {
  model?: string;
  models?: string[];
  messages: OpenRouterMessage[];
  tools?: OpenRouterTool[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning?: unknown;
  provider?: OpenRouterProviderPreferences;
}

export interface OpenRouterResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: OpenRouterMessage;
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

export class OpenRouterError extends ChatRequestError {
  constructor(
    message: string,
    status: number | null = null,
    code: string | null = null,
  ) {
    super(message, status, code);
    this.name = "OpenRouterError";
  }
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const CATALOG_ENDPOINT = "https://openrouter.ai/api/v1/models";
const REQUEST_TRIES = 3;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 500 * 2 ** Math.max(0, response.status === 429 ? 0 : 1);
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(250, seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(30_000, Math.max(250, at - Date.now())) : 1000;
}

async function errorFromResponse(response: Response): Promise<OpenRouterError> {
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // The status still gives the caller a useful error.
  }
  const raw = body?.error;
  const message = typeof raw === "string" ? raw : raw?.message;
  const code = typeof raw?.code === "string" ? raw.code : null;
  if (response.status === 401 || response.status === 403) {
    return new OpenRouterError(
      "OpenRouter authorization failed: OPENROUTER_API_KEY was rejected",
      response.status,
      code,
    );
  }
  if (response.status === 404) {
    return new OpenRouterError(
      `OpenRouter model or endpoint was not found${message ? `: ${message}` : ""}`,
      response.status,
      code,
    );
  }
  if (response.status === 402) {
    return new OpenRouterError(
      `OpenRouter payment or credits error${message ? `: ${message}` : ""}`,
      response.status,
      code,
    );
  }
  return new OpenRouterError(
    `OpenRouter request failed (HTTP ${response.status})${message ? `: ${message}` : ""}`,
    response.status,
    code,
  );
}

export class OpenRouterClient {
  constructor(
    private readonly apiKey: string = cfg.openrouterApiKey,
    private readonly request: typeof fetch = fetch,
  ) {}

  async complete(body: ChatBody, signal?: AbortSignal): Promise<unknown> {
    if (!this.apiKey) {
      throw new OpenRouterError("OpenRouter is unavailable: OPENROUTER_API_KEY is empty");
    }

    for (let attempt = 0; attempt < REQUEST_TRIES; attempt++) {
      let response: Response;
      try {
        response = await this.request(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "ai-telegram-forum",
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (attempt + 1 >= REQUEST_TRIES) {
          throw new OpenRouterError(`OpenRouter network request failed: ${String(err)}`);
        }
        await sleep(500 * 2 ** attempt, signal);
        continue;
      }

      if (response.ok) {
        try {
          return (await response.json()) as OpenRouterResponse;
        } catch {
          throw new OpenRouterError("OpenRouter returned invalid JSON", response.status);
        }
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt + 1 >= REQUEST_TRIES) throw await errorFromResponse(response);
      await sleep(retryAfterMs(response), signal);
    }
    throw new OpenRouterError("OpenRouter request failed after retries");
  }
}

export type OpenRouterModelMetadata = ModelMetadata;

let catalog: { expiresAt: number; models: Map<string, ModelMetadata> } | null = null;
let catalogRequest: Promise<Map<string, ModelMetadata> | null> | null = null;

/** The public catalog is advisory; a failure never prevents a chat request. */
export async function openRouterModelMetadata(
  model: string,
  apiKey = cfg.openrouterApiKey,
): Promise<ModelMetadata | null> {
  if (!apiKey) return null;
  const models = await openRouterCatalog(apiKey);
  return models?.get(model) ?? null;
}

async function openRouterCatalog(apiKey: string): Promise<Map<string, ModelMetadata> | null> {
  if (catalog && catalog.expiresAt > Date.now()) return catalog.models;
  if (catalogRequest) return catalogRequest;
  catalogRequest = (async () => {
    try {
      const response = await fetch(CATALOG_ENDPOINT, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw await errorFromResponse(response);
      const body = (await response.json()) as { data?: ModelMetadata[] };
      const models = new Map((body.data ?? []).filter((item) => item?.id).map((item) => [item.id, item]));
      catalog = { expiresAt: Date.now() + 15 * 60_000, models };
      return models;
    } catch (err) {
      console.warn(`[openrouter] model catalog unavailable: ${String(err)}`);
      catalog = { expiresAt: Date.now() + 60_000, models: new Map() };
      return null;
    } finally {
      catalogRequest = null;
    }
  })();
  return catalogRequest;
}

/** The request knobs a preset may set that the model is free not to support. */
export interface CapabilitySettings {
  temperature?: number;
  maxTokens?: number;
  reasoning?: unknown;
}

export function openRouterCapabilityError(
  metadata: ModelMetadata | null,
  settings: CapabilitySettings,
  hasImages: boolean,
): string | null {
  // The free router deliberately chooses a model based on the request's
  // capabilities, so its own catalog row is not a reliable capability limit.
  if (!metadata || metadata.id === "openrouter/free") return null;
  const parameters = metadata.supported_parameters;
  const modalities = metadata.architecture?.input_modalities ?? [];
  if (hasImages && modalities.length && !modalities.some((item) => /image/i.test(item))) {
    return `OpenRouter model ${metadata.id} does not advertise image input support`;
  }
  if (parameters?.length && !parameters.includes("tools")) {
    return `OpenRouter model ${metadata.id} does not advertise tool support; choose a tool-capable model`;
  }
  if (settings.temperature !== undefined && parameters?.length && !parameters.includes("temperature")) {
    return `OpenRouter model ${metadata.id} does not advertise temperature; remove it from the preset`;
  }
  if (
    settings.maxTokens !== undefined &&
    parameters?.length &&
    !parameters.includes("max_tokens") &&
    !parameters.includes("max_completion_tokens")
  ) {
    return `OpenRouter model ${metadata.id} does not advertise a maximum-token parameter; remove max_tokens from the preset`;
  }
  if (
    settings.reasoning !== undefined &&
    parameters?.length &&
    !parameters.includes("reasoning") &&
    !parameters.includes("reasoning_effort")
  ) {
    return `OpenRouter model ${metadata.id} does not advertise reasoning parameters; remove reasoning from the preset`;
  }
  return null;
}

export function openRouterUsage(response: OpenRouterResponse): {
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

function tokenLimitKey(metadata: ModelMetadata | null, maxTokens: number): ChatBody {
  const parameters = metadata?.supported_parameters;
  return parameters?.includes("max_completion_tokens") && !parameters.includes("max_tokens")
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

/**
 * Fold `/effort` into a preset's reasoning blob, the way OpenRouter reads it:
 * a preset object gains `effort`, anything else is replaced by it.
 */
function reasoningBody(
  reasoning: unknown,
  effort: TurnSettings["effort"],
): unknown {
  if (!effort) return reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    return { ...(reasoning as Record<string, unknown>), effort };
  }
  return { effort };
}

/** OpenRouter's wire format — OpenAI `chat/completions` plus its own extras. */
export const openRouterDialect: Dialect = {
  format: "oa-compat",
  label: "OpenRouter",
  defaultContextWindow: cfg.openrouterContextWindow,

  metadata: (model) => openRouterModelMetadata(model),

  // Deliberately the *preset's* reasoning, not the effort-mixed body: a preset
  // that names an unsupported parameter should say so, while `/effort` on a
  // model without reasoning support is left for the API to answer as before.
  capabilityError: (metadata, settings, hasImages) =>
    openRouterCapabilityError(metadata, settings, hasImages),

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
    const response = body as OpenRouterResponse;
    return {
      message: response.choices?.[0]?.message ?? null,
      resolvedModel: response.model ?? null,
      usage: openRouterUsage(response),
    };
  },
};
