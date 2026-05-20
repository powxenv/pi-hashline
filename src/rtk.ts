import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

const REWRITE_TIMEOUT_MS = 5000;
const GAIN_TIMEOUT_MS = 5000;
const GAIN_CACHE_TTL_MS = 30_000;
const VALID_RTK_SUBCOMMANDS = ["enable", "disable", "status", "gain"] as const;

const BASH_PROMPT_GUIDELINES = [
  "Use grep instead of bash grep for project searches so results include edit-ready anchors.",
  "Use read with offset/limit instead of bash sed -n for file range inspection.",
  "Use edit instead of shell sed -i, perl -pi, or ad-hoc scripts for file modifications.",
  "Use bash for commands that truly need a shell, such as builds, tests, package scripts, and system commands.",
];

let sessionEnabled = true;
let rtkUnavailableNotified = false;
let cachedNotify: ((message: string, level: "info" | "warning" | "error") => void) | null = null;

type RtkUnavailableReason = "missing" | "unexecutable";

type RtkGainSummary = {
  totalCommands: number | undefined;
  inputTokens: string | undefined;
  outputTokens: string | undefined;
  tokensSaved: string | undefined;
  percentSaved: number | undefined;
  totalExecTime: string | undefined;
  averageExecTime: string | undefined;
};

type CachedRtkGain = {
  checkedAt: number;
  summary: RtkGainSummary | null;
};

let cachedGain: CachedRtkGain | null = null;

function alertRtkUnavailable(reason: RtkUnavailableReason): void {
  if (rtkUnavailableNotified || cachedNotify === null) return;

  const messages: Record<RtkUnavailableReason, string> = {
    missing: "[rtk] rtk binary not found on PATH. Shell command rewrites are disabled.",
    unexecutable:
      "[rtk] rtk binary found on PATH but is not executable. Run: chmod +x $(command -v rtk)",
  };

  rtkUnavailableNotified = true;
  cachedNotify(messages[reason], "warning");
}

function cacheNotify(notify: (message: string, level: "info" | "warning" | "error") => void): void {
  if (cachedNotify === null) cachedNotify = notify;
}

function classifySpawnError(err: NodeJS.ErrnoException): "missing" | "unexecutable" | "other" {
  if (err.code === "ENOENT") return "missing";
  if (err.code === "EACCES") return "unexecutable";
  return "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTokenCount(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function formatDurationMs(milliseconds: number | undefined): string | undefined {
  if (milliseconds === undefined) return undefined;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.round(milliseconds)}ms`;
}

function parseRtkGainJson(output: string): RtkGainSummary | null {
  try {
    const parsed: unknown = JSON.parse(output);
    if (!isRecord(parsed)) return null;
    const summary = parsed["summary"];
    if (!isRecord(summary)) return null;
    const totalCommands = readNumberField(summary, "total_commands");
    const totalInput = readNumberField(summary, "total_input");
    const totalOutput = readNumberField(summary, "total_output");
    const totalSaved = readNumberField(summary, "total_saved");
    const percentSaved = readNumberField(summary, "avg_savings_pct");
    const totalTimeMs = readNumberField(summary, "total_time_ms");
    const averageTimeMs = readNumberField(summary, "avg_time_ms");
    return {
      totalCommands,
      inputTokens: formatTokenCount(totalInput),
      outputTokens: formatTokenCount(totalOutput),
      tokensSaved: formatTokenCount(totalSaved),
      percentSaved,
      totalExecTime: formatDurationMs(totalTimeMs),
      averageExecTime: formatDurationMs(averageTimeMs),
    };
  } catch {
    return null;
  }
}

function parseFirstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseNumberValue(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replaceAll(",", "");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseRtkGainOutput(output: string): RtkGainSummary | null {
  const totalCommands = parseNumberValue(parseFirstMatch(output, /^Total commands:\s*([0-9,]+)/m));
  const inputTokens = parseFirstMatch(output, /^Input tokens:\s*(.+)$/m);
  const outputTokens = parseFirstMatch(output, /^Output tokens:\s*(.+)$/m);
  const tokensSaved = parseFirstMatch(output, /^Tokens saved:\s*([^\n(]+)/m);
  const percentSaved = parseNumberValue(
    parseFirstMatch(output, /^Tokens saved:\s*[^\n(]+\(([^%)]+)%\)/m),
  );
  const execTimeMatch = output.match(/^Total exec time:\s*([^\n(]+)(?:\(avg\s*([^\n)]+)\))?/m);
  const totalExecTime = execTimeMatch?.[1]?.trim();
  const averageExecTime = execTimeMatch?.[2]?.trim();

  if (
    totalCommands === undefined &&
    inputTokens === undefined &&
    outputTokens === undefined &&
    tokensSaved === undefined &&
    percentSaved === undefined
  ) {
    return null;
  }

  return {
    totalCommands,
    inputTokens,
    outputTokens,
    tokensSaved,
    percentSaved,
    totalExecTime: totalExecTime && totalExecTime.length > 0 ? totalExecTime : undefined,
    averageExecTime: averageExecTime && averageExecTime.length > 0 ? averageExecTime : undefined,
  };
}

function getRtkGainSummary(forceRefresh: boolean): RtkGainSummary | null {
  const now = Date.now();
  if (!forceRefresh && cachedGain && now - cachedGain.checkedAt < GAIN_CACHE_TTL_MS) {
    return cachedGain.summary;
  }

  const result = spawnSync("rtk", ["gain", "--format", "json"], {
    encoding: "utf-8",
    timeout: GAIN_TIMEOUT_MS,
  });
  if (result.error) {
    const reason = classifySpawnError(result.error);
    if (reason !== "other") alertRtkUnavailable(reason);
    cachedGain = { checkedAt: now, summary: null };
    return null;
  }

  rtkUnavailableNotified = false;
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const summary = parseRtkGainJson(result.stdout ?? "") ?? parseRtkGainOutput(combinedOutput);
  cachedGain = { checkedAt: now, summary };
  return summary;
}

function renderGainBar(percent: number | undefined, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function renderCompactGain(summary: RtkGainSummary | null, ctx: ExtensionContext): string {
  if (summary === null) return ctx.ui.theme.fg("muted", "no gain data");
  const percent = summary.percentSaved;
  const percentText = percent === undefined ? "--" : `${percent.toFixed(1)}%`;
  const savedText = summary.tokensSaved ?? "saved --";
  const bar = renderGainBar(percent, 8);
  return `${ctx.ui.theme.fg("success", bar)} ${percentText} ${savedText}`;
}

function renderDetailedGain(summary: RtkGainSummary | null, ctx: ExtensionContext): string {
  if (summary === null) {
    return "RTK gain data is not available yet. Run commands through RTK and try /rtk gain again.";
  }
  const lines = [
    "RTK token savings",
    `${renderGainBar(summary.percentSaved, 24)} ${summary.percentSaved === undefined ? "--" : `${summary.percentSaved.toFixed(1)}%`}`,
    `Commands: ${summary.totalCommands ?? "--"}`,
    `Input: ${summary.inputTokens ?? "--"}  Output: ${summary.outputTokens ?? "--"}`,
    `Saved: ${summary.tokensSaved ?? "--"}`,
    `Exec time: ${summary.totalExecTime ?? "--"}  Avg: ${summary.averageExecTime ?? "--"}`,
  ];
  return lines
    .map((line, index) => (index === 1 ? ctx.ui.theme.fg("success", line) : line))
    .join("\n");
}

function rtkRewriteCommand(command: string): string | undefined {
  try {
    const result = spawnSync("rtk", ["rewrite", command], {
      encoding: "utf-8",
      timeout: REWRITE_TIMEOUT_MS,
    });

    if (result.error) {
      const reason = classifySpawnError(result.error);
      if (reason !== "other") alertRtkUnavailable(reason);
      return undefined;
    }

    rtkUnavailableNotified = false;
    const out = (result.stdout ?? "").trimEnd();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function isSessionEnabled(): boolean {
  return sessionEnabled;
}

function renderStatusText(ctx: ExtensionContext): string {
  if (!isSessionEnabled()) return ctx.ui.theme.fg("warning", "rtk off");
  const summary = getRtkGainSummary(false);
  if (summary === null) return ctx.ui.theme.fg("success", "rtk on");
  return `${ctx.ui.theme.fg("success", "rtk")} ${renderCompactGain(summary, ctx)}`;
}

function updateFooterStatus(ctx: ExtensionContext): void {
  ctx.ui.setStatus("rtk", renderStatusText(ctx));
}

function isRtkSubcommand(value: string): value is (typeof VALID_RTK_SUBCOMMANDS)[number] {
  return VALID_RTK_SUBCOMMANDS.some((subcommand) => subcommand === value);
}

function handleRtkSubcommand(
  subcommand: (typeof VALID_RTK_SUBCOMMANDS)[number],
  ctx: ExtensionContext,
): void {
  if (subcommand === "status") {
    showRtkStatus(ctx);
    return;
  }
  if (subcommand === "gain") {
    showRtkGain(ctx);
    return;
  }

  sessionEnabled = subcommand === "enable";
  updateFooterStatus(ctx);
  ctx.ui.notify(`rtk ${subcommand}d for this session`, "info");
}

function showRtkStatus(ctx: ExtensionContext): void {
  const state = isSessionEnabled()
    ? ctx.ui.theme.fg("success", "enabled")
    : ctx.ui.theme.fg("warning", "disabled");

  const version = spawnSync("rtk", ["--version"], {
    encoding: "utf-8",
    timeout: REWRITE_TIMEOUT_MS,
  });
  let binary = "rtk not detected on PATH";

  if (version.error) {
    const reason = classifySpawnError(version.error);
    if (reason !== "other") alertRtkUnavailable(reason);
  } else {
    rtkUnavailableNotified = false;
    const versionText = (version.stdout ?? "").trim() || "version unknown";
    const pathResult = spawnSync("sh", ["-c", "command -v rtk"], {
      encoding: "utf-8",
      timeout: REWRITE_TIMEOUT_MS,
    });
    const pathText = (pathResult.stdout ?? "").trim();
    binary = pathText.length > 0 ? `${versionText} at ${pathText}` : versionText;
  }

  const gain = renderDetailedGain(getRtkGainSummary(false), ctx);
  ctx.ui.notify(
    `Session toggle: ${state}\nBinary: ${binary}\n\n${gain}\n\nTip: bypass rtk with !RTK_DISABLED=1 <cmd>.`,
    "info",
  );
}

function showRtkGain(ctx: ExtensionContext): void {
  const summary = getRtkGainSummary(true);
  updateFooterStatus(ctx);
  const detail = renderDetailedGain(summary, ctx);
  ctx.ui.notify(detail, "info");
  ctx.ui.setWidget("rtk-gain", detail.split("\n"), { placement: "belowEditor" });
}

async function showRtkOverlay(ctx: ExtensionContext): Promise<void> {
  const selected = await ctx.ui.select("rtk", ["enable", "disable", "status", "gain"]);
  if (selected === undefined || !isRtkSubcommand(selected)) return;
  handleRtkSubcommand(selected, ctx);
}

export function registerRtk(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const localBashOperations = createLocalBashOperations();

  const bashTool = createBashToolDefinition(cwd, {
    spawnHook: ({ command, cwd, env }) => {
      if (!isSessionEnabled()) return { command, cwd, env };
      return { command: rtkRewriteCommand(command) ?? command, cwd, env };
    },
  });

  pi.registerTool({
    ...bashTool,
    promptGuidelines: [...(bashTool.promptGuidelines ?? []), ...BASH_PROMPT_GUIDELINES],
  });

  pi.registerCommand("rtk", {
    description: "Control rtk shell command rewriting",
    getArgumentCompletions: (prefix) => {
      const completions = VALID_RTK_SUBCOMMANDS.filter((sub) => sub.startsWith(prefix)).map(
        (sub) => ({ label: sub, value: sub }),
      );
      return completions.length > 0 ? completions : null;
    },
    handler: async (args, ctx) => {
      const subcommand = args.trim();
      if (subcommand.length === 0) {
        await showRtkOverlay(ctx);
        return;
      }
      if (!isRtkSubcommand(subcommand)) {
        ctx.ui.notify("Unknown /rtk subcommand. Valid: enable, disable, status, gain.", "error");
        return;
      }
      handleRtkSubcommand(subcommand, ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    cacheNotify((message, level) => ctx.ui.notify(message, level));
    updateFooterStatus(ctx);

    const result = spawnSync("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS });
    if (!result.error) return;

    const reason = classifySpawnError(result.error);
    if (reason !== "other") alertRtkUnavailable(reason);
  });

  pi.on("user_bash", (event, ctx) => {
    cacheNotify((message, level) => ctx.ui.notify(message, level));

    if (event.excludeFromContext) return;
    if (!isSessionEnabled()) return;

    const rewritten = rtkRewriteCommand(event.command);
    if (rewritten === undefined) return;

    return {
      operations: {
        exec: (_command, execCwd, options) => {
          const result = localBashOperations.exec(rewritten, execCwd, options);
          queueMicrotask(() => updateFooterStatus(ctx));
          return result;
        },
      },
    };
  });
}
