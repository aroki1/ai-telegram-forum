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
import {
  cloneMessages,
  formatError,
  runAgentLoop,
  type LoopResult,
} from "./agent-loop.ts";
import type { TurnSettings } from "./dialect.ts";
import { OpenRouterClient, openRouterDialect, type OpenRouterMessage } from "./openrouter.ts";
import { OpenRouterHistory } from "./openrouter-history.ts";
import type { OpenRouterSettings } from "./openrouter-config.ts";
import { OPENROUTER_TOOLS } from "./openrouter-tools.ts";
import { TG_SEND_TOOL, type TgChannel } from "./tg-tools.ts";

const SYSTEM_PROMPT = `${
  `You are an agent working in a local repository and talking to a person over Telegram.\n\n` +
  `Use Read, Glob, Grep, Edit, Write, and Bash to inspect and change the working tree. ` +
  `Use ${TG_SEND_TOOL} for every complete message intended for the person. ` +
  `Your ordinary response text is only a fallback and is not delivered when a Telegram message was sent. ` +
  `Never send partial thoughts; batch related information into one finished message. ` +
  `Keep tool output and shell commands focused, and do not use tables in Telegram.\n\n`
}`;

interface LoopOptions {
  signal: AbortSignal;
  deliverTelegram: boolean;
  persist: boolean;
  onTool: (name: string, input: unknown) => void | Promise<void>;
  onModel?: (model: string) => void;
  onText?: (text: string) => void;
}

const zeroUsage = (): Usage => ({ inTokens: 0, outTokens: 0, costUsd: 0 });

function requestSettings(settings: AgentSettings): OpenRouterSettings {
  return settings.openrouter ?? { model: settings.model };
}

export class OpenRouterAgentSession implements AgentSession {
  private pending: AgentInput[] = [];
  private history: OpenRouterHistory | null = null;
  private running = false;
  private closed = false;
  private turnActive = false;
  private stopped = false;
  private timedOut = false;
  private abort: AbortController | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private startWaiter: { promise: Promise<void>; resolve: () => void } | null = null;
  private settings: AgentSettings;
  private readonly client: OpenRouterClient;

  constructor(private readonly opts: {
    bot: Bot;
    threadId: number;
    cwd: string;
    channel: TgChannel;
    hooks: AgentSessionHooks;
  } & AgentSettings) {
    this.settings = {
      sessionId: opts.sessionId,
      effort: opts.effort,
      model: opts.model,
      serviceTier: opts.serviceTier,
      openrouter: opts.openrouter,
    };
    this.client = new OpenRouterClient();
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
    this.abort.abort(new Error("OpenRouter turn stopped by the user"));
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
    this.abort?.abort(new Error("OpenRouter session closed"));
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = null;
  }

  private async ensureHistory(): Promise<OpenRouterHistory> {
    if (!this.settings.sessionId) {
      const id = randomUUID();
      this.settings.sessionId = id;
      this.opts.hooks.session(id);
    }
    return (this.history ??= new OpenRouterHistory(this.settings.sessionId));
  }

  /**
   * What this topic's next request will say, before any message is chosen.
   * `reasoning` stays as the preset wrote it — how `/effort` folds into it is
   * the dialect's business, and the capability check wants to see the preset.
   */
  private turnSettings(): TurnSettings {
    const settings = requestSettings(this.settings);
    const model = settings.model ?? cfg.openrouterModel;
    const fallbacks = settings.fallbacks ?? [];
    return {
      model,
      ...(fallbacks.length ? { models: [model, ...fallbacks] } : {}),
      ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
      ...(settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens }),
      ...(settings.reasoning === undefined ? {} : { reasoning: settings.reasoning }),
      effort: this.settings.effort,
      ...(settings.provider === undefined ? {} : { provider: { ...settings.provider } }),
    };
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
      controller.abort(new Error("OpenRouter turn timed out"));
    }, cfg.openrouterTurnTimeoutMs);
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
    const failure = this.timedOut
      ? `⏱️ OpenRouter turn exceeded ${Math.round(cfg.openrouterTurnTimeoutMs / 60_000)} minutes`
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
          result = {
            ok: false,
            failure:
              this.stopped || this.abort?.signal.aborted
                ? null
                : formatError(err, openRouterDialect.label),
            stopped: this.stopped || Boolean(this.abort?.signal.aborted),
            usage: zeroUsage(),
            answer: "",
            resolvedModel: null,
          };
          if (result.failure) console.error(`[openrouter:${this.opts.threadId}] session failed:`, err);
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

  /** Hand the turn to the dialect-free runner; this class only owns its lifecycle. */
  private async runLoop(
    initialMessages: OpenRouterMessage[],
    input: AgentInput,
    options: LoopOptions,
  ): Promise<LoopResult> {
    return runAgentLoop({
      dialect: openRouterDialect,
      client: this.client,
      settings: this.turnSettings(),
      initialMessages,
      input,
      tools: OPENROUTER_TOOLS,
      maxSteps: cfg.openrouterMaxSteps,
      maxToolOutput: cfg.openrouterMaxToolOutput,
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
