import type { Bot } from "grammy";
import type { AgentSession, AgentSessionHooks, AgentSettings } from "./agent-session.ts";
import { ChatAgentSession, type ChatProvider } from "./chat-session.ts";
import { cfg } from "./config.ts";
import { OpenRouterClient, openRouterDialect } from "./openrouter.ts";
import type { TgChannel } from "./tg-tools.ts";

/**
 * The OpenRouter configuration of the shared chat session. Kept under its own
 * name because `/telegramify` and the tests construct it directly, and because
 * an OpenRouter topic's transcript predates the split and lives at its own
 * path — which is what `historyRoot` pins.
 */
export const openRouterProvider: ChatProvider = {
  dialect: openRouterDialect,
  client: () => new OpenRouterClient(),
  defaultModel: cfg.openrouterModel,
  historyRoot: cfg.openrouterHistoryPath,
  maxSteps: cfg.openrouterMaxSteps,
  turnTimeoutMs: cfg.openrouterTurnTimeoutMs,
  maxToolOutput: cfg.openrouterMaxToolOutput,
};

export class OpenRouterAgentSession extends ChatAgentSession {
  constructor(
    opts: {
      bot: Bot;
      threadId: number;
      cwd: string;
      channel: TgChannel;
      hooks: AgentSessionHooks;
    } & AgentSettings,
  ) {
    super(opts, openRouterProvider);
  }
}

export type { ChatAgentSession };
