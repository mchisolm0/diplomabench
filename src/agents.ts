import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { legalOrders, unitsOf, type PhaseRecord, type State } from "./engine.ts";
import type { Power } from "./map.ts";
import { SYSTEM_PROMPT, buildPrompt } from "./prompt.ts";

export type Decision = {
  /** Raw orders as returned; the engine validates them. */
  orders: unknown[];
  plan?: string;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type Agent = {
  id: string;
  decide(power: Power, state: State, history: PhaseRecord[]): Promise<Decision>;
};

export const holdAgent: Agent = {
  id: "baseline/hold",
  decide: async (power, state) => ({ orders: unitsOf(state, power).map((u) => `${u} H`) }),
};

export function randomAgent(seed: number): Agent {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return {
    id: "baseline/random",
    decide: async (power, state) => ({
      orders: unitsOf(state, power).map((u) => {
        const legal = legalOrders(state, u);
        return legal[Math.floor(rand() * legal.length)];
      }),
    }),
  };
}

const ORDERS_SCHEMA = JSON.stringify({
  type: "object",
  properties: { plan: { type: "string" }, orders: { type: "array", items: { type: "string" } } },
  required: ["plan", "orders"],
  additionalProperties: false,
});

/**
 * Plays through a headless Claude Code call with no tools. `--bare` keeps the
 * user's CLAUDE.md, hooks, and memory out of the player's context; auth comes
 * from a settings file holding only `apiKeyHelper` and `env`.
 */
export function claudeCodeAgent(model: string, opts: { timeoutMs?: number; settings?: string } = {}): Agent {
  const settings = opts.settings ?? join(homedir(), ".config/diplomabench/claude-auth.json");
  const args = [
    "-p", "--bare", "--settings", settings, "--model", model,
    "--output-format", "json", "--tools", "", "--no-session-persistence",
    "--system-prompt", SYSTEM_PROMPT, "--json-schema", ORDERS_SCHEMA,
  ];
  return {
    id: `claude-code/${model}`,
    async decide(power, state, history) {
      const started = Date.now();
      try {
        const stdout = await run("claude", args, buildPrompt(power, state, history), opts.timeoutMs ?? 300_000);
        const out = JSON.parse(stdout) as {
          is_error?: boolean;
          result?: string;
          structured_output?: { plan?: string; orders?: unknown[] };
          total_cost_usd?: number;
          usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number };
        };
        const usage = out.usage ?? {};
        return {
          orders: out.structured_output?.orders ?? [],
          plan: out.structured_output?.plan,
          error: out.is_error ? out.result : out.structured_output ? undefined : "no structured output",
          costUsd: out.total_cost_usd,
          durationMs: Date.now() - started,
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        };
      } catch (e) {
        return { orders: [], error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - started };
      }
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
