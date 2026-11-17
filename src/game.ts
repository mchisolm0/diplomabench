import type { Agent, Decision, Talk } from "./agents.ts";
import { adjudicate, initialState, normalizeOrders, phaseName, type Order, type PhaseRecord } from "./engine.ts";
import { POWERS, type MapId, type Power } from "./map.ts";
import { canSee, normalizeMessages, type Message } from "./press.ts";
import { PROMPT_VERSION, type View } from "./prompt.ts";

export type GamePhase = PhaseRecord & {
  messages: Message[];
  rejectedMessages: number;
  decisions: Partial<Record<Power, Decision>>;
  talks: Partial<Record<Power, Talk>>[];
};

export type GameLog = {
  promptVersion: string;
  /** Missing in logs from before maps were data; those are v1. */
  map: MapId;
  pressRounds: number;
  seats: Record<Power, string>;
  startedAt: string;
  phases: GamePhase[];
  final: ReturnType<typeof initialState>;
};

/**
 * Plays one game to completion. Within each negotiation round and each order
 * step, every surviving power acts in parallel, so no seat moves first.
 */
export async function playGame(
  seats: Record<Power, Agent>,
  opts: { map?: MapId; pressRounds?: number; onPhase?: (log: GameLog) => void | Promise<void> } = {},
): Promise<GameLog> {
  const pressRounds = opts.pressRounds ?? 0;
  let state = initialState(opts.map);
  const log: GameLog = {
    promptVersion: PROMPT_VERSION,
    map: state.map,
    pressRounds,
    seats: Object.fromEntries(POWERS.map((p) => [p, seats[p].id])) as Record<Power, string>,
    startedAt: new Date().toISOString(),
    phases: [],
    final: state,
  };

  while (!state.result) {
    const current = state;
    const phase = phaseName(current);
    const active = POWERS.filter((p) => Object.values(current.units).includes(p));
    const history = log.phases.map(({ messages: _m, rejectedMessages: _r, decisions: _d, talks: _t, ...record }) => record);
    const earlier = log.phases.flatMap((p) => p.messages);
    const messages: Message[] = [];
    const view = (power: Power): View => ({
      power,
      state: current,
      history,
      messages: [...earlier, ...messages].filter((m) => canSee(power, m)),
      press: pressRounds > 0,
    });
    const each = <T>(fn: (p: Power) => Promise<T>) =>
      Promise.all(active.map(async (p) => [p, await fn(p)] as const)).then((pairs) => Object.fromEntries(pairs) as Partial<Record<Power, T>>);

    const talks: GamePhase["talks"] = [];
    let rejectedMessages = 0;
    for (let round = 1; round <= pressRounds; round++) {
      const said = await each((p) => seats[p].talk(view(p), round, pressRounds));
      talks.push(said);
      for (const p of active) {
        const result = normalizeMessages(p, active, said[p]?.messages ?? [], { phase, round });
        messages.push(...result.messages);
        rejectedMessages += result.rejected;
      }
    }

    const decisions = await each((p) => seats[p].decide(view(p)));
    const orders: Partial<Record<Power, Order[]>> = {};
    const fallbacks: PhaseRecord["fallbacks"] = [];
    for (const p of active) {
      const normalized = normalizeOrders(current, p, decisions[p]?.orders ?? []);
      orders[p] = normalized.orders;
      fallbacks.push(...normalized.fallbacks);
    }

    const next = adjudicate(current, orders);
    state = next.state;
    log.phases.push({ ...next.record, fallbacks, messages, rejectedMessages, decisions, talks });
    log.final = state;
    await opts.onPhase?.(log);
  }
  return log;
}
