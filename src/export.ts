import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ChatMessage } from "./chat-message.ts";
import { cfg } from "./config.ts";

/**
 * `/export` — the topic's transcript as Markdown.
 *
 * Claude and Codex keep their own transcripts on disk, in formats their CLIs
 * can reopen, which is what `/resume` and `/telegramify` are for. A chat
 * provider has no CLI and no provider-side record: the append-only JSONL the
 * bot wrote *is* the conversation. This is the portable form of it — the repo's
 * standing rule is that a transcript is the user's work and outlives the topic
 * it happened to be pointed at.
 */

const roleHeading: Record<string, string> = {
  user: "👤 User",
  assistant: "🤖 Assistant",
  tool: "🔧 Tool result",
};

function fenced(text: string): string {
  // A transcript can contain fences of its own; widen the outer one instead of
  // letting the content close it.
  const longest = Math.max(0, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!message.content) return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : `_[image]_`))
    .join("\n");
}

export interface TranscriptHeader {
  title: string;
  provider: string;
  model: string;
  sessionId: string;
  exportedAt: Date;
}

export function transcriptMarkdown(messages: ChatMessage[], header: TranscriptHeader): string {
  const body: string[] = [];
  let turns = 0;

  for (const message of messages) {
    // The agent's system prompt is the bot's plumbing, not the conversation.
    if (message.role === "system") continue;
    const heading = roleHeading[message.role] ?? message.role;
    const text = textOf(message).trim();
    const calls = message.tool_calls ?? [];
    if (!text && !calls.length) continue;

    if (message.role === "assistant") turns++;
    body.push(`## ${heading}`);
    if (text) body.push(text);
    for (const call of calls) {
      body.push(`**${call.function.name}**`);
      body.push(fenced(call.function.arguments));
    }
    body.push("");
  }

  return [
    `# ${header.title}`,
    "",
    `- agent: ${header.provider}`,
    `- model: ${header.model}`,
    `- session: \`${header.sessionId}\``,
    `- turns: ${turns}`,
    `- exported: ${header.exportedAt.toISOString()}`,
    "",
    "---",
    "",
    ...body,
  ].join("\n");
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return cleaned || "topic";
}

/** Write the export and return its path, or null when there is nothing to write. */
export function writeTranscript(
  markdown: string,
  title: string,
  sessionId: string,
): string {
  const dir = resolve(cfg.inboxPath, "exports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${safeName(title)}-${safeName(sessionId).slice(0, 8)}.md`);
  writeFileSync(path, markdown, "utf8");
  return path;
}
