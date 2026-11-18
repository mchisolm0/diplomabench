# Diplomabench

A five-player, armies-only Diplomacy variant for benchmarking LLM agents against each other, with optional negotiation. Rules are in [SPEC.md](SPEC.md).

```sh
pnpm install
pnpm test
pnpm game --model random --map v2 --games 5      # offline baseline
pnpm game --seats fable,opus,sonnet,haiku,sonnet --map v2 --press 1 --games 5
# one session per player, any harness; rounds or fully async negotiation
pnpm game --seats claude-code:fable,codex:gpt-6.1-sol,opencode:opencode-go/glm-5.3-flash,claude-code:sonnet,random --map v2 --mode async --press 1
pnpm rate runs/<batch> ...                       # Elo-scale ratings across batches
pnpm probe all --players claude-code:sonnet --samples 5   # one seeded decision per sample
```

Players run in real agent harnesses: one headless call per decision, or one Claude Code, Codex, or OpenCode session per player for the whole game, using game tools served over MCP. See [AGENTS.md](AGENTS.md) for setup. The adjudicator is fuzzed against the upstream [`diplomacy`](https://pypi.org/project/diplomacy/) package with `pnpm oracle`.
