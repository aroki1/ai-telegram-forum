import { cfg } from "./config.ts";
import type { TransportOptions } from "./chat-transport.ts";
import { ChatTransport, transportError } from "./chat-transport.ts";
import { oaCompatDialect, oaCompatUsage, type OaCompatResponse } from "./dialect-oa-compat.ts";
import type { ChatBody, ModelMetadata } from "./dialect.ts";
import { ChatRequestError } from "./dialect.ts";
import type { ChatContentPart, ChatMessage, ChatToolCall, ToolSpec } from "./chat-message.ts";
import type { OpenRouterProviderPreferences } from "./openrouter-config.ts";

// The wire names are kept as aliases rather than definitions: OpenRouter
// speaks `chat/completions` natively, so its messages *are* the normalized
// transcript, and history written before the split keeps parsing.
export type OpenRouterContentPart = ChatContentPart;
export type OpenRouterToolCall = ChatToolCall;
export type OpenRouterMessage = ChatMessage;
export type OpenRouterTool = ToolSpec;
export type OpenRouterResponse = OaCompatResponse;
export type OpenRouterModelMetadata = ModelMetadata;

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

export class OpenRouterError extends ChatRequestError {
  constructor(message: string, status: number | null = null, code: string | null = null) {
    super(message, status, code);
    this.name = "OpenRouterError";
  }
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const CATALOG_ENDPOINT = "https://openrouter.ai/api/v1/models";

const TRANSPORT: Omit<TransportOptions, "apiKey"> = {
  endpoint: ENDPOINT,
  label: "OpenRouter",
  apiKeyName: "OPENROUTER_API_KEY",
  headers: (apiKey) => ({
    Authorization: `Bearer ${apiKey}`,
    "X-OpenRouter-Title": "ai-telegram-forum",
  }),
  createError: (message, status, code) => new OpenRouterError(message, status, code),
};

export class OpenRouterClient extends ChatTransport {
  constructor(apiKey: string = cfg.openrouterApiKey, request: typeof fetch = fetch) {
    super({ ...TRANSPORT, apiKey }, request);
  }
}

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
      if (!response.ok) throw await transportError({ ...TRANSPORT, apiKey }, response);
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

/** OpenRouter reports dollars in `usage.cost`; this is the shared parser. */
export const openRouterUsage = oaCompatUsage;

/** OpenRouter's wire format: `chat/completions` plus its own extras. */
export const openRouterDialect = oaCompatDialect({
  label: "OpenRouter",
  defaultContextWindow: cfg.openrouterContextWindow,
  metadata: (model) => openRouterModelMetadata(model),
  capabilityError: (metadata, settings, hasImages) =>
    openRouterCapabilityError(metadata, settings, hasImages),
});

// `ChatBody` is the transport's input; re-exported here so a caller building
// an OpenRouter request does not have to reach past this module for it.
export type OpenRouterBody = ChatBody;
