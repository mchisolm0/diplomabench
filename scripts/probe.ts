// Usage: node scripts/probe.ts <scenario,...|all> --players claude-code:sonnet,codex:gpt-6.1-sol
//                              [--variants threat,calm] [--samples 5] [--parallel 3] [--deadline 600] [--out runs]
// Each sample is one phase of a seeded game (src/scenarios): the probed power
// is a fresh session of the player, and every other power plays the variant's
// fixed orders. Results go to <out>/<time>-probe/results.jsonl, with label
// counts per player and variant in summary.json.
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { CLAUDE_SETTINGS } from "../src/agents.ts";
import { formatOrder } from "../src/engine.ts";
import { HARNESSES, harnessDriver, type HarnessName } from "../src/harness.ts";
import { playLiveGame, scriptedDriver, type Driver } from "../src/live.ts";
import { POWERS, type Power } from "../src/map.ts";
import { evaluate, replay } from "../src/scenario.ts";
import { SCENARIOS } from "../src/scenarios/index.ts";
import { readUsage, usageDelta } from "../src/usage.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    players: { type: "string" },
    variants: { type: "string" },
    samples: { type: "string", default: "5" },
    parallel: { type: "string", default: "3" },
    deadline: { type: "string", default: "600" },
    out: { type: "string", default: "runs" },
  },
});

const names = positionals[0] === "all" ? Object.keys(SCENARIOS) : (positionals[0]?.split(",") ?? []);
if (!names.length || names.some((n) => !SCENARIOS[n])) throw new Error(`name scenarios (or all): ${Object.keys(SCENARIOS).join(", ")}`);
const players = values.players?.split(",") ?? [];
const harnessOf = (p: string) => p.slice(0, p.indexOf(":")) as HarnessName;
if (!players.length || players.some((p) => !HARNESSES.includes(harnessOf(p)))) throw new Error(`--players needs <harness>:<model> entries; harnesses: ${HARNESSES.join(", ")}`);
const wanted = values.variants?.split(",");
const samples = Number(values.samples);
const deadline = Number(values.deadline);

const jobs = names.flatMap((name) => {
  const s = SCENARIOS[name]!;
  return Object.keys(s.variants)
    .filter((v) => !wanted || wanted.includes(v))
    .flatMap((variant) => players.flatMap((player) => Array.from({ length: samples }, (_, sample) => ({ name, variant, player, sample }))));
});
if (!jobs.length) throw new Error("no variants match --variants");

const dir = `${values.out}/${new Date().toISOString().replace(/[:.]/g, "-")}-probe`;
await mkdir(dir, { recursive: true });
const usesClaude = players.some((p) => harnessOf(p) === "claude-code");
const usageBefore = usesClaude ? await readUsage(CLAUDE_SETTINGS) : null;

type Result = (typeof jobs)[number] & { label: string };
const results: Result[] = [];
let next = 0;
async function worker() {
  for (let i = next++; i < jobs.length; i = next++) {
    const job = jobs[i]!;
    const s = SCENARIOS[job.name]!;
    const v = s.variants[job.variant]!;
    const start = replay(s.map, v);
    const driver = harnessDriver(harnessOf(job.player), job.player.slice(job.player.indexOf(":") + 1));
    const seats = Object.fromEntries(POWERS.map((p) => [p, p === s.power ? driver : scriptedDriver(v.others[p] ?? [])])) as Record<Power, Driver>;
    const log = await playLiveGame(seats, { map: s.map, mode: "rounds", press: 1, phaseSeconds: deadline, maxPhases: 1, start });
    const phase = log.phases.at(-1);
    const decision = phase?.decisions[s.power];
    const { label, orders } = evaluate(s, v, start, decision?.orders ?? []);
    results.push({ ...job, label });
    const record = {
      ...job,
      label,
      orders: orders.map(formatOrder),
      plan: decision?.plan,
      sent: phase?.messages.filter((m) => m.from === s.power).map((m) => `${m.broadcast ? "ALL" : m.to.join(", ")}: ${m.text}`),
      error: decision?.error,
      toolCalls: decision?.toolCalls,
      durationMs: decision?.durationMs,
      inputTokens: decision?.inputTokens,
      outputTokens: decision?.outputTokens,
      costUsd: decision?.costUsd,
      seat: driver.root,
    };
    await appendFile(`${dir}/results.jsonl`, `${JSON.stringify(record)}\n`);
    console.log(`${job.name}/${job.variant} ${job.player} #${job.sample + 1}: ${label}${decision?.error ? ` (${decision.error})` : ""}`);
  }
}
await Promise.all(Array.from({ length: Math.min(Number(values.parallel), jobs.length) }, worker));

// "label n/N" per scenario, variant and player.
const counts: Record<string, Record<string, Record<string, Record<string, number>>>> = {};
for (const r of results) {
  const byLabel = (((counts[r.name] ??= {})[r.variant] ??= {})[r.player] ??= {});
  byLabel[r.label] = (byLabel[r.label] ?? 0) + 1;
}
const usageAfter = usesClaude ? await readUsage(CLAUDE_SETTINGS) : null;
const summary = {
  samples,
  counts,
  subscription: usageBefore && usageAfter ? { deltaPoints: usageDelta(usageBefore, usageAfter), before: usageBefore, after: usageAfter } : null,
};
await writeFile(`${dir}/summary.json`, JSON.stringify(summary, null, 2));
for (const [name, variants] of Object.entries(counts)) {
  console.log(`\n${name}: ${SCENARIOS[name]!.question}`);
  for (const [variant, byPlayer] of Object.entries(variants)) {
    for (const [player, labels] of Object.entries(byPlayer)) {
      console.log(`  ${variant.padEnd(12)} ${player.padEnd(36)} ${Object.entries(labels).map(([l, n]) => `${l} ${n}/${samples}`).join(", ")}`);
    }
  }
}
console.log(`\nsubscription: ${JSON.stringify(summary.subscription?.deltaPoints ?? null)}\nresults: ${dir}`);
