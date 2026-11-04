# warm-window

**Find out how much you pay when your AI coding agent "forgets" a conversation during a break, and what would have prevented it.**

```
npx warm-window scan
```

`warm-window` is a free command-line tool for [Claude Code](https://claude.com/claude-code) users. It reads the usage logs Claude Code already keeps on your computer and shows you your **idle tax**: the extra money (or plan usage) spent re-loading long conversations after they sat idle. It then replays your real history to show what each possible fix would have saved.

- **Private:** runs entirely on your machine. It reads only token counts and timestamps, never your messages or code, and sends nothing anywhere.
- **Fast:** about 10 seconds for months of heavy use (4 GB of logs).
- **Zero setup:** no account, no API key, no dependencies. Needs Node.js 18 or newer.

> Not on npm yet? Run it straight from GitHub: `npx github:Shoberman2/warm-window scan`

---

## What it is

Every AI agent conversation has a **context**: everything said so far, plus files read, tool output and instructions. A long Claude Code session can hold 100,000–400,000 tokens of context, and the **whole context is sent to the model again on every single turn.**

To make that affordable, Anthropic uses **prompt caching**. The model provider keeps the already-processed conversation in memory, so re-reading it costs only 2.5–10% of the normal price, depending on the model (a **cache hit**). It's what makes long agent sessions affordable.

But the cache **expires**: after 5 minutes by default, or 1 hour if configured. When you return after it expires, the whole conversation has to be processed and stored again at the *premium* write price, 1.25x–2x the normal input price. That is a **cache miss**, and on a 200k-token session one miss costs as much as dozens of warm turns.

`warm-window` measures how often that happens to you, what it costs, and which strategy would have cost the least.

## Why you need it

**Your dashboard says everything is fine.** A typical heavy user sees a 95–98% cache hit rate and assumes caching is working. But hit rate counts tokens, not money. The few misses are the most expensive moments in your bill, and no existing tool reports them separately.

From the author's own three months of Claude Code use:

| | |
|---|---|
| Cache hit rate | **97.9%**, looks perfect |
| Times a long conversation went cold and was re-cached | **453** |
| Cost of those re-caches above a warm cache (the idle tax) | **$597, 16.2% of all cache spend** |
| Share of all cache writes that were just re-caching after a gap | **40.3%** |

It happens in two ways, and both surprised us:

1. **You take a break.** Lunch, a meeting, overnight. The 1-hour cache dies and the next message re-caches everything.
2. **A subagent waits.** Subagents use the 5-minute cache. If one waits more than 5 minutes on a slow build or test run, its whole conversation is re-cached. In the data above, this was **half the idle tax**, and invisible from the main session.

**The obvious fix barely helps.** Switching everything to the 1-hour cache sounds right, but every write then costs 2x instead of 1.25x, and it does nothing for breaks over an hour. On the history above it **roughly broke even** (saving $24 of $633), and it cost slightly more in the most recent month. You can't tell which fix is right without replaying your own pattern of breaks, and that's what this tool does.

**Nothing else does this.** Provider dashboards show hit rate and spend. Observability tools (Langfuse, Helicone and others) show per-request cost. Claude Code's compaction triggers on how *full* the context is, never on *how long you've been gone*. No tool connects "you stepped away" to "you paid to re-cache", and none tests a fix against your own history before you commit to it.

## How it works

```
~/.claude/projects/**/*.jsonl   →   find every gap   →   price it   →   replay 5 strategies
 (logs Claude Code already keeps)    (per session &       (real model        (on the same gaps)
                                      per subagent)        prices)
```

1. **Read your logs.** Claude Code saves each session and each subagent as a `.jsonl` file under `~/.claude/projects`. Every model reply in them records token usage: how much was read from cache, how much was written, and whether the write used the 5-minute or 1-hour cache. `warm-window` reads only those numbers and timestamps.
2. **Find the cold returns.** Each session and subagent has its own cache, so they're analyzed separately. A **cold return** is a pause longer than 5 minutes, followed by a large cache write (≥ 20k tokens), where cache reads fell below half of the previous context: the conversation had to be re-cached from scratch. A large write on top of a healthy cache read is just new content, so it doesn't count.
3. **Price them.** Each re-cache is priced at that model's list price (Opus, Sonnet, Haiku, Fable; with 5-minute or 1-hour write rates). The **idle tax** is what you paid minus what the same tokens would have cost as a cheap cache read if the cache had still been warm.
4. **Replay the fixes.** Every gap in your history is re-run under each strategy below, and the costs are compared side by side.

### The strategies it compares

| Strategy | What it does | Trade-off |
|---|---|---|
| **What you did** | Your actual history | The baseline |
| **Force 1-hour cache** | Every write uses the 1-hour cache (`"promptCacheTtl": "1h"`) | Every write costs 2x instead of 1.25x. Only pays off if most of your gaps are 5–60 min. |
| **Compact before expiry** | Summarize the conversation just before the cache expires, while reading it is still cheap, then continue from the short summary | Costs a model call, and the system prompt must be re-cached on return. Summaries can lose detail such as exact file paths and IDs. |
| **Keep warm** | Send a tiny request that generates nothing (`max_tokens: 0`) just before expiry, so the cache stays alive, up to a limit | Cheap on the 1-hour cache, costly on the 5-minute one. May count against plan limits. |
| **Warm Window** (keep warm, then compact) | Keep the cache warm through short breaks; if you're gone longer than *K* minutes, compact while it's still warm. *K* is tuned on your own history. | The strategy this project wants to automate |
| **Best possible** | The cheapest choice for each gap, picked with hindsight | A floor no real policy can reach; shows how much is left on the table |

## Example output

```
  THE RECEIPT
  Cache hit rate          97.9% (looks great, hides the expensive moments)
  Cache spend (est.)      $3688 = $2117 reads + $1571 writes
  Cold returns            453 times a conversation resumed after its cache expired (~198k tokens re-cached each)
    you took a break       191 · $301 idle tax
    a subagent waited      262 · $296 idle tax (slow tool, 5-min cache)
  Re-cached after gaps    89.7M tokens = 40.3% of all cache writes
  Idle tax                $597 = 16.2% of cache spend, extra paid vs. a warm cache

  HOW LONG THE GAPS WERE  (you / subagent)
  5-15 min    ████████████████████████    1 / 234  · $271
  15-60 min   ██░░░░░░░░░░░░░░░░░░░░░░    1 / 19   · $29.58
  1-4 h       ██████████░░░░░░░░░░░░░░   92 / 7    · $143
  4-24 h      ███████░░░░░░░░░░░░░░░░░   66 / 1    · $109
  > 1 day     ███░░░░░░░░░░░░░░░░░░░░░   31 / 1    · $63.62

  WHAT EACH FIX WOULD HAVE COST  (same 1419 gaps, cache cost around them)
  What you did                                                         $633  baseline
  Force 1-hour cache everywhere                                        $608  saves $24.24 (3.8%)
  Compact right before the cache expires                               $337  saves $296 (46.8%)
  Keep warm up to 240 min, then let it expire                          $275  saves $357 (56.5%)
  Keep warm up to 240 min, then compact (Warm Window)                  $169  saves $464 (73.3%)
  Best possible (hindsight, not achievable)                            $108  saves $525 (83.0%)
```

The full report also lists which projects the idle tax came from (folder names only), what you can do about it today, and a one-line receipt you can share.

**How to read it:** in this history, most subagent misses were 5–15 minute waits on the 5-minute cache, and most of the user's own misses were 1–24 hour breaks. Forcing the 1-hour cache everywhere roughly broke even; keeping warm through short gaps and compacting before long ones would have cut this cost by about 73%. When *K* was tuned only on the first two months and scored on the unseen last month, the savings held at 71%.

## Does it work for real?

The numbers above are simulations, so we also ran a live test: the same coding task in three separate Claude Code sessions (Sonnet, about 118k tokens of context), each left idle for over an hour, then given the same follow-up.

| Approach | Cost of the gap + follow-up | Saved | Tests passing | Memory check |
|---|---|---|---|---|
| Do nothing | $0.54 | – | 9/9 | 4/4 |
| Compact before leaving | $0.41 | $0.13 (23%) | 9/9 | 4/4 |
| Keep warm with one ping | $0.13 | $0.41 (75%) | 9/9 | 4/4 |

This is one run per approach, by hand, at API list prices, so treat it as an example rather than a rate. Subagents haven't been tested live, and the automatic version doesn't exist yet. The run also corrected the simulator: compaction proved more expensive than first modeled, because the system prompt has to be re-cached too.

## What you can do today

Based on your report:

1. **Before you step away from a long session for a long time, run `/compact`** (or start a fresh session with a short handoff note). Compacting while the cache is warm uses a cheap read; coming back to a cold 200k-token session costs a full re-cache. On small sessions the saving is modest.
2. **If most of your gaps are 5–60 minutes,** try `"promptCacheTtl": "1h"` in `~/.claude/settings.json`. Check the "Force 1-hour cache" line first: if it doesn't show a clear saving, skip it.
3. **Want this done automatically?** 👍 [issue #1](https://github.com/Shoberman2/warm-window/issues/1). It decides whether the auto-policy gets built.

## Options

```
npx warm-window scan [options]

  --dir <path>          transcripts folder (default: ~/.claude/projects)
  --days <n>            only the last n days
  --min-write <tokens>  smallest re-cache that counts as a cold return (default 20000)
  --summary <tokens>    assumed compaction summary size (default 10000)
  --json                machine-readable output (project names shortened unless --paths)
  --receipt             print only the one-line shareable receipt
  --paths               show full project paths instead of folder names
  --top <n>             projects to list (default 5)
  -v, --version
  -h, --help
```

## Limits and honesty

- **Estimates, not a bill.** Costs use Anthropic API list prices. On a Pro or Max plan you pay in usage limits instead of dollars, but the proportions are the same: an idle re-cache burns limit just like it burns money.
- **An upper bound.** Some cold returns are deliberate fresh starts that would have happened anyway.
- **Simulations are simplified.** They assume the conversation would otherwise have gone the same way, assume a 10k-token summary (`--summary`) plus 27k tokens of system prompt re-cached after compacting, and ignore that compaction also makes later turns cheaper.
- **Compaction loses information.** The cost model doesn't yet measure what a summary forgets. That's on the roadmap.
- **Claude Code only, for now.** Other agents and the raw APIs are on the roadmap.

## Roadmap

This first version only measures. What gets built next depends on whether people want it:

- [ ] **Auto-policy:** a Claude Code hook or local proxy that keeps the cache warm and compacts before expiry for you. **[👍 issue #1](https://github.com/Shoberman2/warm-window/issues/1) if you want this.**
- [ ] **Quality guard:** a precise index of files, IDs and open tasks kept alongside each summary, so compaction stops forgetting exact details.
- [ ] **Replay scoring:** grade a compaction strategy on your own past sessions for both cost *and* what it forgot.
- [ ] Support for other agents (Codex CLI, OpenCode) and the raw Anthropic and OpenAI APIs.

## Contributing

```
git clone https://github.com/Shoberman2/warm-window
cd warm-window
npm test                 # 11 tests, no dependencies to install
node bin/warm-window.js scan
```

Issues and pull requests are welcome. The most useful contribution right now is running `npx warm-window scan --receipt` and pasting the line into [issue #1](https://github.com/Shoberman2/warm-window/issues/1): it shows whether the idle tax is big for people other than the author.

## Background

Inspired by Lee Robinson's Stanford CS146S lecture *How always-on agents work*: "treat a cache miss like a bug" and "compact while the cache is still warm". Also informed by Manus's [context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) write-up and Claude Code cache-TTL issues [#46829](https://github.com/anthropics/claude-code/issues/46829) and [#103673](https://github.com/anthropics/claude-code/issues/103673).

Not affiliated with Anthropic.

## License

MIT
