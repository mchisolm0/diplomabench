import { expect, test } from "vitest";
import type { Agent } from "./agents.ts";
import { playGame } from "./game.ts";
import { POWERS, type Power } from "./map.ts";
import { normalizeMessages } from "./press.ts";

const where = { phase: "S1901", round: 1 };

test("broadcasts expand to other active powers; bad recipients and empty text are dropped", () => {
  const active: Power[] = ["ALPHA", "BETA", "GAMMA"];
  const { messages, rejected } = normalizeMessages("ALPHA", active, [
    { to: ["ALL"], text: "hello" },
    { to: ["beta", "ALPHA", "DELTA"], text: " deal? " },
    { to: ["ALPHA"], text: "self" },
    { to: ["GAMMA"], text: "  " },
  ], where);
  expect(messages.map((m) => [m.to, m.broadcast, m.text])).toEqual([
    [["BETA", "GAMMA"], true, "hello"],
    [["BETA"], false, "deal?"],
  ]);
  expect(rejected).toBe(2);
});

test("players only see messages they sent or received", async () => {
  const seen: Partial<Record<Power, string[]>> = {};
  const agent: Agent = {
    id: "test",
    talk: async (view) => {
      seen[view.power] = view.messages.map((m) => m.text);
      return { messages: view.power === "ALPHA" ? [{ to: ["BETA"], text: "secret" }] : [] };
    },
    decide: async () => ({ orders: [] }),
  };
  const seats = Object.fromEntries(POWERS.map((p) => [p, agent])) as Record<Power, Agent>;
  const log = await playGame(seats, { pressRounds: 2 });
  expect(log.phases[0]?.messages).toHaveLength(2);
  expect(seen.BETA).toContain("secret");
  expect(seen.GAMMA).toEqual([]);
});
