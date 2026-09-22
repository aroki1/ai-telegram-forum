import type { OpenRouterPresetConfig } from "./openrouter-config.ts";
import { presetSettings, type OpenRouterSettings } from "./openrouter-config.ts";
import { normalizeGoModel } from "./go-model.ts";

/**
 * `OPENCODE_GO_PRESETS` — same button-labelled shape as `OPENROUTER_PRESETS`,
 * minus the two knobs a subscription has no say in: one Go request names one
 * model, and Go picks its own upstream.
 */

const MODEL_LABEL = /^[^\s]{1,40}$/;

function model(name: string, where: string): string {
  const value = normalizeGoModel(name);
  if (!value) throw new Error(`${where} is not a valid OpenCode Go model id`);
  return value;
}

function optionalNumber(
  item: Record<string, unknown>,
  key: string,
  where: string,
  integer = false,
): number | undefined {
  const value = item[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new Error(`${where}.${key} must be a finite${integer ? " integer" : " number"}`);
  }
  if (key === "max_tokens" && value <= 0) throw new Error(`${where}.max_tokens must be positive`);
  return value;
}

function parsePreset(name: string, value: unknown): OpenRouterPresetConfig {
  const where = `OPENCODE_GO_PRESETS[${name}]`;
  if (!name.trim() || name.length > 40 || !MODEL_LABEL.test(name)) {
    throw new Error("OPENCODE_GO_PRESETS labels must contain 1–40 non-space characters");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  const item = value as Record<string, unknown>;
  if (item.fallbacks !== undefined || item.models !== undefined) {
    throw new Error(`${where} has no fallbacks: OpenCode Go serves one model per request`);
  }
  if (item.provider !== undefined || item.provider_preferences !== undefined) {
    throw new Error(`${where} has no provider preferences: OpenCode Go chooses its own upstream`);
  }
  return {
    name,
    model: model(typeof item.model === "string" ? item.model : "", `${where}.model`),
    temperature: optionalNumber(item, "temperature", where),
    maxTokens: optionalNumber(item, "max_tokens", where, true),
    reasoning: item.reasoning === null ? undefined : item.reasoning,
  };
}

/** Parse `{ "Cheap": { "model": "glm-5.3-flash" } }`. */
export function parseGoPresets(raw: string | undefined): OpenRouterPresetConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OPENCODE_GO_PRESETS is not valid JSON: ${raw}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENCODE_GO_PRESETS must be a JSON object keyed by button label");
  }
  const presets = Object.entries(parsed).map(([name, value]) => parsePreset(name, value));
  if (!presets.length) throw new Error("OPENCODE_GO_PRESETS must contain at least one preset");
  return presets;
}

export { presetSettings };
export type { OpenRouterSettings };
