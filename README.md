# dsbot-channel

English | [中文](./README_ZH.md)

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A message gateway for ds-bot: events from several external platforms reach one bot, and answers go back to the conversation they came from.

Default column: a value is that default, `required` means the key must be set, and `off` means nothing is set: the feature does not happen until the key is written.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, and pnpm
- The host services: credentials (adapter secrets), session controller (turns), tools (tool mode). Session persistence is used when the host provides it: the log is flushed after each delivered reply.

Tested against DS-Bot 0.2.x; later releases are not guaranteed.

## Install

From the dsh UI, or from a terminal:

```sh
dsh plugin --profile ds-bot add dsbot-channel
```

From source: `pnpm install`, then `pnpm build`.

## Configure

Mount it in a profile through its bundle patch. It ships enabled with no adapters, so it stays idle until a profile declares one.

## Adapt

```yaml
config:
  adapters:
    - kind: onebot
      channel: onebot:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7331 }
        api: { url: "http://127.0.0.1:3000" }
        accessToken: ONEBOT_TOKEN
```

| Field | Default | Meaning |
| --- | --- | --- |
| `kind` | `p2p` | `p2p`, `onebot`, or `x-[a-z0-9-]+` for a third-party transport |
| `channel` | required | unique link name; peers see it on the wire |
| `botName` | required | the bot this link answers for |
| `transport` | required | per-kind block; see Peers and OneBot |
| `session` | off | run every turn in one existing session |
| `cwd` | off | directory for the sessions this adapter creates |
| `agentPreset` | off | preset for the sessions it creates |
| `model` | off | `provider/model` for those sessions |
| `status` | `true` | register the read-only status route |
| `skill` | `true` | register the packaged skill when the host has a skills service |

`channel` is the adapter's only name. `reply`, `turn`, `policy` and `delivery` may also be written at the top level; an adapter inherits every key it does not write and replaces the whole value of each key it does write, so an array is taken as written and not merged item by item. `pipeline` is a layer of its own: `global` nodes, `maxTurnMs`, `judgeTimeoutMs` and `judgePoints` at the top level, and `inherit`, `remove`, `insert` and `override` on an adapter. `events` is read on the adapter only; `impressions` and `identity` only at the top level. The plugin status names the level behind each key under `config[].layers`. `secret` and `accessToken` are reference names in the host credentials service, not secrets. Paths are POSIX; Windows is not supported.

## Peers

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

| Field | Default | Meaning |
| --- | --- | --- |
| `transport.listen.host` | `127.0.0.1` | concrete address only |
| `transport.listen.port` | `7123` | |
| `transport.peers` | required | list or mapping of peer instance to secret reference |
| `transport.dedupe.ttlMs` / `.limit` | `604800000` / `100000` | replay window and size |
| `transport.inflightTtlMs` | `300000` | a stale claim is reclaimed after this |
| `transport.sentAtWindowMs` | `300000` | signature freshness window |
| `transport.maxBodyBytes` | `65536` | request body limit |
| `transport.waitMs` | `10000` | how long a duplicate waits |

A peer written as a list entry also carries `url`, `host` and `botName`; a mapping value is only a secret reference. Mixing the two forms is refused at mount. `peers[].instance` is the peer's name, not this link's — the one place a name is not this adapter's `channel`. Two entries of one peer instance must use different secrets. `transport.inflightTtlMs` must be above `pipeline.maxTurnMs`.

## OneBot

```yaml
config:
  adapters:
    - kind: onebot
      channel: onebot:ws
      botName: self-bot
      transport:
        protocol: ws-reverse
        listen: { host: 127.0.0.1, port: 7332, path: /onebot/ws }
        accessToken: ONEBOT_TOKEN
```

| Field | Default | Meaning |
| --- | --- | --- |
| `transport.protocol` | `http` | `http`, `ws-forward` or `ws-reverse` |
| `transport.listen.host` | `127.0.0.1` | concrete address only |
| `transport.listen.port` | `7331` | |
| `transport.listen.path` | `http`: `/onebot/event`; `ws-reverse`: `/onebot/ws` | event path |
| `transport.api.url` | required | `http(s)` for `http`, `ws(s)` for `ws-forward`: action endpoint |
| `transport.event.url` | same as `api.url` | `ws-forward`: event socket |
| `transport.reconnect` | `{ initialMs: 500, maxMs: 30000, factor: 2 }` | `ws-forward`: `false` keeps the link offline |
| `transport.heartbeat` | off | socket liveness; `timeoutMs` must exceed `intervalMs` |
| `transport.accessToken` | off | reference name |
| `transport.selfId` | from the event | a mismatched event is dropped |
| `transport.bots` | `[]` | ids treated as bots, not as people |
| `transport.sendTimeoutMs` | `10000` | one action |
| `transport.history.group` / `.private` | `false` | allow `read_history` per address kind |
| `transport.fileFromUrl` | `false` | allow `send_file` from an http(s) url |
| `events.turn` | `[]` | non-message classes that may start a turn |

One adapter speaks one protocol; a field of another protocol is refused at load. One implementation reaches one adapter, not two. `events.turn` names classes such as `notice.group_recall` or `request.friend`; every other non-message event is recorded and counted without starting a turn, `meta_event` or a self echo never starts one, a name outside the classes OneBot sends fails the load, and a named class skips the mention requirement.

## Turns and delivery

| Field | Default | Meaning |
| --- | --- | --- |
| `reply.default` | `auto` | `auto` or `tool` |
| `reply.byScope` | off | mode per scope: `c2c`, `group`, `p2p` |
| `reply.rules` | off | ordered rules; first match wins |
| `turn.coalesceMs` | `0` | merge window; `0` keeps one message per turn |
| `turn.maxBatch` | `10` | messages per batch |
| `turn.maxChars` | `8000` | batch budget |
| `turn.context.messages` | `0` | earlier messages put before the turn |
| `turn.context.chars` | `2000` | context budget |
| `turn.impressions.chars` | `400` | notes injected into a turn; `0` injects none |
| `delivery.split.byBlankLine` | `true` | split a reply at blank lines |
| `delivery.split.maxParts` | `4` | parts per reply, tail merged |
| `delivery.split.maxChars` | `0` | code points per part |
| `delivery.pacing.charsPerSecond` | `14` | reading speed for the wait |
| `delivery.pacing.minMs` | `700` | shortest wait between parts |
| `delivery.pacing.maxMs` | `5000` | longest wait between parts |
| `policy.requireMention` | `false` | group messages must name the bot or everyone; needs a transport that can tell mentions apart, so `p2p` is refused at mount |
| `policy.groupBots` | `whenMentioned` | `whenMentioned`, `silent` or `answer` |
| `policy.relayLimit` | `3` | rounds one peer may hold in a row |
| `policy.relayResetMs` | `300000` | idle time that resets the count |
| `policy.budget.capacity` | off | points per window |
| `policy.budget.hardLimit` | `1` | ratio that refuses |
| `policy.deny.words` / `regexes` | `[]` | refuse a message whose text matches |
| `policy.allow.peers` | `[]` | matches `source.peer`: a peer instance on p2p, or the group or user id of a OneBot event |

Only a turn reply is split; `send_text`, decline and refusal messages go out whole. Without a `delivery` block anywhere a reply is sent whole. A batch is charged and recorded once; `policy.budget.capacity` is required once `policy.budget` is written. `policy.deny.words` matches case-insensitively as a substring and an empty word is refused at mount; `policy.deny.regexes` compiles case-insensitively and an invalid pattern is refused at mount; `policy.allow.peers` matches `source.peer` and an empty name is refused. Any of the three that is not empty adds a `deny` or `allow` node, a match refusing or allowing the message. Each wait before a part is the part's code points divided by `charsPerSecond`, kept inside `minMs` and `maxMs`; the last part is not followed by a wait. `maxChars: 0` turns the hard cut off, and an empty `delivery` block adds no keys. A part that fails stops the rest and the reply is reported failed with the parts already sent.

## Judge

```yaml
config:
  pipeline:
    global:
      - { id: score, type: judge, allowAtLeast: 0.6 }
```

A `judge` node needs the host service `dsbot-channel/judge`, which answers `judge(event, context)` with `{ score, reason? }`. A profile that declares the node without the service fails the mount; a judge that times out or throws refuses the message with `judge_timeout` or `judge_failed`, and a score that is not a finite number from 0 to 1 fails it the same way. `allowAtLeast` may also be inserted or overridden on a bot or session layer. `judgeTimeoutMs` must not exceed `maxTurnMs`.

| Field | Default | Meaning |
| --- | --- | --- |
| `pipeline.maxTurnMs` | `120000` | one turn's budget |
| `pipeline.judgeTimeoutMs` | `8000` | one judge call, retries included |
| `pipeline.judgePoints` | `1` | points a verdict costs |
| `allowAtLeast` (judge node) | off | score that allows the message |

Two entries fill that service; mount one of them **before** the gateway.

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
| `question` | required | the typed question, for `system-one` |
| `question.type` | required | `noul`, `score` or `choice` |
| `question.instructions` | required | one question or statement |
| `question.criteria` | `noul`: `{ true, false }`; `score`: 2 to 10 ordered levels | |
| `question.options` | required | options, for `choice` |
| `question.target` | required | for `choice`: the option whose probability becomes the score |
| `question.min` / `.max` | off | `score` only: convert a raw score; equal values fail the verdict |

Both entries send the body, the scope, the author id and whether the bot was named — no history, no tools — and retry once on `429` or `529` inside `pipeline.judgeTimeoutMs`. `llm` accepts bare JSON only. A second provider on one profile fails at load.

## Pipeline nodes

A node is `{ id, type }` plus the fields its type reads. The chain runs in order; the first `deny` or `allow` ends it, and a chain that reaches the end refuses.

| Node | Effect |
| --- | --- |
| `deny` | Refuses when `policy.deny` matches. A `deny` node with no `policy.deny` rule fails the mount. |
| `allow` | Allows when `policy.allow` matches, and stops every later `score` and `judge`. An `allow` node with no `policy.allow` peer fails the mount. |
| `judge` | Scores through the host judge service; its threshold is `allowAtLeast`. |
| `prepare` | Runs the host prepare hook, then passes. Every adapter answering for the bot must carry the hook, or the mount fails. |

| Field | Meaning |
| --- | --- |
| `id` | Names the node in `matched` and `reasons`. |
| `type` | One of the four above. |
| `allowAtLeast` | `judge` only: a score from 0 to 1. |

`score` and `budget` are declared in the schema but cannot bind in this version: a score node needs a scoring function the pipeline does not supply, and a budget node needs a session-scoped verdict it cannot carry yet. Declaring either fails the mount and names the reason; the gateway's own hard window is what limits spending, and only a profile that writes `policy.budget` has one.

An adapter changes the chain it starts from with four keys: `inherit` names the layer it starts from, which for an adapter is `global`; `remove` drops nodes by id, `insert` adds a node after or before a named node, and `override` replaces fields of a node by id. `insert` sets exactly one of `after` or `before` and cannot reuse an existing id; `override` writes only fields the node's type reads; `remove` or `override` naming an id that is not there fails the mount.

```yaml
config:
  policy:
    deny: { words: [spam] }
  pipeline:
    global:
      - { id: guard, type: deny }
      - { id: shadow, type: deny }
  adapters:
    - kind: p2p
      channel: p2p:peer-a
      botName: self-bot
      transport: { listen: { host: 127.0.0.1, port: 7123 }, peers: { peer-b: PEER_B_REFERENCE } }
      pipeline:
        remove: [shadow]
        insert: [{ id: extra, type: deny, after: guard }]
```

`override` replaces fields by id and is what a judge node uses to change `allowAtLeast`; a judge node also needs one provider mounted. The chain above has no `allow` node and no judge threshold, so it refuses every message; it shows the layer operations only.

## Identity and impressions

`identity` is a top-level block with `people` and `bots` lists. Each node is `{ id, accounts: [{ kind, instance, accountId }] }`. A node id and an account may each appear once; `accounts` may not be empty. A built-in account must name an instance that is mounted, and a configured p2p peer counts; a third-party kind is only warned about. An account that resolves fills `author.personId`.

`impressions.dir` is an absolute notes root; the library is off without it. `impressions.import` runs once per bot at mount: `{ path, as: { personId } }` or `{ path, as: { groupKey } }`, where `path` is absolute, `personId` must be a declared person and not a bot, and `groupKey` is `<channel>|<sessionKey>` for a group session on a mounted channel. It reads bullet lines only, warns about what it cannot place without blocking the mount, and a second run adds nothing.

`turn.impressions.chars` caps the notes put before a turn: `400` by default, `0` to `2000`, and `0` turns injection off. Notes are injected for `c2c` and `group` turns only, never for `p2p`, where the three tools answer `unsupported` as well. `impression_put` writes about the turn's counterpart, which needs a `personId`, or with `about: "group"` about its group; `impression_get` reads one scope of `c2c`, `group` or `cross` for that counterpart or, with `about: "group"`, the group archive; `impression_forget` removes one id, or with `all: true` everything about that counterpart, or with `about: "group"` about its group.

## Layers

| Block | Where it may be written |
| --- | --- |
| `reply`, `turn`, `policy`, `delivery` | top level and each adapter, key by key |
| `pipeline` | top level: `global` nodes, `maxTurnMs`, `judgeTimeoutMs`, `judgePoints`; adapter: `inherit`, `remove`, `insert`, `override` |
| `events` | adapter only |
| `impressions`, `identity` | top level only |

## License

MIT. See [LICENSE](./LICENSE).
