# Mini Diplomacy

Rules and goals live in `SPEC.md`. Keep it in sync with code.

- TypeScript, pnpm, Vitest. `pnpm test`, `pnpm typecheck`.
- No `any`. Derive types from data (`src/map.ts`) instead of restating them.
- Engine stays pure: state and orders in, new state and results out. No I/O.
- Tests cover adjudication cases and the game loop, not wiring.
