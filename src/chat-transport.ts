import type { ChatBody } from "./dialect.ts";
import { ChatRequestError } from "./dialect.ts";

/**
 * The HTTP half of a chat provider: retries, backoff, error envelopes.
 *
 * Endpoint, key and wording are all configuration, because OpenRouter and
 * OpenCode Go are the same protocol with different hosts — and OpenCode Go
 * answers errors in an Anthropic-shaped envelope rather than OpenAI's.
 */
export interface TransportOptions {
  apiKey: string;
  endpoint: string;
  label: string;
  /** Named in auth failures so the user knows which key to replace. */
  apiKeyName: string;
  /** Per-request headers on top of `Content-Type`. */
  headers(apiKey: string): Record<string, string>;
  /** How a failed response reads. Defaults to OpenRouter's status-based wording. */
  describeError?(ctx: TransportErrorContext): string;
  /** Constructed so a provider's own error subclass stays the thrown type. */
  createError?(message: string, status: number | null, code: string | null): ChatRequestError;
}

export interface TransportErrorContext {
  status: number;
  code: string | null;
  message: string | undefined;
}

const REQUEST_TRIES = 3;

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

export function retryAfterMs(response: Response): number {
  const raw = response.headers.get("retry-after");
  if (!raw) return 500 * 2 ** Math.max(0, response.status === 429 ? 0 : 1);
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(250, seconds * 1000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(30_000, Math.max(250, at - Date.now())) : 1000;
}

/**
 * Read `{error:{message,code}}` and `{type:"error",error:{type,message}}` alike.
 * OpenCode Go answers every route with the Anthropic envelope, `oa-compat`
 * included, so a provider can't assume its own dialect shapes its errors.
 */
function envelope(body: unknown): { message?: string; code?: string | null } {
  const record = body as Record<string, any> | null;
  const error = record?.error;
  if (typeof error === "string") return { message: error, code: null };
  if (error && typeof error === "object") {
    return {
      message: typeof error.message === "string" ? error.message : undefined,
      code:
        typeof error.code === "string"
          ? error.code
          : typeof error.type === "string"
            ? error.type
            : null,
    };
  }
  return { message: typeof record?.message === "string" ? record.message : undefined, code: null };
}

/** Status-based wording, which is exactly how OpenRouter phrases its failures. */
export function statusErrorMessage(opts: {
  label: string;
  apiKeyName: string;
}, ctx: TransportErrorContext): string {
  if (ctx.status === 401 || ctx.status === 403) {
    return `${opts.label} authorization failed: ${opts.apiKeyName} was rejected`;
  }
  if (ctx.status === 404) {
    return `${opts.label} model or endpoint was not found${ctx.message ? `: ${ctx.message}` : ""}`;
  }
  if (ctx.status === 402) {
    return `${opts.label} payment or credits error${ctx.message ? `: ${ctx.message}` : ""}`;
  }
  return `${opts.label} request failed (HTTP ${ctx.status})${ctx.message ? `: ${ctx.message}` : ""}`;
}

/** Turn a non-OK response into the error the turn will show. */
export async function transportError(
  opts: TransportOptions,
  response: Response,
): Promise<ChatRequestError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The status still gives the caller a useful error.
  }
  const { message, code } = envelope(body);
  const context: TransportErrorContext = { status: response.status, code: code ?? null, message };
  const describe = opts.describeError ?? ((ctx) => statusErrorMessage(opts, ctx));
  const make = opts.createError ?? ((m, s, c) => new ChatRequestError(m, s, c));
  return make(describe(context), response.status, context.code);
}

export class ChatTransport {
  constructor(
    private readonly opts: TransportOptions,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** Send one already-built body. Throws a `ChatRequestError` on failure. */
  async complete(body: ChatBody, signal?: AbortSignal): Promise<unknown> {
    const { apiKey, label, apiKeyName } = this.opts;
    if (!apiKey) {
      throw this.error(`${label} is unavailable: ${apiKeyName} is empty`);
    }

    for (let attempt = 0; attempt < REQUEST_TRIES; attempt++) {
      let response: Response;
      try {
        response = await this.request(this.opts.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.opts.headers(apiKey),
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (attempt + 1 >= REQUEST_TRIES) {
          throw this.error(`${label} network request failed: ${String(err)}`);
        }
        await sleep(500 * 2 ** attempt, signal);
        continue;
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw this.error(`${label} returned invalid JSON`, response.status);
        }
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt + 1 >= REQUEST_TRIES) throw await transportError(this.opts, response);
      await sleep(retryAfterMs(response), signal);
    }
    throw this.error(`${label} request failed after retries`);
  }

  private error(message: string, status: number | null = null, code: string | null = null) {
    const make = this.opts.createError ?? ((m, s, c) => new ChatRequestError(m, s, c));
    return make(message, status, code);
  }
}
