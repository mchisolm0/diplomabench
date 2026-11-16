# Mini Diplomacy v1

A five-player, armies-only Diplomacy variant that is small enough for humans to play and for LLM agents to be benchmarked against each other. Ported from the legacy spec (see `LEGACY.md`) with one rule change: Hold support follows standard Diplomacy.

## Goals

- Keep the core loop: simultaneous orders, support, center control, solo pressure, optional negotiation.
- Small enough rules for reliable prompting, parsing, and replay.
- Benchmark runs hold everything fixed except the OpenRouter model ID assigned to each power.

## Board

Defined in `src/map.ts`. Five homes on a ring (`ALP BET GAM DEL EPS`), a neutral frontier center between each pair of neighbors (`ABY BGR GDE DEP EAL`), and `MID` in the center. All 11 provinces are supply centers. Each power starts with one army in its home and owns it; every other center starts neutral.

## Turns

- Each year has Spring and Fall movement phases, starting in 1901 (`S1901M`, `F1901M`, ...).
- Every power submits one order per unit. Orders resolve simultaneously.
- Center ownership updates after Fall movement.
- Adjustment after Fall: a power with more centers than units builds in its home if it owns it and it is vacant. Every province is a center and each unit owns where it stands, so a power never has more units than centers and there are no disbands.
- No fleets, coasts, convoys, or retreats. A dislodged unit is removed.

## Orders

```json
{"unit": "ALP", "action": "hold"}
{"unit": "ALP", "action": "move", "to": "ABY"}
{"unit": "ABY", "action": "support_hold", "target": "ALP"}
{"unit": "ABY", "action": "support_move", "target": "ALP", "to": "EAL"}
```

`unit` and `target` are the units' current provinces. Missing or illegal orders become Hold and are logged as fallbacks.

## Resolution

- Base strength 1; each valid support adds 1.
- Support Hold requires the supporter to be adjacent to the held province. Support Move requires adjacency to the destination.
- Support is cut by any enemy attack on the supporter, except an attack from the province the support is directed into, which cuts only by dislodging. A dislodged supporter gives no support.
- A move must be the unique strongest attack into its destination, and strictly stronger than the defender's strength when the defender does not leave.
- A unit that successfully moves does not defend its origin, so chains and rings of three or more units succeed.
- A failed move leaves the unit in place with strength 1. Hold support applies to any unit not ordered to move (Hold or Support).
- Head-to-head moves do not swap. The stronger attack dislodges; equal attacks bounce.
- A power cannot dislodge its own unit, and support from the defender's own power does not count toward dislodging it.

## End

- Solo: 6+ centers after a Fall count.
- Turn limit: after Fall 1908, a unique center leader wins on centers; a tie for the most centers is a shared draw.
- Eliminated: no units and no centers. Stays in logs.

## Benchmark

- **No-press** (default): agents see public state, their power, fixed instructions, and their legal orders. No messages.
- **Free-press** (later): a fixed number of message rounds before each movement phase. Messages never change state; they are logged and shown to the order prompt.
- The harness owns state, legal orders, prompts, model calls, parsing, fallback, logging, and scoring. Prompt version, temperature, max tokens, timeout, and retries are fixed per run and recorded.
- Same-model runs give every power one model. Mixed-model runs rotate models through all five seats across replicates.

## Players

- `claude-code/<model>`: a headless `claude -p --bare` call with no tools and a JSON schema for `{plan, orders}`. OpenRouter comes later.
- `baseline/hold` and `baseline/random` for offline runs and tests.

## Human play

A human can take any seat against model or baseline agents, through the same game loop the benchmark uses.
