# Diplomabench

A five-player, armies-only Diplomacy variant that is small enough for humans to play and for LLM agents to be benchmarked against each other. Ported from the legacy spec (see `LEGACY.md`) with one rule change: Hold support follows standard Diplomacy.

## Goals

- Keep the core loop: simultaneous orders, support, center control, solo pressure, optional negotiation.
- Small enough rules for reliable prompting, parsing, and replay.
- Benchmark runs hold everything fixed except the OpenRouter model ID assigned to each power.

## Maps

Maps live in `src/map.ts` as data: provinces, centers, homes, adjacency, plus the rules that vary by map (where builds go, solo threshold, last year). Pick one with `--map`. Each power starts with one army in each home and owns it; every other center starts neutral.

- **v1**: five homes on a ring (`ALP BET GAM DEL EPS`), a neutral frontier center between each pair of neighbors (`ABY BGR GDE DEP EAL`), and `MID` in the center. All 11 provinces are centers. Builds only in the home center.
- **v2**: v1's 11 centers, plus a non-center march in front of each home (`AMR BMR GMR DMR EMR`). Marches ring the board and are the only way to `MID`. Builds in any owned center. In v1, 23% of owed builds were lost to a power's own army standing on its home, and strong players spent Fall turns vacating it.

## Turns

- Each year has Spring and Fall movement phases, starting in 1901 (`S1901M`, `F1901M`, ...).
- Every power submits one order per unit. Orders resolve simultaneously.
- Center ownership updates after Fall movement.
- Adjustment after Fall: a power with more centers than units builds the difference in empty owned centers the map allows, home first, then nearest home. A power with more units than centers disbands its units farthest from home. Ties go by province order. On v1 every unit owns where it stands, so disbands never happen.
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

## End and scoring

- Solo: the map's threshold (6 on v1 and v2) after a Fall. The winner scores 1 and every other power 0.
- Turn limit: after Fall 1908, each power scores its centers divided by the map's total.
- Players are told this scoring (prompt v3). Prompt v2 said only "ranked by centers", and the unique 1903 leader finished alone on top in 13 of 14 games: nobody had a reason to stop a solo.
- Eliminated: no units and no centers. Stays in logs.

## Benchmark

- **No-press** (default): agents see public state, their power, fixed instructions, and their legal orders. No messages.
- **Press** (`--press N`): N message rounds before each movement phase. Every surviving power acts at once in each round. Up to 3 messages per turn, 600 characters each, to named powers or `ALL`. Players see messages they sent or received from the last 4 phases. Messages never change state.
- The harness owns state, legal orders, prompts, model calls, parsing, fallback, logging, and scoring. Prompt version, temperature, max tokens, timeout, and retries are fixed per run and recorded.
- Same-model runs give every power one model. Mixed lineups rotate one seat per game, so batches of 5 games give each model every seat.
- Headline number is a rating, not a raw average, because a model's average score depends on who it sat with. `pnpm rate` fits Bradley-Terry ratings on the Elo scale: every pair of seats held by different models in one game is a comparison won by the higher score. A 90% interval comes from resampling games. Games pool by prompt version and map.

## Players

- `claude-code/<model>`: a headless `claude -p --bare` call with no tools and a JSON schema for `{plan, orders}`. OpenRouter comes later.
- `baseline/hold` and `baseline/random` for offline runs and tests.

## Human play

A human can take any seat against model or baseline agents, through the same game loop the benchmark uses.
