import { readFileSync } from "node:fs";
import { cfg } from "./config.ts";
import type { TransportErrorContext, TransportOptions } from "./chat-transport.ts";
import { ChatTransport, statusErrorMessage } from "./chat-transport.ts";
import { oaCompatDialect } from "./dialect-oa-compat.ts";
import type { Dialect } from "./dialect.ts";
import { goFormatOf, normalizeGoModel, type GoFormat } from "./go-model.ts";

/**
 * OpenCode Go: a `$10/month` subscription behind `https://opencode.ai/zen/go`.
 *
 * Verified against the live API rather than assumed from the docs, which lag
 * the catalog: the model list is public but publishes names only, and the wire
 * format is enforced by the server with a free, unambiguous error naming it.
 */

const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const USER_AGENT = `ai-telegram-forum/${VERSION}`;
const AUTH = { label: "OpenCode Go", apiKeyName: "OPENCODE_GO_API_KEY" } as const;

/**
 * Go answers errors in the Anthropic envelope on every route — `oa-compat`
 * included — and grades them by `error.type`, not by status: a wrong-format
 * request comes back `401 ModelError`, which must not read as a bad key.
 */
function describeError(ctx: TransportErrorContext): string {
  const detail = ctx.message ? `: ${ctx.message}` : "";
  switch (ctx.code) {
    case "AuthError":
      return `${AUTH.label} authorization failed: ${AUTH.apiKeyName} was rejected${detail}`;
    case "ModelError":
      return `${AUTH.label} model error${detail}`;
    case "MissingSessionID":
      return `${AUTH.label} rejected the request: x-opencode-session was missing${detail}`;
    default:
      return statusErrorMessage(AUTH, ctx);
  }
}

/**
 * The client a topic's session holds. `x-opencode-session` is mandatory (a
 * request without it is a 400) and must stay stable for the life of a
 * conversation, so it is read live from the topic's own session id rather than
 * fixed at construction — the id only exists after the first turn.
 */
export class OpenCodeGoClient extends ChatTransport {
  constructor(sessionId: () => string | null, request: typeof fetch = fetch) {
    super(
      {
        ...transportOptions(sessionId),
        apiKey: cfg.goApiKey,
      },
      request,
    );
  }
}

export function transportOptions(
  sessionId?: () => string | null,
): Omit<TransportOptions, "apiKey"> {
  return {
    endpoint: `${cfg.goBaseUrl}/chat/completions`,
    label: AUTH.label,
    apiKeyName: AUTH.apiKeyName,
    describeError,
    headers: (apiKey) => {
      const id = sessionId?.() ?? null;
      return {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": USER_AGENT,
        ...(id ? { "x-opencode-session": id } : {}),
      };
    },
  };
}

/** The `oa-compat` dialect: no catalog, so no capability guesses. */
export const openCodeGoDialect: Dialect = oaCompatDialect({
  label: AUTH.label,
  defaultContextWindow: cfg.goContextWindow,
});

/**
 * Resolve the dialect a Go model speaks, or null when this build has no
 * transport for that format. The family rule above is the cold start; a
 * refusal is worth remembering against the model id rather than re-guessing
 * every turn, which is what the profile cache in a later commit is for.
 */
export function goDialectFor(model: string): Dialect | null {
  return goFormatOf(model) === "oa-compat" ? openCodeGoDialect : null;
}

export const goFormat = (model: string): GoFormat => goFormatOf(model);

/** What a topic is told when its model needs a format we do not speak yet. */
export function goUnsupportedMessage(model: string): string {
  return (
    `❌ \`${model}\` is served over OpenAI's \`responses\` format — Grok, GPT-5.6 Luna ` +
    `and Muse are the only Go models that are — and this bot does not speak it yet. ` +
    `Everything else on your subscription works: GLM, Kimi, Qwen, DeepSeek, MiniMax, ` +
    `MiMo, LongCat, Hy.`
  );
}

let catalog: { expiresAt: number; ids: string[] } | null = null;

/**
 * Model ids from `GET /v1/models` — public, names only, and already listing
 * ids the docs table omits. Advisory: a failure falls back to the configured
 * default so a picker never comes up empty.
 */
export async function ensureGoModels(): Promise<string[]> {
  if (catalog && catalog.expiresAt > Date.now()) return catalog.ids;
  try {
    const response = await fetch(`${cfg.goBaseUrl}/models`, {
      headers: {
        ...(cfg.goApiKey ? { Authorization: `Bearer ${cfg.goApiKey}` } : {}),
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (body.data ?? [])
      .map((row) => (typeof row.id === "string" ? row.id : ""))
      .filter((id) => normalizeGoModel(id) !== null);
    if (ids.length) {
      catalog = { expiresAt: Date.now() + 5 * 60_000, ids };
      return ids;
    }
    throw new Error("catalog was empty");
  } catch (err) {
    console.warn(`[opencode-go] model catalog unavailable: ${String(err)}`);
    return catalog?.ids ?? [cfg.goModel];
  }
}

/** The subset a topic can actually run on — everything else is a dead end. */
export async function runnableGoModels(): Promise<string[]> {
  return (await ensureGoModels()).filter((id) => goFormatOf(id) === "oa-compat");
}
