import { cfg } from "./config.ts";
import { statusErrorMessage } from "./chat-transport.ts";
import type { LimitWindow, PlanLimits } from "./limits.ts";
import { openCodeGoUserAgent } from "./opencode-go.ts";

/**
 * OpenCode Go's own plan limits.
 *
 * Unlike Claude and Codex, this is a plain HTTP endpoint rather than something
 * a local CLI exposes, so `/usage` can report the subscription's real numbers
 * instead of the bot's token tally. Verified response shape:
 *
 * ```json
 * {"usage":{"rolling":{"status":"ok","percent":1,"resetsAt":"…"},
 *           "weekly": {"status":"ok","percent":1,"resetsAt":"…"},
 *           "monthly":{"status":"ok","percent":0,"resetsAt":"…"}}}
 * ```
 *
 * It is aggregate, not per model, and it reports percentages rather than the
 * dollars the caps are actually denominated in — so this is presented as the
 * provider's own accounting, never as a price the bot computed.
 */

interface GoUsageWindow {
  status?: string;
  percent?: number;
  resetsAt?: string;
}

interface GoUsageBody {
  usage?: {
    rolling?: GoUsageWindow;
    weekly?: GoUsageWindow;
    monthly?: GoUsageWindow;
  };
}

/** Map the three windows onto the shape `planLimitsText` already renders. */
export function goLimitsFrom(body: unknown): PlanLimits | null {
  const usage = (body as GoUsageBody | null)?.usage;
  if (!usage) return null;

  const windows: LimitWindow[] = [];
  const add = (label: string, window: GoUsageWindow | undefined) => {
    if (!window) return;
    windows.push({
      label,
      utilization: typeof window.percent === "number" ? window.percent : null,
      resetsAt: window.resetsAt ?? null,
    });
  };
  add("5h", usage.rolling);
  add("Week", usage.weekly);
  add("Month", usage.monthly);

  return windows.length ? { subscription: null, windows } : null;
}

export async function fetchGoLimits(): Promise<PlanLimits | null> {
  const response = await fetch(`${cfg.goBaseUrl}/usage`, {
    headers: {
      Authorization: `Bearer ${cfg.goApiKey}`,
      "User-Agent": openCodeGoUserAgent,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(
      statusErrorMessage(
        { label: "OpenCode Go", apiKeyName: "OPENCODE_GO_API_KEY" },
        { status: response.status, code: null, message: undefined },
      ),
    );
  }
  return goLimitsFrom(await response.json());
}
