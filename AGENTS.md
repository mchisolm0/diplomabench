# Diplomabench

Rules and goals live in `SPEC.md`. Keep it in sync with code.

- TypeScript, pnpm, Vitest. `pnpm test`, `pnpm typecheck`. Node runs `.ts` directly.
- Play: `pnpm game --model sonnet` or `pnpm game --seats sonnet,opus,random,hold,sonnet --map v2 --press 1 --games 5`. Logs go to `runs/` (ignored).
- Claude seats need `~/.config/diplomabench/claude-auth.json` holding only `apiKeyHelper` and `env` from `~/.claude/settings.json`. `--bare` keeps CLAUDE.md out of the player's context.
- Session seats (`claude-code:<model>`, `codex:<model>`, `opencode:<provider/model>`) also need `~/.config/diplomabench/codex.toml` (provider settings only, absolute paths since HOME is replaced) and `~/.config/diplomabench/opencode.json` (`{"provider": ...}`, absolute `{file:}` paths). Try a seat with `--phases 2`. After changing harness flags or upgrading a harness, run `pnpm isolation <seats>`.
- No `any`. Maps are data in `src/map.ts`; the engine reads the map from `state.map`. Bump `PROMPT_VERSION` on any prompt change.
- Engine stays pure: state and orders in, new state and results out. No I/O.
- Adjudicator or map changes: run `DIPLOMACY_PYTHON=<venv>/bin/python pnpm oracle 4000 <seed> <map>`, which fuzzes against the upstream `diplomacy` package (`pip install diplomacy==1.1.2`). Upstream breaks DATC 5.B.7 (own support for an attack on you still defends in a head-to-head), so that one known disagreement is expected.
- `pnpm rate runs/<batch> ...` fits ratings across batches. `pnpm analyze runs/<batch> ...` replays logs for setup and map signals: blocked builds, runaway leaders, opening bounces, per-model aggression and broken promises.
- Watch a session game with `pnpm watch <run dir>` (live or replay; Testing shows thinking and tool calls), or save a replay with `--html <file>`. Harness trace parsing lives in `src/harness.ts` next to each harness; the page is `src/viewer.html`, plain JS with no build.
- Probes: `pnpm probe <scenario|all> --players <harness>:<model>,...`. A scenario is data in `src/scenarios/`; its script must replay with legal orders (`replay` throws otherwise), and `src/scenario.test.ts` pins each position to its intended answer. Changing a scenario changes its results, so treat scenarios like prompts.
- Tests cover adjudication cases and the game loop, not wiring.
