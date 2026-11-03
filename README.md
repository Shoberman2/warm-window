# warm-window

**Find your Claude Code idle tax:** what you pay to re-cache a long conversation after it sits idle, and what keeping the cache warm or compacting first would have saved.

```
npx warm-window scan
```

Runs locally in a few seconds. It reads only token counts and timestamps from `~/.claude/projects`, never your messages, and sends nothing anywhere. No dependencies.

## Why this exists

Every time an agent replies, it re-sends the whole conversation to the model. **Prompt caching** makes that cheap: the provider remembers the conversation it already processed, and re-reading it costs only 2.5–10% of the normal price.

But the cache **expires**, after 5 minutes or 1 hour depending on settings. When you come back from lunch to a 200k-token session, the whole thing has to be cached again at the *premium* write price. A subagent waiting more than 5 minutes on a slow build hits the same problem. Your hit rate still looks like 98%, while a big share of your bill comes from these few cold returns.

Providers ship the building blocks (cache diagnostics, compaction, pre-warming), but nothing decides **when** to use them. Every compaction trigger today is based on token count, not on whether you just walked away.

`warm-window` measures that gap on your own history and simulates the fixes.

## What you get

```
  THE RECEIPT
  Cache hit rate          97.9% (looks great, hides the expensive moments)
  Cache spend (est.)      $3681 = $2122 reads + $1560 writes
  Cold returns            457 times a conversation resumed after its cache expired (~197k tokens re-cached each)
    you took a break       193 · $303 idle tax
    a subagent waited      264 · $297 idle tax (slow tool, 5-min cache)
  Re-cached after gaps    89.9M tokens = 40.6% of all cache writes
  Idle tax                $600 = 16.3% of cache spend, extra paid vs. a warm cache

  HOW LONG THE GAPS WERE  (you / subagent)
  5-15 min    ████████████████████████    3 / 236  · $272
  1-4 h       ██████████░░░░░░░░░░░░░░   90 / 7    · $142
  ...

  WHAT EACH FIX WOULD HAVE COST  (same 1426 gaps, cache cost around them)
  What you did                                                         $633  baseline
  Force 1-hour cache everywhere                                        $797  costs $164 more
  Compact right before the cache expires                               $225  saves $408 (64.5%)
  Keep warm up to 120 min, then let it expire                          $311  saves $322 (50.9%)
  Keep warm up to 120 min, then compact (Warm Window)                  $140  saves $493 (77.9%)
  Best possible (hindsight, not achievable)                          $92.08  saves $541 (85.5%)
```

*(Real output from the author's three months of Claude Code use.)*

### The fixes it simulates

| Policy | What it does | Trade-off |
|---|---|---|
| **Force 1-hour cache** | Every cache write uses the 1-hour lifetime (`"promptCacheTtl": "1h"`) | Every write costs 2x instead of 1.25x. Helps only if your breaks are 5–60 min. |
| **Compact before expiry** | Summarize the conversation just before the cache expires, while re-reading it is still cheap | Each compaction loses detail. Summaries keep only a fraction of exact file paths and IDs ([Compact-Bench](https://arxiv.org/html/2610.31710)). |
| **Keep warm** | Send a tiny no-output request (`max_tokens: 0`) just before expiry so the cache stays alive | Cheap with 1-hour caches, expensive with 5-minute ones. May count against plan usage. |
| **Warm Window** (keep warm, then compact) | Keep warm through short breaks; if you're gone longer than *K* minutes, compact while still warm. *K* is tuned on your history. | The policy this project wants to automate. |
| **Hindsight** | The cheapest choice for each gap if you'd known when you'd come back | A floor, not achievable. |

## Options

```
npx warm-window scan [options]

  --dir <path>          transcripts folder (default: ~/.claude/projects)
  --days <n>            only the last n days
  --min-write <tokens>  smallest re-cache that counts as a cold return (default 20000)
  --summary <tokens>    assumed compaction summary size (default 10000)
  --json                machine-readable output
  --receipt             one-line shareable receipt
  --paths               show full project paths
  --top <n>             projects to list (default 5)
```

## How the numbers are computed

- **Cold return:** a cache write of at least 20k tokens after a gap of more than 5 minutes in the same session or subagent. Some may be deliberate fresh starts, so treat the idle tax as an upper bound.
- **Idle tax:** what those re-caches cost, minus what the same tokens would have cost as warm cache reads.
- **Prices:** Anthropic API list prices per model, with cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL) of the input price. On a Pro or Max plan you pay in usage limits rather than dollars, but the proportions hold.
- **Simulations:** each policy is replayed on every gap of 4 minutes or more in your history. They assume the conversation would otherwise have gone the same way, and they ignore that compaction also makes later turns cheaper. A summary is assumed to be 10k output tokens (`--summary`).
- **Not modeled:** what a compaction loses. That is the next thing to measure. See the roadmap.

## Roadmap

This is the first, measuring-only step. What gets built next depends on whether people want it:

- [ ] **Auto-policy:** a Claude Code hook or proxy that keeps the cache warm and compacts before expiry for you. **[👍 issue #1](https://github.com/Shoberman2/warm-window/issues/1) if you want this.**
- [ ] **Quality guard:** a deterministic index of files, IDs and done/pending tasks kept alongside each summary, so compaction stops forgetting exact details.
- [ ] **Replay scoring:** grade a compaction policy on your own past sessions (cost *and* what it forgot).
- [ ] Support for other agents (Codex CLI, OpenCode) and the raw Anthropic and OpenAI APIs.

## Background

Inspired by Lee Robinson's Stanford CS146S lecture *How always-on agents work*: "treat a cache miss like a bug" and "compact while the cache is still warm". Also informed by Manus's [context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) write-up and Claude Code cache-TTL issues [#46829](https://github.com/anthropics/claude-code/issues/46829) and [#103673](https://github.com/anthropics/claude-code/issues/103673).

Not affiliated with Anthropic.

## License

MIT
