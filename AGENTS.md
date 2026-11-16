# Mini Diplomacy

Rules and goals live in `SPEC.md`. Keep it in sync with code.

- TypeScript, pnpm, Vitest. `pnpm test`, `pnpm typecheck`. Node runs `.ts` directly.
- Play: `pnpm game --model sonnet` or `pnpm game --seats sonnet,opus,random,hold,sonnet`. Logs go to `runs/` (ignored).
- Claude seats need `~/.config/diplomabench/claude-auth.json` holding only `apiKeyHelper` and `env` from `~/.claude/settings.json`. `--bare` keeps CLAUDE.md out of the player's context.
- No `any`. Derive types from data (`src/map.ts`) instead of restating them.
- Engine stays pure: state and orders in, new state and results out. No I/O.
- Adjudicator changes: run `DIPLOMACY_PYTHON=<venv>/bin/python pnpm oracle 4000 <seed>`, which fuzzes against the upstream `diplomacy` package (`pip install diplomacy==1.1.2`). Upstream breaks DATC 5.B.7 (own support for an attack on you still defends in a head-to-head), so that one known disagreement is expected.
- `pnpm analyze runs/<batch> ...` replays logs for setup and map signals: blocked builds, runaway leaders, opening bounces, per-model aggression and broken promises.
- Tests cover adjudication cases and the game loop, not wiring.
