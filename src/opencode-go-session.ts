import type { Bot } from "grammy";
import type { AgentSession, AgentSessionHooks, AgentSettings } from "./agent-session.ts";
import { ChatAgentSession, type ChatProvider } from "./chat-session.ts";
import { cfg } from "./config.ts";
import { OpenCodeGoClient, goDialectFor, goUnsupportedMessage, openCodeGoDialect } from "./opencode-go.ts";
import type { TgChannel } from "./tg-tools.ts";

/**
 * The OpenCode Go configuration of the shared chat session.
 *
 * Its transcript lives apart from OpenRouter's, and its client is built per
 * session because `x-opencode-session` — mandatory, and stable for a whole
 * conversation — is this topic's own session id.
 */
export const openCodeGoProvider: ChatProvider = {
  dialect: openCodeGoDialect,
  dialectFor: (model) => goDialectFor(model),
  unsupported: (model) => goUnsupportedMessage(model),
  client: (ctx) => new OpenCodeGoClient(ctx.sessionId),
  defaultModel: cfg.goModel,
  historyRoot: cfg.goHistoryPath,
  maxSteps: cfg.goMaxSteps,
  turnTimeoutMs: cfg.goTurnTimeoutMs,
  maxToolOutput: cfg.goMaxToolOutput,
};

export class OpenCodeGoAgentSession extends ChatAgentSession {
  constructor(
    opts: {
      bot: Bot;
      threadId: number;
      cwd: string;
      channel: TgChannel;
      hooks: AgentSessionHooks;
    } & AgentSettings,
  ) {
    super(opts, openCodeGoProvider);
  }
}

export type { AgentSession };
