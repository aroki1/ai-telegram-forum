/**
 * OpenCode Go model ids and the wire format each one speaks.
 *
 * The catalog (`GET /v1/models`) publishes names and nothing else — no
 * format, no context window, no capabilities — so the format is guessed from
 * the model's family and confirmed by the server, which answers an unsupported
 * format with `ModelError … not supported for format X` before it charges for
 * anything. Guess, ask, remember: that is how a catalog that gains eight
 * undocumented ids a month stays usable without a hand-maintained table.
 */

export type GoFormat = "oa-compat" | "responses";

/** OpenCode's own configs spell a Go model `opencode-go/<id>`; the API wants `<id>`. */
const GO_MODEL_ID = /^[a-z0-9][a-z0-9._:-]*$/i;
const PREFIX = "opencode-go/";

export function normalizeGoModel(raw: string): string | null {
  let value = raw.trim();
  if (!value.toLowerCase().startsWith(PREFIX)) {
    if (!value) return null;
  } else {
    value = value.slice(PREFIX.length);
  }
  if (!value || /\s/.test(value) || value.includes("/") || value.includes("\\")) return null;
  return GO_MODEL_ID.test(value) ? value : null;
}

/**
 * Which wire format a model is served over.
 *
 * Verified against the live API, not read off the docs: the docs table's "AI
 * SDK Package" column describes how OpenCode's *own* client calls a model, not
 * what the gateway accepts. `qwen3.8-max` and `minimax-m3` are both listed as
 * `@ai-sdk/anthropic` and both answer `chat/completions` with 200.
 *
 * Only the `responses`-native families refuse it — `grok-*`, `gpt-*`,
 * `muse-*` come back `503 Upstream request failed`, and without a key the
 * gateway says it outright: `ModelError … not supported for format oa-compat`.
 */
const FAMILY_RULES: Array<[RegExp, GoFormat]> = [[/^(grok|gpt|muse)-/i, "responses"]];

export function goFormatOf(model: string): GoFormat {
  for (const [family, format] of FAMILY_RULES) {
    if (family.test(model)) return format;
  }
  return "oa-compat";
}
