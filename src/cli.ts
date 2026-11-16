// Usage: node src/cli.ts [--seats sonnet,sonnet,random,hold,opus] [--model sonnet]
// A seat is "hold", "random", or a Claude model name. --model fills every seat.
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { holdAgent, randomAgent, claudeCodeAgent, type Agent } from "./agents.ts";
import { centerCount, formatOrder } from "./engine.ts";
import { playGame, type GameLog } from "./game.ts";
import { POWERS, type Power } from "./map.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    seats: { type: "string" },
    seed: { type: "string", default: "1" },
    out: { type: "string", default: "runs" },
  },
});

const specs = values.seats?.split(",") ?? POWERS.map(() => values.model ?? "random");
if (specs.length !== POWERS.length) throw new Error(`--seats needs ${POWERS.length} entries`);

const seed = Number(values.seed);
const seats = Object.fromEntries(
  POWERS.map((p, i) => [p, agentFor(specs[i] ?? "hold", seed + i)]),
) as Record<Power, Agent>;

function agentFor(spec: string, seed: number): Agent {
  if (spec === "hold") return holdAgent;
  if (spec === "random") return randomAgent(seed);
  return claudeCodeAgent(spec);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const file = `${values.out}/${stamp}-${[...new Set(specs)].join("+")}.json`;
await mkdir(values.out, { recursive: true });

const log = await playGame(seats, async (log) => {
  const phase = log.phases.at(-1);
  if (!phase) return;
  const moved = new Set(phase.moved);
  const orders = POWERS.flatMap((p) => (phase.orders[p] ?? []).map((o) => `${p[0]}:${formatOrder(o)}${o.action === "move" && !moved.has(o.unit) ? "✗" : ""}`));
  const counts = POWERS.map((p) => `${p[0]}${centerCount(log.final, p)}`).join(" ");
  const errors = Object.values(phase.decisions).filter((d) => d?.error).length;
  console.log(`${phase.phase}  ${counts}  fallbacks ${phase.fallbacks.length}${errors ? ` errors ${errors}` : ""}  ${orders.join(", ")}`);
  await writeFile(file, JSON.stringify(log, null, 2));
});

console.log(summary(log));
console.log(`log: ${file}`);

function summary(log: GameLog): string {
  const decisions = log.phases.flatMap((p) => Object.values(p.decisions));
  const cost = decisions.reduce((sum, d) => sum + (d?.costUsd ?? 0), 0);
  const fallbacks = log.phases.reduce((sum, p) => sum + p.fallbacks.length, 0);
  const r = log.final.result;
  return [
    `result: ${r?.kind} ${r?.winners.join(", ")} after ${log.phases.length} phases`,
    ...POWERS.map((p) => `  ${p.padEnd(8)} ${log.seats[p].padEnd(22)} ${centerCount(log.final, p)} centers`),
    `fallbacks: ${fallbacks}  cost: $${cost.toFixed(3)}`,
  ].join("\n");
}
