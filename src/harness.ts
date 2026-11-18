import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, globSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CLAUDE_SETTINGS } from "./agents.ts";
import type { Driver, Turn, TurnMeta } from "./live.ts";

/**
 * Session players: one harness session per power for the whole game, resumed
 * each phase. Every harness gets only the diplomabench MCP tools, runs in an
 * empty git repo under a private /tmp root (outside HOME, so no parent-folder
 * config search reaches the user's files), with its own HOME or config dir and
 * an allowlisted environment.
 */
export type HarnessName = "claude-code" | "codex" | "opencode";
export const HARNESSES: readonly HarnessName[] = ["claude-code", "codex", "opencode"];

/** Codex provider settings for players. Use absolute paths, since HOME is replaced. */
export const CODEX_SETTINGS = join(homedir(), ".config/diplomabench/codex.toml");
/** OpenCode providers for players, e.g. `{"provider": {...}}`. Use absolute paths in `{file:...}`, since HOME is replaced. */
export const OPENCODE_SETTINGS = join(homedir(), ".config/diplomabench/opencode.json");

/** `root` holds every seat file, including transcripts with private messages; it is mode 0700 and kept after the game. */
export function harnessDriver(harness: HarnessName, model: string): Driver & { root: string } {
  // /var/tmp, not /tmp: /tmp is often RAM-backed, and seat roots are kept after the game.
  const root = mkdtempSync("/var/tmp/diplomabench-");
  const make = { "claude-code": claudeCode, codex, opencode }[harness];
  return { id: `${harness}/${model}`, turn: make(model, root), root };
}

type Turner = (model: string, root: string) => Driver["turn"];

/**
 * The first `name` on PATH that isn't a mise command wrapper. A wrapper (a
 * link to `mise`, as Omarchy installs for claude and codex) reads its target
 * from HOME's config, so under a seat HOME it would install and run a fresh
 * copy instead of the user's.
 */
function findCli(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const path = resolve(dir, name);
    try {
      accessSync(path, constants.X_OK);
      if (basename(realpathSync(path)) !== "mise") return path;
    } catch {}
  }
  throw new Error(`no ${name} on PATH outside mise wrappers`);
}

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
    // A file, not argv, so the token doesn't show in `ps`.
    const mcpFile = join(config, "mcp.json");
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { diplomabench: { type: "http", url: t.mcp.url, headers: { Authorization: `Bearer ${t.mcp.token}` } } } }), { mode: 0o600 });
    const args = [
      "-p", "--bare", "--settings", CLAUDE_SETTINGS, "--model", model, "--output-format", "json",
      "--tools", "", "--mcp-config", mcpFile, "--strict-mcp-config", "--allowedTools", "mcp__diplomabench",
      // Resume whenever the session was saved, even by a turn stopped at the deadline.
      ...(globSync(`projects/*/${session}.jsonl`, { cwd: config }).length ? ["--resume", session] : ["--session-id", session]),
    ];
    const run = await exec(findCli("claude"), args, { cwd, input: t.prompt, signal: t.signal, env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1" } });
    const out = parseJson<{ is_error?: boolean; result?: string; total_cost_usd?: number; usage?: Usage }>(run.stdout);
    return {
      ...meta(run, out?.is_error ? out.result : out || run.aborted ? undefined : "no JSON output"),
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
  let configured = false;
  return async (t) => {
    const cwd = seatDir(root, t);
    const home = join(root, t.power, "codex-home");
    const userHome = join(root, t.power, "home");
    if (!configured) {
      mkdirSync(home, { recursive: true });
      mkdirSync(userHome, { recursive: true });
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
      configured = true;
    }
    const flags = ["--json", "--skip-git-repo-check", ...CODEX_DISABLED.flatMap((f) => ["--disable", f])];
    const args = thread ? ["exec", "resume", thread, ...flags, "-"] : ["exec", ...flags, "-"];
    const keys = namedEnv(readFileSync(CODEX_SETTINGS, "utf8"), /^\s*env_key\s*=\s*"([^"]+)"/gm);
    const run = await exec(findCli("codex"), args, { cwd, input: t.prompt, signal: t.signal, env: { ...keys, CODEX_HOME: home, HOME: userHome, DIPLOMABENCH_TOKEN: t.mcp.token } });
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
 * OpenCode: its own local server (`run` without `--attach`), no external
 * plugins (`--pure`), and HOME pointed at an empty
 * seat directory, so it loads only this config and the providers in
 * OPENCODE_SETTINGS. No login is linked in, so it can't fall back to paid keys.
 */
const opencode: Turner = (model, root) => {
  const { provider } = JSON.parse(readFileSync(OPENCODE_SETTINGS, "utf8")) as { provider?: unknown };
  // Only the provider block reaches the seat, so only its variables do.
  const keys = namedEnv(JSON.stringify(provider ?? {}), /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g);
  let session: string | undefined;
  let configured = false;
  return async (t) => {
    const cwd = seatDir(root, t);
    const home = join(root, t.power, "opencode-home");
    if (!configured) {
      mkdirSync(join(home, ".config/opencode"), { recursive: true });
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
      configured = true;
    }
    const args = ["run", "--pure", "--format", "json", "-m", model, ...(session ? ["--session", session] : [])];
    const env = { ...keys, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), DIPLOMABENCH_TOKEN: t.mcp.token, OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      // OpenCode npm-installs its plugin package into every config dir, about 170 MB per seat.
      // A dead registry makes that background install fail at once; seats need no plugins.
      npm_config_registry: "http://127.0.0.1:9/", npm_config_offline: "true",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" };
    const run = await exec(findCli("opencode"), args, { cwd, input: t.prompt, signal: t.signal, env });
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
  // A repo root stops harnesses searching parent folders for AGENTS.md and config.
  if (!globSync(".git", { cwd: dir }).length) execFileSync("git", ["init", "-q", dir]);
  return dir;
}

/** The variables a provider settings file names for its keys (`env_key`, `{env:...}`), taken from the parent environment. */
function namedEnv(settings: string, pattern: RegExp): Record<string, string> {
  return Object.fromEntries([...settings.matchAll(pattern)].flatMap((m) => (m[1] && process.env[m[1]] ? [[m[1], process.env[m[1]] as string]] : [])));
}

const ENV_ALLOWLIST = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
]);

type Run = { stdout: string; stderr: string; code: number | null; aborted: boolean; durationMs: number };

const meta = (run: Run, error?: string): TurnMeta => ({
  transcript: run.stdout,
  durationMs: run.durationMs,
  // A stopped harness often reports its own death (e.g. OpenCode's ECONNRESET); the stop is what happened.
  error: run.aborted ? "stopped at the phase deadline" : error ?? (run.code === 0 ? undefined : `exited ${run.code}: ${(run.stderr || run.stdout).slice(-500)}`),
});

function exec(cmd: string, args: string[], opts: { cwd: string; input: string; signal: AbortSignal; env?: Record<string, string> }): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Only what a CLI needs to run; harness settings come from opts.env, never the parent session.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_ALLOWLIST.has(k)));
    // PWD too: some harnesses trust it over the real cwd and would load this repo's AGENTS.md.
    // No global or system git config: seats are git repos, and harnesses show the git user to the model.
    const git = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...inherited, ...opts.env, PWD: opts.cwd, ...git }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 5000).unref();
    };
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
