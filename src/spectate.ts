import { appendFileSync } from "node:fs";
import type { State } from "./engine.ts";
import type { GamePhase } from "./game.ts";
import type { GameMap, Power } from "./map.ts";
import type { Mode, Review } from "./live.ts";
import type { Message } from "./press.ts";

/** One step of a player's own reasoning, as its harness reports it. */
export type TraceItem = { type: "thinking" | "text" | "tool_call" | "tool_result"; text: string; name?: string };

/**
 * Everything a spectator can see, in the order it happened: the board, every
 * message (private ones too), every game tool call and its result, and each
 * player's harness trace. A live game writes these to `<game>.events.jsonl`;
 * `pnpm watch` shows them live or replays them.
 */
export type GameEvent = { at: number } & (
  | { kind: "game"; map: GameMap; mode: Mode; press: number; seats: Record<Power, string>; state: State; history: GamePhase[]; messages: Message[] }
  | { kind: "phase"; phase: string; state: State; deadline: number; active: Power[] }
  | { kind: "tool"; phase: string; power: Power; tool: string; args: Record<string, unknown>; result: string }
  | { kind: "message"; message: Message }
  | { kind: "trace"; phase: string; power: Power; item: TraceItem }
  | { kind: "turn"; phase: string; power: Power; error?: string; durationMs?: number; reply?: string }
  | { kind: "resolved"; record: GamePhase; state: State }
  /** Sent when each review turn starts and after each submission, with everything submitted so far. */
  | { kind: "review"; stage: "debrief" | "peers"; review: Review }
);

/** Distributes `Omit` over the union, so each event keeps its own fields. */
type Unstamped<E> = E extends unknown ? Omit<E, "at"> : never;

export type Spectator = (e: Unstamped<GameEvent>) => void;

/** Appends each event to `path` as one JSON line. Synchronous, so lines stay in order. */
export const fileSpectator =
  (path: string): Spectator =>
  (e) =>
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...e })}\n`);
