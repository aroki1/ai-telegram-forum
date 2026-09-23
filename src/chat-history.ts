import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatMessage } from "./chat-message.ts";
import { cfg } from "./config.ts";
import type { Provider } from "./provider.ts";

/** Append-only agent transcript. The topic database keeps only its id. */
export class JsonlHistory {
  readonly path: string;

  constructor(readonly sessionId: string, root: string) {
    this.path = join(root, `${sessionId}.jsonl`);
  }

  messages(): ChatMessage[] {
    if (!existsSync(this.path)) return [];
    const messages: ChatMessage[] = [];
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { message?: ChatMessage };
          if (event.message?.role) messages.push(event.message);
        } catch {
          console.warn(`[chat] ignoring malformed history line in ${this.path}`);
        }
      }
    } catch (err) {
      throw new Error(`couldn't read agent history: ${String(err)}`);
    }
    return messages;
  }

  append(message: ChatMessage): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ message })}\n`, "utf8");
  }

  ensureSystem(content: string): ChatMessage[] {
    const messages = this.messages();
    if (!messages.some((message) => message.role === "system")) {
      const system: ChatMessage = { role: "system", content };
      this.append(system);
      messages.unshift(system);
    }
    return messages;
  }
}

/** OpenRouter topics predate the shared transcript store and keep their path. */
export const openRouterHistory = (sessionId: string): JsonlHistory =>
  new JsonlHistory(sessionId, cfg.openrouterHistoryPath);

export const goHistory = (sessionId: string): JsonlHistory =>
  new JsonlHistory(sessionId, cfg.goHistoryPath);

/** A chat provider's transcript root, by provider. */
export const historyRootFor = (provider: Provider): string =>
  provider === "opencode-go" ? cfg.goHistoryPath : cfg.openrouterHistoryPath;

export const historyFor = (provider: Provider, sessionId: string): JsonlHistory =>
  new JsonlHistory(sessionId, historyRootFor(provider));
