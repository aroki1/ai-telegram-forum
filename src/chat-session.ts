import { randomUUID } from "node:crypto";
import type { Bot } from "grammy";
import type {
  AgentInput,
  AgentSession,
  AgentSessionHooks,
  AgentSettings,
  AgentSideResult,
} from "./agent-session.ts";
import { cfg } from "./config.ts";
import type { Usage } from "./claude.ts";
import { cloneMessages, formatError, runAgentLoop, type LoopResult } from "./agent-loop.ts";
import type { ChatClient, Dialect, TurnSettings } from "./dialect.ts";
import type { ChatMessage } from "./chat-message.ts";
import { JsonlHistory } from "./chat-history.ts";
import type { ChatSettings } from "./openrouter-config.ts";
import { OPENROUTER_TOOLS, TELEGRAM_PUBLISH_TOOL } from "./openrouter-tools.ts";
import { TG_SEND_TOOL, type TgChannel } from "./tg-tools.ts";

const SYSTEM_PROMPT = `${
  `You are an agent working in a local repository and talking to a person over Telegram.\n\n` +
  `Use Read, Glob, Grep, Edit, Write, and Bash to inspect and change the working tree. ` +
  `Use ${TG_SEND_TOOL} for every complete message intended for the person. ` +
  (cfg.telegramPublisherEnabled
    ? `Use ${TELEGRAM_PUBLISH_TOOL} only when explicitly asked to publish to the configured Telegram channel. ` +
      `Every post requires the owner's approval; do not publish a draft or an ordinary answer. `
    : "") +
  `Your ordinary response text is only a fallback and is not delivered when a Telegram message was sent. ` +
  `Never send partial thoughts; batch related information into one finished message. ` +
  `Keep tool output and shell commands focused, and do not use tables in Telegram.\n\n`
}`;

/**
 * Everything about a chat provider that is not its wire format: where the
 * transcript goes, how long a turn may run, what it costs per step.
 *
 * The same tools, prompt and permission flow serve every one of them, which is
 * the whole point of the {@link Dialect} split underneath.
 */
export interface ChatProvider {
  dialect: Dialect;
  /**
   * Resolve by model when one provider spans formats — OpenCode Go serves
   * most of its catalog over `chat/completions` and the `responses` families
   * over their own. Null means this build cannot speak that model at all.
   */
  dialectFor?(model: string): Dialect | null;
  /** What to tell the topic when {@link dialectFor} comes back null. */
  unsupported?(model: string): string;
  /** Built per session so a host can be handed this topic's id. */
  client(ctx: { sessionId: () => string | null }): ChatClient;
  defaultModel: string;
  historyRoot: string;
  maxSteps: number;
  turnTimeoutMs: number;
  maxToolOutput: number;
}

interface LoopOptions {
  signal: AbortSignal;
  deliverTelegram: boolean;
  persist: boolean;
  onTool: (name: string, input: unknown) => void | Promise<void>;
  onModel?: (model: string) => void;
  onText?: (text: string) => void;
}

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

function chatSettings(settings: AgentSettings): ChatSettings {
  return settings.chat ?? { model: settings.model };
}

/**
 * What the next request will say, before any message is chosen. `reasoning`
 * stays as the preset wrote it — how `/effort` folds into it is the dialect's
 * business, and the capability check wants to see the preset.
 */
export function chatTurnSettings(settings: AgentSettings, defaultModel: string): TurnSettings {
  const picked = chatSettings(settings);
  const model = picked.model ?? defaultModel;
  const fallbacks = picked.fallbacks ?? [];
  return {
    model,
    ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
    ...(picked.temperature === undefined ? {} : { temperature: picked.temperature }),
    ...(picked.maxTokens === undefined ? {} : { maxTokens: picked.maxTokens }),
    ...(picked.reasoning === undefined ? {} : { reasoning: picked.reasoning }),
    effort: settings.effort,
    ...(picked.provider === undefined ? {} : { provider: { ...picked.provider } }),
  };
}

/** One topic's live runner over a chat provider. Owns the lifecycle, not the turn. */
export class ChatAgentSession implements AgentSession {
  private pending: AgentInput[] = [];
  private history: JsonlHistory | null = null;
  private running = false;
  private closed = false;
  private turnActive = false;
  private stopped = false;
  private timedOut = false;
  private abort: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private startWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  private settings: AgentSettings;
  private readonly client: ChatClient;

  constructor(
    private readonly opts: {
      bot: Bot;
      threadId: number;
      cwd: string;
      channel: TgChannel;
      hooks: AgentSessionHooks;
    } & AgentSettings,
    private readonly provider: ChatProvider,
  ) {
    this.settings = {
      sessionId: opts.sessionId,
      effort: opts.effort,
      model: opts.model,
      serviceTier: opts.serviceTier,
      chat: opts.chat,
    };
    this.client = provider.client({ sessionId: () => this.settings.sessionId });
  }

  get controlQuery(): null {
    return null;
  }

  async send(input: AgentInput): Promise<void> {
    this.pending.push(input);
    if (this.running) return;
    let resolveStart!: () => void;
    const promise = new Promise<void>((resolve) => (resolveStart = resolve));
    this.startWaiter = { promise, resolve: resolveStart };
    void this.run();
    await promise;
  }

  async btw(input: AgentInput, onTool: (name: string) => void): Promise<AgentSideResult> {
    const history = await this.ensureHistory();
    const controller = new AbortController();
    const base = cloneMessages(history.ensureSystem(SYSTEM_PROMPT));
    const result = await this.runLoop(base, input, {
      signal: controller.signal,
      deliverTelegram: false,
      persist: false,
      onTool: (name) => onTool(name),
    });
    return {
      ok: result.ok,
      usage: result.usage,
      failure: result.failure,
      stopped: result.stopped,
      sent: 0,
      answer: result.answer,
      resolvedModel: result.resolvedModel,
    };
  }

  async interrupt(): Promise<boolean> {
    if (!this.turnActive || !this.abort) return false;
    this.stopped = true;
    this.abort.abort(new Error(`${this.provider.dialect.label} turn stopped by the user`));
    return true;
  }

  async applySettings(settings: AgentSettings): Promise<void> {
    this.settings = { ...settings };
  }

  async suggestTitle(): Promise<string | null> {
    return null;
  }

  close(): void {
    this.closed = true;
    this.abort?.abort(new Error(`${this.provider.dialect.label} session closed`));
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
  }

  private async ensureHistory(): Promise<JsonlHistory> {
    if (!this.settings.sessionId) {
      const id = randomUUID();
      this.settings.sessionId = id;
      this.opts.hooks.session(id);
    }
    return (this.history ??= new JsonlHistory(this.settings.sessionId, this.provider.historyRoot));
  }

  private async beginTurn(): Promise<void> {
    this.turnActive = true;
    this.stopped = false;
    this.timedOut = false;
    this.opts.channel.resetSent();
    this.abort = new AbortController();
    const controller = this.abort;
    this.timeout = setTimeout(() => {
      this.timedOut = true;
      controller.abort(new Error(`${this.provider.dialect.label} turn timed out`));
    }, this.provider.turnTimeoutMs);
    try {
      await this.opts.hooks.beginTurn();
    } catch (err) {
      clearTimeout(this.timeout);
      this.timeout = null;
      this.abort = null;
      this.turnActive = false;
      throw err;
    }
  }

  private async finish(result: LoopResult): Promise<void> {
    const stopped = this.stopped || result.stopped;
    const label = this.provider.dialect.label;
    const failure = this.timedOut
      ? `⏱️ ${label} turn exceeded ${Math.round(this.provider.turnTimeoutMs / 60_000)} minutes`
      : result.failure;
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
    this.abort = null;
    this.turnActive = false;
    await this.opts.hooks.endTurn({
      ok: result.ok && !failure,
      usage: result.usage,
      failure,
      stopped,
      sent: this.opts.channel.sent,
      resolvedModel: result.resolvedModel,
    });
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (!this.closed && this.pending.length) {
        const batch = this.pending.splice(0);
        const input: AgentInput = {
          text: batch.map((item) => item.text).filter(Boolean).join("\n\n"),
          images: batch.flatMap((item) => item.images),
        };
        try {
          await this.beginTurn();
        } finally {
          this.startWaiter?.resolve();
          this.startWaiter = null;
        }
        let result: LoopResult;
        try {
          const history = await this.ensureHistory();
          const messages = history.ensureSystem(SYSTEM_PROMPT);
          result = await this.runLoop(messages, input, {
            signal: this.abort!.signal,
            deliverTelegram: true,
            persist: true,
            onTool: (name, toolInputValue) => this.opts.hooks.tool(name, toolInputValue),
            onModel: (model) => this.opts.hooks.model?.(model),
            onText: (text) => this.opts.hooks.text(text),
          });
        } catch (err) {
          const label = this.provider.dialect.label;
          result = {
            ok: false,
            failure:
              this.stopped || this.abort?.signal.aborted ? null : formatError(err, label),
            stopped: this.stopped || Boolean(this.abort?.signal.aborted),
            usage: zeroUsage(),
            answer: "",
            resolvedModel: null,
          };
          if (result.failure) console.error(`[${label}:${this.opts.threadId}] session failed:`, err);
        }
        await this.finish(result);
      }
    } finally {
      this.startWaiter?.resolve();
      this.startWaiter = null;
      this.running = false;
      this.abort = null;
      if (!this.closed && this.pending.length) void this.run();
    }
  }

  /**
   * Hand the turn to the dialect-free runner; this class only owns its
   * lifecycle. A model whose format this build lacks never reaches the wire —
   * it comes back as a turn failure, so the topic is told and nothing is
   * retried against an endpoint that will only refuse it.
   */
  private async runLoop(
    initialMessages: ChatMessage[],
    input: AgentInput,
    options: LoopOptions,
  ): Promise<LoopResult> {
    const settings = chatTurnSettings(this.settings, this.provider.defaultModel);
    const model = settings.model ?? this.provider.defaultModel;
    const dialect = this.provider.dialectFor
      ? this.provider.dialectFor(model)
      : this.provider.dialect;
    if (!dialect) {
      // Nothing was sent, so nothing was spent — the topic is told why and the
      // transport never retries against an endpoint that only refuses.
      return {
        ok: false,
        failure:
          this.provider.unsupported?.(model) ??
          `❌ ${model} needs a wire format this build does not speak`,
        stopped: false,
        usage: zeroUsage(),
        answer: "",
        resolvedModel: null,
      };
    }

    return runAgentLoop({
      dialect,
      client: this.client,
      settings,
      initialMessages,
      input,
      tools: OPENROUTER_TOOLS,
      maxSteps: this.provider.maxSteps,
      maxToolOutput: this.provider.maxToolOutput,
      signal: options.signal,
      deliverTelegram: options.deliverTelegram,
      history: options.persist ? await this.ensureHistory() : null,
      toolContext: {
        bot: this.opts.bot,
        threadId: this.opts.threadId,
        cwd: this.opts.cwd,
        channel: this.opts.channel,
      },
      onTool: options.onTool,
      onModel: options.onModel,
      onText: options.onText,
    });
  }
}
