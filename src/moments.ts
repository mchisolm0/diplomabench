import type { State } from "./engine.ts";
import type { GamePhase } from "./game.ts";
import { POWERS, type GameMap, type Power, type Province } from "./map.ts";
import type { Message } from "./press.ts";
import type { GameEvent } from "./spectate.ts";

/** Words lifted from the log to sit under a moment's headline: a message with who it went to, or a line of the player's own trace. */
export type Quote = { power: Power; text: string } & ({ kind: "message"; to: Power[]; broadcast: boolean } | { kind: "thinking" | "text" });

/**
 * A turning point a spectator would clip. `power` is who it is about: the winner,
 * the attacker, the one who broke its word, or a power that went out on its own.
 * A game ending at the year limit names nobody.
 */
export type Moment = {
  phase: string;
  kind: "solo" | "limit" | "out" | "broken" | "home";
  power?: Power;
  /** Who it happened to: the power knocked out, lied to, or holding the province before. */
  victim?: Power;
  /** The province taken or entered, and where the army came from if it moved this phase. */
  province?: Province;
  from?: Province;
  quotes: Quote[];
};

type Said = { power: Power; kind: "thinking" | "text"; text: string; at: number };

const MAX_QUOTE = 180;
// "no move to DEL", "won't attack BET", "will not enter ABY". Not a threat like "if you do not move out of DEL".
const PROMISE = /(?<!\byou (?:\w+ )?)\b(?:no|not|won't|never) (?:be )?(?:attack|mov|touch|enter|tak|contest)\w*/;
/** Whether the sentence promises to leave the province alone: it has to be what the refusal is about, so in the same clause. */
const promises = (s: string, id: Province) => new RegExp(`${PROMISE.source}[^,;]*\\b${id}\\b`, "i").test(s);

const sentences = (text: string) =>
  text
    .replace(/\*\*/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
const names = (s: string, id: Province) => new RegExp(`\\b${id}\\b`).test(s);
const clip = (s: string) => (s.length > MAX_QUOTE ? `${s.slice(0, MAX_QUOTE - 1).trimEnd()}…` : s);

/**
 * The sentence that names the province, preferring one that also names where the army came from.
 * `shape` narrows what counts: a trace also holds headings like "Checking ABY support".
 */
function pick<T extends { text: string }>(sources: T[], province: Province, from?: Province, shape = /./): { source: T; text: string } | undefined {
  const all = sources.flatMap((source) => sentences(source.text).filter((s) => names(s, province) && shape.test(s)).map((text) => ({ source, text })));
  return (from ? all.find((c) => names(c.text, from)) : undefined) ?? all[0];
}

/**
 * The one moment of a phase, or none. In order: the game ending, a power losing its last army,
 * a broken word, a home center changing hands. A broken word is a guess from the wording, so
 * its quote is the sentence that made the promise.
 */
function momentOf(map: GameMap, before: State, record: GamePhase, after: State, said: Said[]): Moment | undefined {
  const moved = new Set(record.moved);
  const moves = POWERS.flatMap((power) => (record.orders[power] ?? []).flatMap((o) => (o.action === "move" && moved.has(o.unit) ? [{ power, from: o.unit, to: o.to }] : [])));
  const taken = map.centers.filter((c) => after.owners[c] && after.owners[c] !== before.owners[c]);
  const cameFrom = (power: Power, province: Province) => moves.find((m) => m.power === power && m.to === province)?.from;
  const between = (from: Power, to: Power) => record.messages.filter((m) => m.from === from && m.to.includes(to));
  const message = ({ source, text }: { source: Message; text: string }): Quote => ({ power: source.from, kind: "message", to: source.to, broadcast: source.broadcast, text: clip(text) });

  const found = (): (Omit<Moment, "phase" | "quotes"> & { promise?: Quote }) | undefined => {
    const winner = after.result?.kind === "solo" ? after.result.winners[0] : undefined;
    if (winner) {
      const province = taken.findLast((c) => after.owners[c] === winner);
      return { kind: "solo", power: winner, victim: province ? before.owners[province] : undefined, province, from: province ? cameFrom(winner, province) : undefined };
    }
    if (after.result) return { kind: "limit" };
    for (const victim of POWERS) {
      if (!Object.values(before.units).includes(victim) || Object.values(after.units).includes(victim)) continue;
      const lost = record.dislodged.findLast((d) => d.power === victim);
      const by = lost && moves.find((m) => m.to === lost.unit);
      return by ? { kind: "out", power: by.power, victim, province: by.to, from: by.from } : { kind: "out", power: victim };
    }
    for (const m of moves) {
      const victim = before.owners[m.to] ?? before.units[m.to];
      if (!victim || victim === m.power) continue;
      const promise = between(m.power, victim)
        .flatMap((source) => sentences(source.text).map((text) => ({ source, text })))
        .find((c) => promises(c.text, m.to));
      if (promise) return { kind: "broken", power: m.power, victim, province: m.to, from: m.from, promise: message(promise) };
    }
    const homes = new Set(Object.values(map.homes).flat());
    for (const province of taken) {
      const power = after.owners[province];
      if (power && homes.has(province)) return { kind: "home", power, victim: before.owners[province], province, from: cameFrom(power, province) };
    }
    return undefined;
  };

  const hit = found();
  if (!hit) return undefined;
  const { promise, ...moment } = hit;
  const { power, victim, province, from } = moment;
  const quotes: Quote[] = [];
  if (promise) quotes.push(promise);
  // What the mover told the loser this phase, or failing that what the loser told the mover.
  else if (power && victim && province) {
    const told = pick(between(power, victim), province, from) ?? pick(between(victim, power), province, from);
    if (told) quotes.push(message(told));
  }
  if (power && province) {
    const thought = pick(said.filter((s) => s.power === power), province, from, /[.!?]$/);
    if (thought) quotes.push({ power, kind: thought.source.kind, text: clip(thought.text) });
  }
  return { phase: record.phase, ...moment, quotes };
}

/** A game's turning points, at most one per phase, found from its spectator events. */
export function findMoments(events: GameEvent[]): Moment[] {
  const game = events.find((e) => e.kind === "game");
  if (!game) return [];
  const moments: Moment[] = [];
  const said: Record<string, Said[]> = {};
  const ordered: Record<string, number> = {};
  let before: State | undefined;
  for (const e of events) {
    if (e.kind === "phase") before = e.state;
    else if (e.kind === "trace" && (e.item.type === "thinking" || e.item.type === "text")) (said[e.phase] ??= []).push({ power: e.power, kind: e.item.type, text: e.item.text, at: e.at });
    else if (e.kind === "tool" && e.tool === "submit_orders") ordered[`${e.phase} ${e.power}`] = e.at;
    else if (e.kind === "resolved" && before) {
      const phase = e.record.phase;
      // Only what a player wrote before its orders went in: afterwards it is reporting, not deciding.
      const deciding = (said[phase] ?? []).filter((s) => s.at <= (ordered[`${phase} ${s.power}`] ?? Infinity));
      const moment = momentOf(game.map, before, e.record, e.state, deciding);
      if (moment) moments.push(moment);
    }
  }
  return moments;
}
