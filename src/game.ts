import type { Agent, Decision } from "./agents.ts";
import { adjudicate, initialState, normalizeOrders, type Order, type PhaseRecord, type State } from "./engine.ts";
import { POWERS, type Power } from "./map.ts";
import { PROMPT_VERSION } from "./prompt.ts";

export type GameLog = {
  promptVersion: string;
  seats: Record<Power, string>;
  startedAt: string;
  phases: (PhaseRecord & { decisions: Partial<Record<Power, Decision>> })[];
  final: State;
};

/** Plays one game to completion. Each phase asks every surviving power in parallel. */
export async function playGame(
  seats: Record<Power, Agent>,
  onPhase?: (log: GameLog) => void | Promise<void>,
): Promise<GameLog> {
  let state = initialState();
  const log: GameLog = {
    promptVersion: PROMPT_VERSION,
    seats: Object.fromEntries(POWERS.map((p) => [p, seats[p].id])) as Record<Power, string>,
    startedAt: new Date().toISOString(),
    phases: [],
    final: state,
  };

  while (!state.result) {
    const current = state;
    const active = POWERS.filter((p) => Object.values(current.units).includes(p));
    const history = log.phases.map(({ decisions: _, ...record }) => record);
    const decisions = Object.fromEntries(
      await Promise.all(active.map(async (p) => [p, await seats[p].decide(p, current, history)] as const)),
    ) as Partial<Record<Power, Decision>>;

    const orders: Partial<Record<Power, Order[]>> = {};
    const fallbacks: PhaseRecord["fallbacks"] = [];
    for (const p of active) {
      const normalized = normalizeOrders(current, p, decisions[p]?.orders ?? []);
      orders[p] = normalized.orders;
      fallbacks.push(...normalized.fallbacks);
    }

    const next = adjudicate(current, orders);
    state = next.state;
    log.phases.push({ ...next.record, fallbacks, decisions });
    log.final = state;
    await onPhase?.(log);
  }
  return log;
}
