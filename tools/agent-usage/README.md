# agent-usage

Collector scripts that send **numbers only** (token counts and an estimated dollar cost per day) to the frame hub, for the Agents screen.
They talk to a hub that serves `/api/agents` (`PUT` to store, `GET` to ask whether a refresh is wanted), authenticated with an `X-Agent-Token` header.
No message text is read into memory beyond parsing each log line, and none is stored or sent.

## Claude (Claude Code on this computer)

`push-claude.js` reads `~/.claude/projects/**/*.jsonl`, de-duplicates messages (the same message can be logged several times),
adds up input, output, cache-read and cache-write tokens per day per model, prices them from `pricing.json`, and sends the last 14 days to the hub.

```sh
node push-claude.js --dry-run     # show what would be sent
node push-claude.js               # send it
```

Settings: copy nothing, it already has `config.local.json` (`hubUrl`, `token`, `timezone`; not committed). The token must match `agents_token` in the hub's
`secrets.json`. Only data from **this computer's** logs is counted; Claude used on other computers or in the browser does not appear.

**The cost is an estimate** of what the same tokens would cost at API list prices. On a subscription plan nothing is billed per token.
Edit `pricing.json` if prices change. A model with no price entry is counted in tokens but not in dollars (the script warns).

### Refresh from the frame

`watch-claude.js` is a small watcher. Every 15 seconds it asks the hub whether the frame has requested a refresh (tap the refresh button on the Agents screen, or
open that tab when the numbers are more than 5 minutes old) and runs `push-claude.js` when one is waiting. Nothing else is sent. The screen shows
"Refreshing…", then "Last ran 9:47 PM · just now". If this computer is off, the request waits and the screen says when it last ran.

```sh
node watch-claude.js
```

Leave it running in a terminal, or start it at login. A mapped drive such as `Z:\` may not exist yet when a login task runs, so for a login task keep a **local copy**
of this folder (with its `config.local.json`) and point the task at that:

```powershell
schtasks /Create /SC ONLOGON /TN "FrameAgentWatcher" /TR "powershell -WindowStyle Hidden -Command node C:\path\to\local\agent-usage\watch-claude.js" /F
```

Remove it with `schtasks /Delete /TN "FrameAgentWatcher" /F`. You can also still run `push-claude.js` by hand, or on a timer if you prefer that.

## Other services

There is no usable source on this computer for Codex, Gemini or Copilot, so their cards say "not connected". Codex/OpenAI API usage could be added with an
OpenAI admin key; Gemini and Copilot offer no usage API for personal plans.
