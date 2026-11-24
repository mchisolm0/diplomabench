import { expect, test } from "vitest";
import type { State } from "./engine.ts";
import type { GamePhase } from "./game.ts";
import { MAPS, type Power } from "./map.ts";
import { findMoments } from "./moments.ts";
import type { Message } from "./press.ts";
import type { GameEvent } from "./spectate.ts";

const board = (units: State["units"], owners: State["owners"], result: State["result"] = null): State => ({ map: "v2", year: 1902, season: "F", units, owners, result });
const message = (from: Power, to: Power[], text: string): Message => ({ phase: "F1902", round: 1, from, to, broadcast: false, text });
const record = (r: Partial<GamePhase>): GamePhase => ({ phase: "F1902", orders: {}, fallbacks: [], moved: [], dislodged: [], builds: [], disbands: [], ambiguous: false, messages: [], rejectedMessages: 0, decisions: {}, talks: [], ...r });

/** One Fall phase as a spectator saw it: the board, what was said and thought, then the resolution. */
function phase(before: State, after: State, r: Partial<GamePhase>, between: GameEvent[] = []): GameEvent[] {
  return [
    { at: 0, kind: "game", map: MAPS.v2, mode: "rounds", press: 1, seats: { ALPHA: "a", BETA: "b", GAMMA: "c", DELTA: "d", EPSILON: "e" }, state: before, history: [], messages: [] },
    { at: 1, kind: "phase", phase: "F1902", state: before, deadline: 0, active: ["DELTA", "EPSILON"] },
    ...between,
    { at: 9, kind: "resolved", record: record(r), state: after },
  ];
}

// EPSILON walks DEP into DEL, DELTA's undefended home.
const before = board({ DEP: "EPSILON", EPS: "EPSILON", GDE: "DELTA" }, { DEL: "DELTA", GDE: "DELTA", EPS: "EPSILON", DEP: "EPSILON" });
const after = board({ DEL: "EPSILON", EPS: "EPSILON", GDE: "DELTA" }, { DEL: "EPSILON", GDE: "DELTA", EPS: "EPSILON", DEP: "EPSILON" });
const taken: Partial<GamePhase> = { orders: { EPSILON: [{ unit: "DEP", action: "move", to: "DEL" }] }, moved: ["DEP"] };

test("a move into a province the mover just promised to leave alone is a broken word, quoted", () => {
  const messages = [message("EPSILON", ["DELTA"], "Delta - agree to peace. I will hold DEP and keep EMR holding (no move to DEL/DMR). You hold GDE.")];
  expect(findMoments(phase(before, after, { ...taken, messages }))).toEqual([
    { phase: "F1902", kind: "broken", power: "EPSILON", victim: "DELTA", province: "DEL", from: "DEP", quotes: [{ power: "EPSILON", kind: "message", to: ["DELTA"], broadcast: false, text: "I will hold DEP and keep EMR holding (no move to DEL/DMR)." }] },
  ]);
});

test("a threat is not a promise: the same move is then a home center changing hands", () => {
  const messages = [message("EPSILON", ["DELTA"], "If you do not move out of GDE I take DEL. Last warning.")];
  expect(findMoments(phase(before, after, { ...taken, messages }))).toMatchObject([{ kind: "home", power: "EPSILON", victim: "DELTA", province: "DEL", quotes: [{ kind: "message", text: "If you do not move out of GDE I take DEL." }] }]);
});

test("losing a last army outranks the rest, and the mover's own words come from before its orders", () => {
  const start = board({ DEP: "EPSILON", EPS: "EPSILON", DEL: "DELTA" }, { DEL: "DELTA", EPS: "EPSILON", DEP: "EPSILON" });
  const end = board({ DEL: "EPSILON", EPS: "EPSILON" }, { DEL: "EPSILON", EPS: "EPSILON", DEP: "EPSILON" });
  const thought = (at: number, text: string): GameEvent => ({ at, kind: "trace", phase: "F1902", power: "EPSILON", item: { type: "text", text } });
  const events = phase(start, end, { ...taken, dislodged: [{ unit: "DEL", power: "DELTA" }] }, [
    thought(2, "**Checking DEL support**"),
    thought(3, "DELTA holds DEL alone. EPS backs DEP into DEL at two to one."),
    { at: 4, kind: "tool", phase: "F1902", power: "EPSILON", tool: "submit_orders", args: {}, result: "Recorded: DEP - DEL." },
    thought(5, "Submitted DEP to DEL."),
  ]);
  expect(findMoments(events)).toEqual([{ phase: "F1902", kind: "out", power: "EPSILON", victim: "DELTA", province: "DEL", from: "DEP", quotes: [{ power: "EPSILON", kind: "text", text: "EPS backs DEP into DEL at two to one." }] }]);
});

test("the game ending is the moment of its phase", () => {
  const won = { ...after, result: { kind: "solo" as const, winners: ["EPSILON" as const] } };
  expect(findMoments(phase(before, won, taken))).toMatchObject([{ kind: "solo", power: "EPSILON", victim: "DELTA", province: "DEL", from: "DEP" }]);
  expect(findMoments(phase(before, { ...after, result: { kind: "limit", winners: [] } }, taken))).toEqual([{ phase: "F1902", kind: "limit", quotes: [] }]);
});
