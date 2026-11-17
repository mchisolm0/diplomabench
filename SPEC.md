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
- **Press** (`--press N`): N message rounds before each movement phase. Every surviving power acts at once in each round. Up to 3 messages per turn, 600 characters each, to named powers or `ALL`. Players see every message they sent or received this game (prompt v4; v2 and v3 showed only the last 4 phases). Messages never change state.
- The harness owns state, legal orders, prompts, model calls, parsing, fallback, logging, and scoring. Prompt version, temperature, max tokens, timeout, and retries are fixed per run and recorded.
- Same-model runs give every power one model. Mixed lineups rotate one seat per game, so batches of 5 games give each model every seat.
- Headline number is a rating, not a raw average, because a model's average score depends on who it sat with. `pnpm rate` fits Bradley-Terry ratings on the Elo scale: every pair of seats held by different models in one game is a comparison won by the higher score. A 90% interval comes from resampling games. Games pool by prompt version and map.

## Players

- One-call players (`--seats sonnet,...`): a headless `claude -p --bare` call per decision with no tools and a JSON schema for `{plan, orders}`. The prompt re-describes the game each time.
- Session players (`--seats claude-code:fable,codex:gpt-6.1-sol,opencode:opencode-go/glm-5.3-flash,...`): one harness session per power for the whole game, resumed each phase. The player decides what to look at and when, compacts its own context, and keeps private notes. One-call and session seats can't share a game.
- `hold` and `random` baselines work with either.

## Session players

- The game serves its tools over MCP (Streamable HTTP, `src/mcp.ts`). Each power gets its own token, so a player only ever sees its own messages and notes.
- Tools: `rules`, `status`, `map`, `legal_orders`, `history`, `inbox`, `search_messages`, `send_message`, `wait`, `simulate` (try orders through the real adjudicator), `submit_orders` (resubmitting replaces), `end_turn`, `read_notes`, `write_notes`.
- Each phase, every surviving power gets one turn: a short update (phase, last results, unread count). The first turn also carries the rules. The phase resolves when everyone has called `end_turn`, or at the deadline (`--deadline`, seconds), when stragglers are stopped and their last submitted orders stand.
- `--mode rounds` (default): messages are held until every power still working has called `wait`, then delivered together. Up to `--press` rounds of 3 messages each. Reproducible and fair to slow models.
- `--mode async`: messages are delivered as soon as they are sent, and `wait` returns when one arrives. Up to 10 messages per phase. Closer to real Diplomacy, but speed now matters, so durations are logged.
- Harnesses (`src/harness.ts`) run each seat with only the game tools and none of the user's instructions, skills, hooks, plugins, or memory. Every seat works in an empty git repo under a private `/tmp/diplomabench-*` root (mode 0700, outside HOME, so no parent-folder config search reaches the user's files) and gets an allowlisted environment. Claude Code runs with `--bare --tools ""`, its own config dir, and its MCP config in a 0600 file. Codex runs with its own `CODEX_HOME` and HOME, shell off and a read-only sandbox. Code mode stays on, since newer models reach MCP tools through it. OpenCode runs as a standalone server with HOME replaced, project config off, and every built-in permission denied.
- `pnpm isolation <seats>`: each seat reports its tools and instructions and tries to read a canary file. Then every file the seat wrote is scanned for the canary, the user's instruction files and skill names, and any MCP server other than the game's. Run it after harness upgrades. Seat roots are kept after a game; they hold full transcripts, including private messages.
- Ratings label seats `<harness>/<model>`, and pool session games apart from one-call games.

## Human play

A human can take any seat against model or baseline agents, through the same game loop the benchmark uses.
