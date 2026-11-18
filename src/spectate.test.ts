import { expect, test } from "vitest";
import { holdDriver, playLiveGame, type Driver } from "./live.ts";
import { POWERS, type Power } from "./map.ts";
import type { Spectator } from "./spectate.ts";

test("a spectator sees the board, private messages, tool calls with results, traces and the resolution, in order", async () => {
  const events: Parameters<Spectator>[0][] = [];
  const alpha: Driver = {
    id: "test",
    turn: async (t) => {
      t.trace({ type: "thinking", text: "ABY looks free." });
      await t.call("send_message", { to: ["BETA"], text: "I'm taking ABY." });
      await t.call("send_message", { to: ["ALPHA"], text: "Note to self." });
      await t.call("submit_orders", { orders: ["ALP - ABY"] });
      await t.call("end_turn");
      return { reply: "Took ABY." };
    },
  };
  const seats = Object.fromEntries(POWERS.map((p) => [p, p === "ALPHA" ? alpha : holdDriver])) as Record<Power, Driver>;
  await playLiveGame(seats, { map: "v2", press: 1, mode: "async", maxPhases: 1, spectator: (e) => events.push(e) });

  expect(events[0]?.kind).toBe("game");
  expect(events[1]).toMatchObject({ kind: "phase", phase: "S1901" });
  expect(events.at(-1)).toMatchObject({ kind: "resolved", record: { phase: "S1901", moved: ["ALP"] } });
  const mine = events.filter((e) => "power" in e && e.power === "ALPHA").map((e) => (e.kind === "tool" ? `${e.tool}: ${e.result.split("\n")[0]}` : e.kind));
  expect(mine).toEqual([
    "trace",
    "send_message: Delivered to BETA.",
    "send_message: Error: Recipients must be other surviving powers or ALL, and text must not be empty.",
    "submit_orders: Recorded: ALP - ABY.",
    "end_turn: Turn ended. Stop now; you will hear from the game when the next phase starts.",
    "turn",
  ]);
  expect(events.filter((e) => e.kind === "message")).toEqual([{ kind: "message", message: expect.objectContaining({ from: "ALPHA", to: ["BETA"], text: "I'm taking ABY." }) }]);
});
