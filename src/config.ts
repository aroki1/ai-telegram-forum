import "dotenv/config";
import { parseCodexPresets, parseDefaultCodexPreset } from "./preset-config.ts";
import { parseProvider } from "./provider.ts";
import { parseOpenRouterPresets } from "./openrouter-config.ts";
import { normalizeOpenRouterModel } from "./openrouter-model.ts";
import { parseGoPresets } from "./go-config.ts";
import { normalizeGoModel } from "./go-model.ts";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function reqNum(name: string): number {
  const raw = req(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got: ${raw}`);
  return n;
}

/**
 * The launcher topic. Messages in Telegram's General topic carry no
 * `message_thread_id`, so `General` (the default) maps to undefined.
 */
function parseLauncher(raw: string | undefined): number | undefined {
  if (!raw || raw.trim().toLowerCase() === "general") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`LAUNCHER_THREAD_ID must be a number or "General", got: ${raw}`);
  }
  return n;
}

function parseProjects(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error(`PROJECTS is not valid JSON: ${raw}`);
  }
}

const hours = (name: string, fallback: number) =>
  (Number(process.env[name] ?? fallback)) * 3600_000;

const provider = parseProvider(process.env.PROVIDER ?? "claude");
if (!provider) {
  throw new Error('PROVIDER must be "claude", "codex", "openrouter", or "opencode-go"');
}
const codexPresets = parseCodexPresets(process.env.CODEX_PRESETS);
const openrouterApiKey = process.env.OPENROUTER_API_KEY?.trim() ?? "";
const openrouterEnabled = Boolean(openrouterApiKey);
const openrouterPresets = parseOpenRouterPresets(process.env.OPENROUTER_PRESETS);
const openrouterModel = normalizeOpenRouterModel(process.env.OPENROUTER_MODEL?.trim() || "openrouter/free");
if (!openrouterModel) throw new Error("OPENROUTER_MODEL must be a model id or an openrouter.ai link");
const openrouterMaxSteps = Number(process.env.OPENROUTER_MAX_STEPS ?? 24);
const openrouterTurnTimeoutMs = Number(process.env.OPENROUTER_TURN_TIMEOUT_MINUTES ?? 30) * 60_000;
const openrouterMaxToolOutput = Number(process.env.OPENROUTER_MAX_TOOL_OUTPUT ?? 20_000);
const openrouterContextWindow = Number(process.env.OPENROUTER_CONTEXT_WINDOW ?? 64_000);
if (![openrouterMaxSteps, openrouterTurnTimeoutMs, openrouterMaxToolOutput, openrouterContextWindow].every((n) => Number.isFinite(n) && n > 0)) {
  throw new Error("OpenRouter limits must be positive numbers");
}
if (provider === "openrouter" && !openrouterEnabled) {
  throw new Error("PROVIDER=openrouter requires a non-empty OPENROUTER_API_KEY");
}

// OpenCode Go: a subscription behind `https://opencode.ai/zen/go/v1`, hidden
// from `/provider` while the key is empty, exactly like OpenRouter.
const goApiKey = process.env.OPENCODE_GO_API_KEY?.trim() ?? "";
const goEnabled = Boolean(goApiKey);
const goBaseUrl = (
  process.env.OPENCODE_GO_BASE_URL?.trim() || "https://opencode.ai/zen/go/v1"
).replace(/\/+$/, "");
const goModel = normalizeGoModel(process.env.OPENCODE_GO_MODEL?.trim() || "glm-5.2");
if (!goModel) {
  throw new Error(
    "OPENCODE_GO_MODEL must be a model id such as `kimi-k3` or `opencode-go/kimi-k3`",
  );
}
const goPresets = parseGoPresets(process.env.OPENCODE_GO_PRESETS);
const goMaxSteps = Number(process.env.OPENCODE_GO_MAX_STEPS ?? 24);
const goTurnTimeoutMs = Number(process.env.OPENCODE_GO_TURN_TIMEOUT_MINUTES ?? 30) * 60_000;
const goMaxToolOutput = Number(process.env.OPENCODE_GO_MAX_TOOL_OUTPUT ?? 20_000);
const goContextWindow = Number(process.env.OPENCODE_GO_CONTEXT_WINDOW ?? 64_000);
if (
  ![goMaxSteps, goTurnTimeoutMs, goMaxToolOutput, goContextWindow].every(
    (n) => Number.isFinite(n) && n > 0,
  )
) {
  throw new Error("OpenCode Go limits must be positive numbers");
}
if (provider === "opencode-go" && !goEnabled) {
  throw new Error('PROVIDER="opencode-go" requires a non-empty OPENCODE_GO_API_KEY');
}

export const cfg = {
  token: req("BOT_TOKEN"),
  chatId: reqNum("FORUM_CHAT_ID"),
  allowedUserId: reqNum("ALLOWED_USER_ID"),
  launcherThreadId: parseLauncher(process.env.LAUNCHER_THREAD_ID),

  defaultCwd: req("DEFAULT_CWD"),
  projects: parseProjects(process.env.PROJECTS),

  provider,
  // MODEL remains Claude's backwards-compatible name. Codex has a separate
  // default so one daemon can host topics from both providers.
  claudeModel: process.env.CLAUDE_MODEL ?? process.env.MODEL ?? "claude-opus-4-8",
  codexModel: process.env.CODEX_MODEL ?? "gpt-5.6-sol",
  openrouterApiKey,
  openrouterEnabled,
  openrouterModel,
  openrouterPresets,
  openrouterHistoryPath: process.env.OPENROUTER_HISTORY_PATH ?? "./data/openrouter-sessions",
  openrouterMaxSteps,
  openrouterTurnTimeoutMs,
  openrouterMaxToolOutput,
  openrouterContextWindow,
  goApiKey,
  goEnabled,
  goModel,
  goPresets,
  goBaseUrl,
  goHistoryPath: process.env.OPENCODE_GO_HISTORY_PATH ?? "./data/opencode-go-sessions",
  goMaxSteps,
  goTurnTimeoutMs,
  goMaxToolOutput,
  goContextWindow,
  codexPresets,
  codexDefaultPreset: parseDefaultCodexPreset(process.env.CODEX_DEFAULT_PRESET, codexPresets),
  // "auto": auto-approve the ALLOWED_TOOLS allowlist, deny everything else,
  // and block obviously destructive shell commands. "bypass": allow all tools.
  permission: (process.env.PERMISSION ?? "auto") as "auto" | "bypass",
  allowedTools: (process.env.ALLOWED_TOOLS ?? "Read,Glob,Grep,Edit,Write,Bash")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean),

  deleteAfterMs: hours("DELETE_AFTER_HOURS", 168),

  // How long a live topic object is retained. Claude also keeps its child warm;
  // Codex uses a subprocess per turn and keeps only its resumable thread here.
  sessionIdleMs: Number(process.env.SESSION_IDLE_MINUTES ?? 20) * 60_000,

  // How long a permission prompt waits for a button press before denying.
  permissionTimeoutMs: Number(process.env.PERMISSION_TIMEOUT_MINUTES ?? 10) * 60_000,

  dbPath: process.env.DB_PATH ?? "./data/state.db",
  // Where a non-image attachment is dropped so the agent can Read it by path.
  inboxPath: process.env.INBOX_PATH ?? "./data/inbox",
  // Heartbeat file the running bot keeps warm; `/telegramify` won't adopt a
  // session into a forum nobody is listening to.
  pidPath: process.env.PID_PATH ?? "./data/bot.pid",
} as const;
