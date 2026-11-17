import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SETTINGS } from "./agents.ts";
import type { Driver, Turn, TurnMeta } from "./live.ts";

/**
 * Session players: one harness session per power for the whole game, resumed
 * each phase. Every harness gets only the diplomabench MCP tools, runs in an
 * empty directory, and is kept away from the user's own instructions, hooks,
 * and plugins.
 */
export type HarnessName = "claude-code" | "codex" | "opencode";
export const HARNESSES: readonly HarnessName[] = ["claude-code", "codex", "opencode"];

export const CODEX_SETTINGS = join(homedir(), ".config/diplomabench/codex.toml");
/** OpenCode providers for players, e.g. `{"provider": {...}}`. Use absolute paths in `{file:...}`, since HOME is replaced. */
export const OPENCODE_SETTINGS = join(homedir(), ".config/diplomabench/opencode.json");

export function harnessDriver(harness: HarnessName, model: string): Driver {
  const root = join(tmpdir(), `diplomabench-${randomUUID().slice(0, 8)}`);
  const make = { "claude-code": claudeCode, codex, opencode }[harness];
  return { id: `${harness}/${model}`, turn: make(model, root) };
}

type Turner = (model: string, root: string) => Driver["turn"];

/**
 * Claude Code: `--bare` skips CLAUDE.md, hooks and plugins; `--tools ""` removes
 * built-ins; a seat CLAUDE_CONFIG_DIR keeps sessions out of the user's history.
 */
const claudeCode: Turner = (model, root) => {
  const session = randomUUID();
  return async (t) => {
    const cwd = seatDir(root, t);
    const config = join(root, t.power, "claude-home");
    mkdirSync(config, { recursive: true });
    const mcp = { mcpServers: { diplomabench: { type: "http", url: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` } } } };
    const args = [
      "-p", "--bare", "--settings", CLAUDE_SETTINGS, "--model", model, "--output-format", "json",
      "--tools", "", "--mcp-config", JSON.stringify(mcp), "--strict-mcp-config", "--allowedTools", "mcp__diplomabench",
      ...(t.first ? ["--session-id", session] : ["--resume", session]),
    ];
    const run = await exec("claude", args, { cwd, input: t.prompt, signal: t.signal, env: { CLAUDE_CONFIG_DIR: config } });
    const out = parseJson<{ is_error?: boolean; result?: string; total_cost_usd?: number; usage?: Usage }>(run.stdout);
    return {
      ...meta(run, out?.is_error ? out.result : out ? undefined : "no JSON output"),
      sessionId: session,
      reply: out?.result,
      costUsd: out?.total_cost_usd,
      inputTokens: tokensIn(out?.usage),
      outputTokens: out?.usage?.output_tokens,
    };
  };
};

/**
 * Codex features that give a player anything beyond the game tools. Code mode
 * (`exec`) stays on: newer models reach MCP tools only through it, and with no
 * shell and a read-only sandbox it can't read files. `pnpm isolation` checks this.
 */
const CODEX_DISABLED = [
  "shell_tool", "unified_exec", "multi_agent", "collaboration_modes", "goals", "sleep_tool",
  "view_image", "image_generation", "apps", "plugins", "browser_use", "computer_use", "hooks", "skill_search", "tool_suggest",
];

/** Codex: a fresh CODEX_HOME per seat holding only the provider settings and the game server. */
const codex: Turner = (model, root) => {
  let thread: string | undefined;
  return async (t) => {
    const cwd = seatDir(root, t);
    const home = join(root, t.power, "codex-home");
    if (t.first) {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, "config.toml"),
        // Root keys first: TOML puts keys after a [table] inside that table.
        `model = ${JSON.stringify(model)}
sandbox_mode = "read-only"
approval_policy = "never"
web_search = "disabled"
${readFileSync(CODEX_SETTINGS, "utf8")}

[mcp_servers.diplomabench]
url = ${JSON.stringify(t.mcp.url)}
bearer_token_env_var = "DIPLOMABENCH_TOKEN"
tool_timeout_sec = 90
default_tools_approval_mode = "approve"
`,
      );
    }
    const flags = ["--json", "--skip-git-repo-check", ...CODEX_DISABLED.flatMap((f) => ["--disable", f])];
    const args = thread ? ["exec", "resume", thread, ...flags, "-"] : ["exec", ...flags, "-"];
    const run = await exec("codex", args, { cwd, input: t.prompt, signal: t.signal, env: { CODEX_HOME: home, DIPLOMABENCH_TOKEN: t.mcp.token } });
    const events = jsonLines(run.stdout);
    thread ??= events.find((e) => e.type === "thread.started")?.thread_id as string | undefined;
    const usage = events.findLast((e) => e.type === "turn.completed")?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const failed = events.find((e) => e.type === "turn.failed" || e.type === "error");
    return {
      ...meta(run, failed ? JSON.stringify(failed).slice(0, 500) : undefined),
      sessionId: thread,
      reply: events.flatMap((e) => (e.type === "item.completed" && (e.item as { type?: string })?.type === "agent_message" ? [(e.item as { text?: string }).text ?? ""] : [])).at(-1),
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
    };
  };
};

/**
 * OpenCode: a private server (`--standalone`) with HOME pointed at an empty
 * seat directory, so it loads only this config and the providers in
 * OPENCODE_SETTINGS. No login is linked in, so it can't fall back to paid keys.
 */
const opencode: Turner = (model, root) => {
  let session: string | undefined;
  return async (t) => {
    const cwd = seatDir(root, t);
    const home = join(root, t.power, "opencode-home");
    if (t.first) {
      mkdirSync(join(home, ".config/opencode"), { recursive: true });
      const { provider } = JSON.parse(readFileSync(OPENCODE_SETTINGS, "utf8")) as { provider?: unknown };
      writeFileSync(
        join(home, ".config/opencode/opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          provider,
          autoupdate: false,
          share: "disabled",
          mcp: {
            diplomabench: { type: "remote", url: t.mcp.url, enabled: true, timeout: 90_000, headers: { Authorization: "Bearer {env:DIPLOMABENCH_TOKEN}" } },
          },
          permission: { "*": "deny", "diplomabench_*": "allow" },
          tools: { skill: false },
        }),
      );
    }
    const args = ["run", "--standalone", "--format", "json", "-m", model, ...(session ? ["--session", session] : [])];
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), DIPLOMABENCH_TOKEN: t.mcp.token, OPENCODE_DISABLE_CLAUDE_CODE: "1" };
    const run = await exec("opencode", args, { cwd, input: t.prompt, signal: t.signal, env });
    const events = jsonLines(run.stdout);
    session ??= events.map((e) => e.sessionID).find((id): id is string => typeof id === "string");
    const tokens = events.flatMap((e) => {
      const part = e.part as { tokens?: { input?: number; output?: number; cache?: { read?: number } } } | undefined;
      return part?.tokens ? [part.tokens] : [];
    });
    const failed = events.find((e) => e.type === "error");
    return {
      ...meta(run, failed ? JSON.stringify(failed).slice(0, 500) : undefined),
      sessionId: session,
      reply: events.flatMap((e) => (e.type === "text" ? [(e.part as { text?: string } | undefined)?.text ?? ""] : [])).at(-1),
      inputTokens: tokens.reduce((s, x) => s + (x.input ?? 0) + (x.cache?.read ?? 0), 0) || undefined,
      outputTokens: tokens.reduce((s, x) => s + (x.output ?? 0), 0) || undefined,
    };
  };
};

type Usage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
const tokensIn = (u?: Usage) => (u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined);

/** An empty working directory per seat, stable across the game so sessions resume. */
function seatDir(root: string, t: Turn): string {
  const dir = join(root, t.power, "work");
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Run = { stdout: string; stderr: string; code: number | null; aborted: boolean; durationMs: number };

const meta = (run: Run, error?: string): TurnMeta => ({
  durationMs: run.durationMs,
  error: error ?? (run.aborted ? "stopped at the phase deadline" : run.code === 0 ? undefined : `exited ${run.code}: ${(run.stderr || run.stdout).slice(-500)}`),
});

function exec(cmd: string, args: string[], opts: { cwd: string; input: string; signal: AbortSignal; env?: Record<string, string> }): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    // PWD too: some harnesses trust it over the real cwd and would load this repo's AGENTS.md.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, PWD: opts.cwd, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const stop = () => child.kill("SIGTERM");
    opts.signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => (stderr += String(e)));
    child.on("close", (code) => {
      opts.signal.removeEventListener("abort", stop);
      resolve({ stdout, stderr, code, aborted: opts.signal.aborted, durationMs: Date.now() - started });
    });
    child.stdin.end(opts.input);
  });
}

function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function jsonLines(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    const v = parseJson<unknown>(line.trim());
    return typeof v === "object" && v !== null ? [v as Record<string, unknown>] : [];
  });
}
