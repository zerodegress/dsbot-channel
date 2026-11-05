# dsbot-channel configuration

Configure dsbot-channel adapter links and one optional judge provider. Every key is read at load; a key the plugin does not read fails the mount.

## Adapter

```yaml
config:
  adapters:
    - kind: p2p
      channel: p2p:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7123 }
        peers: { peer-a: PEER_A_REFERENCE }
```

`reply`, `turn`, `policy`, `delivery`, `pipeline` and `impressions` may also be written at the top level as defaults. An adapter replaces the keys it writes whole — an object or an array is taken as written, never merged field by field. The plugin status names the level that supplied each key under `config[].layers`.

| Field | Default | Meaning |
| --- | --- | --- |
| `kind` | `p2p` | `p2p`, `onebot`, or `x-[a-z0-9-]+` (third-party) |
| `channel` | required | unique link name; peers see it on the wire |
| `botName` | required | the bot this link answers for |
| `transport` | required | per-kind block below |
| `status` | `true` | register the read-only status route |

`channel` is the adapter's only name. `secret`, `accessToken` and judge `credential` are reference names in the host credentials service, not secrets. Paths are read as POSIX paths; Windows is not supported.

### p2p transport

| Field | Default | Meaning |
| --- | --- | --- |
| `listen.host` | `127.0.0.1` | concrete address only |
| `listen.port` | required | |
| `peers` | required | list or mapping of peer instance to secret reference; a list entry also carries `url`, `host`, `botName` |
| `dedupe.ttlMs` / `dedupe.limit` | | dedupe window and size |
| `inflightTtlMs` | `300000` | stale claim is reclaimed after this |
| `sentAtWindowMs` | `300000` | freshness window for the signature |
| `maxBodyBytes` | | request body limit |
| `waitMs` | | how long a duplicate waits |

`peers[].instance` is the peer's name, not this link's — this is the one place a name is not this adapter's `channel`. Two entries of one peer instance must reference different secrets.

### onebot transport

| Field | Default | Meaning |
| --- | --- | --- |
| `protocol` | `http` | `http`, `ws-forward` or `ws-reverse`; a field of another protocol fails the mount |
| `listen.host` | `127.0.0.1` | concrete address only |
| `listen.port` | `7331` | |
| `listen.path` | `/onebot/event` (`http`), `/onebot/ws` (`ws-reverse`) | |
| `api.url` | required for `http` and `ws-forward` | `http(s)` for `http`; `ws(s)` for `ws-forward` |
| `event.url` | same as `api.url` | `ws-forward` only; both sockets must be up for `online` |
| `reconnect` | `{ initialMs: 500, maxMs: 30000, factor: 2 }` | `ws-forward` only; `false` keeps the link offline |
| `heartbeat` | off | both socket protocols; `intervalMs` 0, `timeoutMs` must exceed it |
| `accessToken` | | reference name |
| `selfId` | from the event | a mismatched event is dropped |
| `bots` | empty | accept only these bot ids |
| `sendTimeoutMs` | `10000` | |
| `history.group` / `history.private` | `false` | allow `read_history` per address kind |
| `fileFromUrl` | `false` | allow `send_file` from an http(s) url |

One adapter accepts one connection in `ws-reverse`; a new connection for the same account replaces the old one.

### Behaviour blocks

| Field | Default | Meaning |
| --- | --- | --- |
| `policy.requireMention` | `false` | group messages must name the bot or everyone |
| `policy.groupBots` | `whenMentioned` | `whenMentioned`, `silent` or `answer` |
| `policy.relayLimit` | `3` | rounds one peer may hold in a row |
| `policy.relayResetMs` | `300000` | idle time that resets the count |
| `policy.budget.capacity` | off | points per window |
| `policy.budget.hardLimit` | `1` | ratio that refuses |
| `reply.default` | `auto` | `auto` or `tool` |
| `reply.byScope` | | mode per scope: `c2c`, `group`, `p2p` |
| `reply.rules` | | ordered rules; first match wins |
| `turn.coalesceMs` | `0` | merge window |
| `turn.maxBatch` | `10` | messages per batch |
| `turn.maxChars` | `8000` | batch budget |
| `turn.context.messages` | `0` | earlier messages put before the turn |
| `turn.context.chars` | `2000` | context budget |
| `delivery.split.byBlankLine` | `true` | split a reply at blank lines |
| `delivery.split.maxParts` | `4` | parts per reply, tail merged |
| `delivery.split.maxChars` | `0` | code points per part, off |
| `delivery.pacing.charsPerSecond` | `14` | reading speed for the wait |
| `delivery.pacing.minMs` | `700` | shortest wait between parts |
| `delivery.pacing.maxMs` | `5000` | longest wait between parts |
| `pipeline.judgeTimeoutMs` | `8000` | one judge call, retries included |
| `pipeline.judgePoints` | `1` | points a verdict costs |
| `allowAtLeast` (judge node) | off | score that allows the message |
| `impressions.dir` | off | absolute notes root; the library is off without it |
| `session` / `cwd` / `agentPreset` / `model` | | run turns in one session; `model` is `provider/model` |

## Judge provider

Mount one of two entries. Both provide `dsbot-channel/judge`, so a profile mounts one; a second mount fails at load with `one judge service per instance`. Mount the provider before the gateway: the gateway reads the service while it mounts.

`system-one` asks a typed question and reads a probability.

```yaml
- id: dsbot-channel/system-one
  name: dsbot-channel/system-one
  config:
    credential: JUDGE_KEY
    baseUrl: https://api.typesafe.ai/v1/systemone
    model: jev-latest
    question:
      type: noul
      instructions: Is this message worth answering?
```

`llm` asks an OpenAI-compatible chat completion for bare JSON `{"score","reason"}`.

```yaml
- id: dsbot-channel/llm
  name: dsbot-channel/llm
  config:
    credential: JUDGE_KEY
    baseUrl: https://openrouter.ai/api/v1
    model: vendor/model
```

| Field | Default | Meaning |
| --- | --- | --- |
| `credential` | required | reference name |
| `baseUrl` | required | absolute http(s) URL; `llm` posts to `{baseUrl}/chat/completions` |
| `model` | required | model id |
| `maxChars` | `2000` (`system-one`), `6000` (`llm`) | body is truncated to this |
| `question` | required for `system-one` | the typed question |
| `question.type` | required | `noul`, `score` or `choice` |
| `question.instructions` | required | one question or statement |
| `question.criteria` | `noul`: `{ true, false }`; `score`: 2 to 10 ordered levels | |
| `question.options` | required for `choice` | |
| `question.target` | required for `choice` | the option whose probability becomes the score |
| `question.min` / `question.max` | `score` only | used when a reply carries no normalized score; equal values fail the verdict |

The provider sets no timer of its own; `pipeline.judgeTimeoutMs` bounds the call. A `429` or `529` is retried once. Only the body, the scope, the author id and whether the bot was named are sent — no history, no tools. `llm` accepts bare JSON only; a fenced block fails the verdict.
