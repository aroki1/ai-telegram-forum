import type { PickGroup, PickValue } from "./picker.ts";

export type Provider = "claude" | "codex" | "openrouter" | "opencode-go";

const PROVIDERS: readonly string[] = ["claude", "codex", "openrouter", "opencode-go"];

export function parseProvider(raw: string): Provider | undefined {
  const value = raw.trim().toLowerCase();
  return (PROVIDERS as readonly string[]).includes(value) ? (value as Provider) : undefined;
}

export const providerLabel = (provider: Provider): string =>
  provider === "codex"
    ? "Codex"
    : provider === "openrouter"
      ? "OpenRouter"
      : provider === "opencode-go"
        ? "OpenCode Go"
        : "Claude";

export const asProvider = (value: PickValue, fallback: Provider): Provider =>
  parseProvider(value ?? "") ?? fallback;

/**
 * Providers whose model choice is a preset-shaped settings blob rather than a
 * plain id — they store it in the `openrouter_settings` column and pick it
 * from a configured preset list.
 */
export const usesChatSettings = (provider: Provider): boolean =>
  provider === "openrouter" || provider === "opencode-go";

export function providerGroup(
  initial: Provider,
  fallback: Provider,
  enabled: { openrouter?: boolean; opencodeGo?: boolean } = {},
): PickGroup {
  const options = [
    { value: "claude", label: "Claude" },
    { value: "codex", label: "Codex" },
    ...(enabled.openrouter ? [{ value: "openrouter", label: "OpenRouter" }] : []),
    ...(enabled.opencodeGo ? [{ value: "opencode-go", label: "OpenCode Go" }] : []),
  ];
  return {
    key: "p",
    options,
    // Two and three sit on one row; four reads better as a 2×2 grid than as
    // three buttons and an orphan underneath them.
    perRow: options.length <= 3 ? options.length : 2,
    initial,
    fallback,
    summary: (value) => `🧠 agent: ${providerLabel(asProvider(value, fallback))}`,
  };
}
