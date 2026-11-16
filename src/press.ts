import type { Power } from "./map.ts";

export const MAX_MESSAGES_PER_TURN = 3;
export const MAX_MESSAGE_CHARS = 600;

export type Message = {
  phase: string;
  round: number;
  from: Power;
  /** Resolved recipients. A broadcast lists every other active power. */
  to: Power[];
  broadcast: boolean;
  text: string;
};

/**
 * Turns a player's raw message list into deliverable messages. Bad entries are
 * dropped and counted, never fatal: a malformed turn is just silence.
 */
export function normalizeMessages(
  from: Power,
  active: readonly Power[],
  raw: readonly unknown[],
  where: { phase: string; round: number },
): { messages: Message[]; rejected: number } {
  const messages: Message[] = [];
  let rejected = 0;
  for (const entry of raw.slice(0, MAX_MESSAGES_PER_TURN)) {
    const parsed = parse(entry);
    const others = active.filter((p) => p !== from);
    const broadcast = parsed?.to.includes("ALL") ?? false;
    const to = broadcast ? others : others.filter((p) => parsed?.to.includes(p));
    const text = parsed?.text.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!text || to.length === 0) {
      rejected++;
      continue;
    }
    messages.push({ ...where, from, to, broadcast, text });
  }
  return { messages, rejected: rejected + Math.max(0, raw.length - MAX_MESSAGES_PER_TURN) };
}

function parse(entry: unknown): { to: string[]; text: string } | null {
  if (typeof entry !== "object" || entry === null) return null;
  const { to, text } = entry as { to?: unknown; text?: unknown };
  if (typeof text !== "string") return null;
  const list = Array.isArray(to) ? to : [to];
  return { to: list.filter((t): t is string => typeof t === "string").map((t) => t.toUpperCase()), text };
}

export const canSee = (power: Power, m: Message) => m.from === power || m.to.includes(power);
