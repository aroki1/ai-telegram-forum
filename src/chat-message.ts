/**
 * The provider-neutral record of one message, and the shape every agent
 * transcript on disk is written in.
 *
 * It is deliberately the OpenAI `chat/completions` shape. That is the dialect
 * OpenRouter speaks natively, so append-only history under `data/` written
 * before this type existed keeps parsing untouched, and a dialect that speaks
 * something else — Anthropic `messages`, OpenAI `responses` — converts into
 * this on read and back on write.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content?: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
  /**
   * Round-trip state a normalized message cannot express: `reasoning` items
   * the `responses` dialect must echo back, `cache_control` breakpoints for
   * `messages`.
   *
   * A cache, never the truth. The fields above are canonical, `wire` only has
   * to survive being replayed to the same dialect, and a topic whose `/model`
   * crosses into another format drops it on the way across.
   */
  wire?: unknown;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
