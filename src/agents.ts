import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { legalOrders, unitsOf } from "./engine.ts";
import { SYSTEM_PROMPT, buildPrompt, type View } from "./prompt.ts";

/** Call bookkeeping shared by every model response. */
export type CallMeta = {
  error?: string;
  model?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

/** Raw orders as returned; the engine validates them. */
export type Decision = CallMeta & { orders: unknown[]; plan?: string };
/** Raw messages as returned; `normalizeMessages` validates them. */
export type Talk = CallMeta & { messages: unknown[] };

export type Agent = {
  id: string;
  decide(view: View): Promise<Decision>;
  talk(view: View, round: number, rounds: number): Promise<Talk>;
};

const silent = async (): Promise<Talk> => ({ messages: [] });

export const holdAgent: Agent = {
  id: "baseline/hold",
  decide: async ({ power, state }) => ({ orders: unitsOf(state, power).map((u) => `${u} H`) }),
  talk: silent,
};

export function randomAgent(seed: number): Agent {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return {
    id: "baseline/random",
    decide: async ({ power, state }) => ({
      orders: unitsOf(state, power).map((u) => {
        const legal = legalOrders(state, u);
        return legal[Math.floor(rand() * legal.length)];
      }),
    }),
    talk: silent,
  };
}

const ORDERS_SCHEMA = JSON.stringify({
  type: "object",
  properties: { plan: { type: "string" }, orders: { type: "array", items: { type: "string" } } },
  required: ["plan", "orders"],
  additionalProperties: false,
});

const TALK_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    messages: {
      type: "array",
      items: {
        type: "object",
        properties: { to: { type: "array", items: { type: "string" } }, text: { type: "string" } },
        required: ["to", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["messages"],
  additionalProperties: false,
});

export const CLAUDE_SETTINGS = join(homedir(), ".config/diplomabench/claude-auth.json");

/**
 * Plays through a headless Claude Code call with no tools. `--bare` keeps the
 * user's CLAUDE.md, hooks, and memory out of the player's context; auth comes
 * from a settings file holding only `apiKeyHelper` and `env`.
 */
export function claudeCodeAgent(model: string, opts: { timeoutMs?: number; settings?: string } = {}): Agent {
  const settings = opts.settings ?? CLAUDE_SETTINGS;
  const call = async <T>(prompt: string, schema: string): Promise<{ output: Partial<T> } & CallMeta> => {
    const args = [
      "-p", "--bare", "--settings", settings, "--model", model,
      "--output-format", "json", "--tools", "", "--no-session-persistence",
      "--system-prompt", SYSTEM_PROMPT, "--json-schema", schema,
    ];
    const started = Date.now();
    try {
      const out = JSON.parse(await run("claude", args, prompt, opts.timeoutMs ?? 300_000)) as {
        is_error?: boolean;
        result?: string;
        structured_output?: Partial<T>;
        total_cost_usd?: number;
        modelUsage?: Record<string, unknown>;
        usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
      };
      const usage = out.usage ?? {};
      return {
        output: out.structured_output ?? {},
        error: out.is_error ? out.result : out.structured_output ? undefined : "no structured output",
        model: Object.keys(out.modelUsage ?? {})[0],
        costUsd: out.total_cost_usd,
        durationMs: Date.now() - started,
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      };
    } catch (e) {
      return { output: {}, error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started };
    }
  };

  return {
    id: `claude-code/${model}`,
    async decide(view) {
      const { output, ...meta } = await call<{ plan: string; orders: unknown[] }>(buildPrompt(view, { kind: "orders" }), ORDERS_SCHEMA);
      return { ...meta, orders: output.orders ?? [], plan: output.plan };
    },
    async talk(view, round, rounds) {
      const { output, ...meta } = await call<{ messages: unknown[] }>(buildPrompt(view, { kind: "talk", round, rounds }), TALK_SCHEMA);
      return { ...meta, messages: output.messages ?? [] };
    },
  };
}

function run(cmd: string, args: string[], input: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: homedir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}
