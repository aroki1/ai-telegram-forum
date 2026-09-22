import { cfg } from "./config.ts";
import type { Effort } from "./effort.ts";
import type { Model } from "./model.ts";
import { codexPresetPicker, type CodexPresetChoice } from "./preset.ts";
import {
  openRouterModelPicker,
  type OpenRouterModelChoice,
  type OpenRouterSettings,
} from "./openrouter-config.ts";
import type { PickGroup, PickValue } from "./picker.ts";
import type { Provider } from "./provider.ts";
import type { ServiceTier } from "./preset-config.ts";

export type LaunchPresetChoice =
  | { provider: "codex"; codex: CodexPresetChoice }
  | { provider: "openrouter"; chat: OpenRouterSettings }
  | { provider: "opencode-go"; chat: OpenRouterSettings };

/**
 * One launch group containing the native Codex presets and the configured
 * OpenRouter and OpenCode Go presets. Choosing a non-Codex option changes the
 * provider for the topic that is about to be created; the providers never
 * share a running session.
 *
 * `goModels` is Go's live catalog, already filtered to the formats this build
 * speaks — the caller fetches it so a stale or unreachable catalog degrades to
 * presets only instead of blocking a launch.
 */
export function launchPresetPicker(
  provider: Provider,
  modelOverride: Model | undefined,
  effortOverride: Effort | undefined,
  serviceTierOverride: ServiceTier | undefined,
  chatInitial: OpenRouterSettings | null | undefined,
  goModels: string[] = [],
): { group: PickGroup; selected(value: PickValue): LaunchPresetChoice } | undefined {
  const codex = cfg.codexPresets.length
    ? codexPresetPicker(modelOverride, effortOverride, serviceTierOverride)
    : undefined;
  const openrouter = cfg.openrouterEnabled
    ? openRouterModelPicker(chatInitial, cfg.openrouterModel, cfg.openrouterPresets, { key: "o" })
    : undefined;
  const go = cfg.goEnabled
    ? openRouterModelPicker(chatInitial, cfg.goModel, cfg.goPresets, {
        key: "g",
        models: goModels,
      })
    : undefined;
  if (!codex && !openrouter && !go) return undefined;

  const prefixed = (prefix: string, labelPrefix: string, group: PickGroup) =>
    group.options.map((option) => ({
      value: `${prefix}:${option.value}`,
      label: `${labelPrefix}${option.label.replace(/^🎛️\s*/, "")}`,
    }));

  const options = [
    ...(codex ? prefixed("codex", "⚙️ ", codex.group) : []),
    ...(openrouter ? prefixed("openrouter", "🌐 ", openrouter.group) : []),
    ...(go ? prefixed("opencodego", "⚡ ", go.group) : []),
  ];

  const groupFor = (value: Provider) =>
    value === "openrouter" ? openrouter : value === "opencode-go" ? go : codex;
  const preferred = groupFor(provider) ?? codex ?? openrouter ?? go!;
  const fallbackGroup = codex ?? openrouter ?? go!;
  const prefixOf = (group: typeof preferred) =>
    group === openrouter ? "openrouter" : group === go ? "opencodego" : "codex";

  const initial = `${prefixOf(preferred)}:${preferred.group.initial ?? preferred.group.fallback}`;
  const fallback = `${prefixOf(fallbackGroup)}:${fallbackGroup.group.fallback}`;

  const selected = (value: PickValue): LaunchPresetChoice => {
    const picked = value ?? initial;
    const separator = picked.indexOf(":");
    const prefix = separator < 0 ? "" : picked.slice(0, separator);
    const inner = separator < 0 ? "" : picked.slice(separator + 1);
    if (prefix === "openrouter" && openrouter) {
      const choice: OpenRouterModelChoice = openrouter.selected(inner);
      return { provider: "openrouter", chat: choice.settings };
    }
    if (prefix === "opencodego" && go) {
      const choice: OpenRouterModelChoice = go.selected(inner);
      return { provider: "opencode-go", chat: choice.settings };
    }
    if (codex) return { provider: "codex", codex: codex.selected(inner) };
    // Whichever chat provider is left is the only one that can be meant.
    const choice = go!.selected(inner);
    return { provider: "opencode-go", chat: choice.settings };
  };

  const summaryLabel = (choice: LaunchPresetChoice, key: string): string => {
    if (choice.provider === "codex") return `⚙️ Codex · ${codex!.group.summary(key)}`;
    const group = choice.provider === "openrouter" ? openrouter! : go!;
    return choice.provider === "openrouter"
      ? `🌐 OpenRouter · ${group.group.summary(key)}`
      : `⚡ OpenCode Go · ${group.group.summary(key)}`;
  };

  return {
    group: {
      key: "r",
      options,
      perRow: 2,
      initial,
      fallback,
      summary: (value) => summaryLabel(selected(value), value ?? initial),
    },
    selected,
  };
}
