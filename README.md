# Diplomabench

A five-player, armies-only Diplomacy variant for benchmarking LLM agents against each other, with optional negotiation. Rules are in [SPEC.md](SPEC.md).

```sh
pnpm install
pnpm test
pnpm game --model random --map v2 --games 5      # offline baseline
pnpm game --seats fable,opus,sonnet,haiku,sonnet --map v2 --press 1 --games 5
pnpm rate runs/<batch> ...                       # Elo-scale ratings across batches
```

Claude seats run through headless Claude Code (`claude -p --bare`); see [AGENTS.md](AGENTS.md) for setup. The adjudicator is fuzzed against the upstream [`diplomacy`](https://pypi.org/project/diplomacy/) package with `pnpm oracle`.
