# warm-window

**Find out how much you pay when your AI coding agent "forgets" a conversation during a break, and what would have prevented it. Works with Claude Code and OpenAI Codex.**

```
npx warm-window scan
```

`warm-window` is a free command-line tool for [Claude Code](https://claude.com/claude-code) and [OpenAI Codex](https://developers.openai.com/codex) users. It reads the usage logs these agents already keep on your computer and shows you your **idle tax**: the extra money (or plan usage) spent re-loading long conversations after they sat idle. For Claude Code, it then replays your real history to show what each possible fix would have saved.

- **Private:** runs entirely on your machine. It reads only token counts and timestamps, never your messages or code, and sends nothing anywhere. It saves those numbers and project folder paths in `~/.cache/warm-window` so repeat scans are instant (`--no-cache` skips this).
- **Fast:** about 2 seconds for 4 GB of logs, under 0.1 seconds on repeat scans.
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

From the author's own Claude Code logs (the three months still on disk):

| | |
|---|---|
| Cache hit rate | **97.9%**, looks perfect |
| Times a long conversation went cold and was re-cached | **363** |
| Cost of those re-caches above a warm cache (the idle tax) | **$463, 14.9% of all cache spend** |
| Share of all cache writes that were just re-caching after a gap | **36.1%** |

It happens in two ways, and both surprised us:

1. **You take a break.** Lunch, a meeting, overnight. The 1-hour cache dies and the next message re-caches everything.
2. **A subagent waits.** Subagents use the 5-minute cache by default. If one waits more than 5 minutes on a slow build or test run, its whole conversation is re-cached. In the data above, this was **45% of the idle tax**, and invisible from the main session.

**The obvious fix may not help.** The 1-hour cache is the only setting that reaches subagents, but every subagent write then costs 2x instead of 1.25x, including the many that never wait. On the history above it **cost $13 more** overall, and it lost $56 in the most recent month. Choosing projects to turn it on for didn't help either: that didn't hold up on later data. You can't tell which fix is right without replaying your own pattern of breaks, and that's what this tool does.

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
| **Force 1-hour cache** | Run Claude Code with `ENABLE_PROMPT_CACHING_1H=1` so subagents use the 1-hour cache too (main sessions already do on the setups tested) | Every subagent write costs 2x instead of 1.25x, even when it never waits. |
| **Compact before expiry** | Summarize the conversation just before the cache expires, then continue from the short summary. Main sessions only. | Costs a model call, and the system prompt must be re-cached on return. Summaries can lose detail such as exact file paths and IDs. |
| **Keep warm** | Send a tiny request that generates nothing (`max_tokens: 0`) just before expiry, up to a limit. Main sessions only. | Costs a ping per hour, including on sessions you never return to. May count against plan limits. |
| **Warm Window** (keep warm, then compact) | Keep the cache warm through short breaks; if you're gone longer than *K* minutes, compact while it's still warm. *K* is tuned on your own history. | The strategy this project wants to automate |
| **Best possible** | The cheapest choice for each gap, picked with hindsight | A floor no real policy can reach; shows how much is left on the table |

## Example output

```
  THE RECEIPT
  Cache hit rate          97.9% (looks great, hides the expensive moments)
  Cache spend (est.)      $3100 = $1767 reads + $1333 writes
  Cold returns            363 times a conversation resumed after its cache expired (~182k tokens re-cached each)
    you took a break       178 · $256 idle tax
    a subagent waited      185 · $208 idle tax (slow tool, 5-min cache)
  Re-cached after gaps    65.9M tokens = 36.1% of all cache writes
  Idle tax                $463 = 14.9% of cache spend, extra paid vs. a warm cache

  HOW LONG THE GAPS WERE  (you / subagent)
  5-15 min    ████████████████████████    1 / 165  · $193
  15-60 min   ██░░░░░░░░░░░░░░░░░░░░░░    1 / 16   · $22.93
  1-4 h       ████████████░░░░░░░░░░░░   83 / 2    · $111
  4-24 h      ██████████░░░░░░░░░░░░░░   65 / 1    · $95.59
  > 1 day     ████░░░░░░░░░░░░░░░░░░░░   28 / 1    · $54.37

  WHAT EACH FIX WOULD HAVE COST  (same 1168 gaps, cache cost around them)
  What you did                                                         $492  baseline
  Force 1-hour cache everywhere (ENABLE_PROMPT_CACHING_1H)             $505  costs $13.16 more
  Compact right before the cache expires                               $413  saves $79.18 (16.1%)
  Keep warm up to 240 min, then let it expire                          $424  saves $68.27 (13.9%)
  Keep warm up to 240 min, then compact (Warm Window)                  $387  saves $105 (21.4%)
  Best possible (hindsight, not achievable)                            $278  saves $214 (43.4%)
```

The full report also lists which projects the idle tax came from (folder names only), what you can do about it today, and a one-line receipt you can share.

**How to read it:** in this history, most subagent misses were 5–15 minute waits, and most of the user's own misses were 1–24 hour breaks. Nothing outside a running subagent can ping or compact it, so those strategies only count main sessions, and they also pay for sessions you never came back to. Warm Window would have saved about 21%. With *K* tuned only on the first two months and scored on the unseen last month, it saved 19%. That's a real but modest saving, not a way to erase the idle tax.

## Does it work for real?

The numbers above are simulations, so we also ran a live test: the same coding task in three separate Claude Code sessions (Sonnet, about 118k tokens of context), each left idle for over an hour, then given the same follow-up.

| Approach | Cost of the gap + follow-up | Saved | Tests passing | Memory check |
|---|---|---|---|---|
| Do nothing | $0.54 | – | 9/9 | 4/4 |
| Compact before leaving | $0.41 | $0.13 (23%) | 9/9 | 4/4 |
| Keep warm with one ping | $0.13 | $0.41 (75%) | 9/9 | 4/4 |

This is one run per approach, by hand, at API list prices, so treat it as an example rather than a rate. This gap was also an ideal one for keep-warm: you came back. Across real history you sometimes don't, which is why the simulated savings above are lower. The automatic version doesn't exist yet.

### Subagents

A second live test had a subagent read about 90k tokens, then wait 6 minutes on a slow command:

| Setup | Cache after the wait | Whole run |
|---|---|---|
| Default | Cold, 80k tokens re-cached | $0.55 |
| `promptCacheTtl: "1h"` in settings | Cold, 80k tokens re-cached | $0.55 |
| `ENABLE_PROMPT_CACHING_1H=1` | Warm, 110 tokens written | $0.49 |

So the environment variable works and the setting doesn't reach subagents. It pays off when subagents wait, and costs more when they don't, so check the "Force 1-hour cache" line in your own report.

## What you can do today

Based on your report:

1. **Before you step away from a long session for a long time, run `/compact`** (or start a fresh session with a short handoff note). Compacting while the cache is warm uses a cheap read; coming back to a cold 200k-token session costs a full re-cache. On small sessions the saving is modest.
2. **If the "Force 1-hour cache" line shows a saving,** start Claude Code with `ENABLE_PROMPT_CACHING_1H=1`. It's the only fix that reaches subagents. If that line says *costs more*, skip it.
3. **Want this done automatically?** 👍 [issue #1](https://github.com/Shoberman2/warm-window/issues/1). It decides whether the auto-policy gets built.

## Codex

If you have Codex installed, `scan` adds a second report from `~/.codex/sessions`. Use `--agent codex` to see only that one.

Codex support **measures only** for now: it shows your cold returns, idle tax, gap lengths and top projects, but no fix simulations, because the Claude ones haven't been tested on OpenAI's caching.

A Codex cold return is a gap over 5 minutes where the cached tokens fell below half of the previous context and at least 20k tokens had to be redone. Only tokens already in the conversation count, so new content on that turn isn't called idle tax. Models it can't price are listed in the report rather than guessed. Costs use OpenAI API list prices, without long-context rates, so very large sessions may cost more. Compressed archived sessions (`.jsonl.zst`) aren't read.

## Options

```
npx warm-window scan [options]

  --agent <name>        claude, codex or all (default: all that are installed)
  --dir <path>          Claude Code transcripts folder (default: ~/.claude/projects)
  --codex-dir <path>    Codex sessions folder (default: ~/.codex/sessions)
  --days <n>            only the last n days
  --min-write <tokens>  smallest re-cache that counts as a cold return (default 20000)
  --summary <tokens>    assumed compaction summary size (default 10000)
  --json                machine-readable output (project names shortened unless --paths)
  --receipt             print only the one-line shareable receipt
  --paths               show full project paths instead of folder names
  --top <n>             projects to list (default 5)
  --no-cache            re-read every log instead of using saved results
  -v, --version
  -h, --help
```

## Limits and honesty

- **Estimates, not a bill.** Costs use Anthropic API list prices. On a Pro or Max plan you pay in usage limits instead of dollars, but the proportions are the same: an idle re-cache burns limit just like it burns money.
- **An upper bound.** Some cold returns are deliberate fresh starts that would have happened anyway.
- **Simulations are simplified.** They assume the conversation would otherwise have gone the same way, assume a 10k-token summary (`--summary`) plus 27k tokens of system prompt re-cached after compacting, and ignore that compaction also makes later turns cheaper.
- **Compaction loses information.** The cost model doesn't yet measure what a summary forgets. That's on the roadmap.
- **Logs don't last forever.** Claude Code removes old logs, so totals can fall between scans.
- **Two agents, for now.** Fix simulations are Claude Code only. Other agents and the raw APIs are on the roadmap.

## Roadmap

This first version only measures. What gets built next depends on whether people want it:

- [ ] **Auto-policy:** a Claude Code hook or local proxy that keeps the cache warm and compacts before expiry for you. **[👍 issue #1](https://github.com/Shoberman2/warm-window/issues/1) if you want this.**
- [ ] **Quality guard:** a precise index of files, IDs and open tasks kept alongside each summary, so compaction stops forgetting exact details.
- [ ] **Replay scoring:** grade a compaction strategy on your own past sessions for both cost *and* what it forgot.
- [x] Measure the idle tax on OpenAI Codex.
- [ ] Fix simulations for Codex, tested live like the Claude ones.
- [ ] Support for other agents (OpenCode, Gemini CLI) and the raw Anthropic and OpenAI APIs.

## Contributing

```
git clone https://github.com/Shoberman2/warm-window
cd warm-window
npm test                 # 24 tests, no dependencies to install
node bin/warm-window.js scan
```

Issues and pull requests are welcome. The most useful contribution right now is running `npx warm-window scan --receipt` and pasting the line into [issue #1](https://github.com/Shoberman2/warm-window/issues/1): it shows whether the idle tax is big for people other than the author.

## Background

Inspired by Lee Robinson's Stanford CS146S lecture *How always-on agents work*: "treat a cache miss like a bug" and "compact while the cache is still warm". Also informed by Manus's [context engineering](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) write-up and Claude Code cache-TTL issues [#46829](https://github.com/anthropics/claude-code/issues/46829) and [#103673](https://github.com/anthropics/claude-code/issues/103673).

Not affiliated with Anthropic.

## License

MIT
