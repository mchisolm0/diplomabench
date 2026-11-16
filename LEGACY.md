# Legacy attempt (June to July 2026)

Built by Codex orchestrator threads on the MacBook in `~/oss/diplomacy`, a clone of upstream `diplomacy/diplomacy`. It was never pushed. A full copy with all branches is on Nobara at `~/oss/diplomacy-legacy`; uncommitted UI prototypes are in its `prototypes-uncommitted/`.

- Latest branch: `codex/press-human-negotiation-v0.2`. Code is in `diplomacy/mini_diplomacy/` (about 11.6k lines of Python plus tests).
- Worth reading: `core.py` (adjudication, about 800 lines), `agents.py` (OpenRouter client, prompts, baselines), `docs/mini_diplomacy.rst`, `docs/benchmark_calibration_v1.md`.
- No real model game was ever run. Calibration used offline baselines only, and the press demo used a stub model.
- Baselines (`hold`, `legal`, `center_seek`, `seeded_random`, `support_aware`) showed seat-advantage warnings on a map that is symmetric, in 150 games.
