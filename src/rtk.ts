import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";

const REWRITE_TIMEOUT_MS = 5000;
const VALID_RTK_SUBCOMMANDS = ["enable", "disable", "status"] as const;
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
  return isSessionEnabled()
    ? ctx.ui.theme.fg("success", "rtk ✓")
    : ctx.ui.theme.fg("error", "rtk ✗");
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

  ctx.ui.notify(
    `Session toggle: ${state}\nBinary: ${binary}\nTip: bypass rtk with !RTK_DISABLED=1 <cmd>.`,
    "info",
  );
}

async function showRtkOverlay(ctx: ExtensionContext): Promise<void> {
  const selected = await ctx.ui.select("rtk", ["enable", "disable", "status"]);
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
        ctx.ui.notify("Unknown /rtk subcommand. Valid: enable, disable, status.", "error");
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
          return localBashOperations.exec(rewritten, execCwd, options);
        },
      },
    };
  });
}
