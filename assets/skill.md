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

`reply`, `turn`, `policy` and `delivery` may also be written at the top level; an adapter inherits every key it does not write and replaces the whole value of each key it writes, so an array is taken as written and not merged item by item. `pipeline` is a layer of its own: `global` nodes, `maxTurnMs`, `judgeTimeoutMs` and `judgePoints` at the top level, `inherit`, `remove`, `insert` and `override` on an adapter. `events` is read on the adapter only; `impressions` and `identity` only at the top level. The plugin status names the level that supplied each key under `config[].layers`.

| Field | Default | Meaning |
| --- | --- | --- |
| `kind` | `p2p` | `p2p`, `onebot`, or `x-[a-z0-9-]+` (third-party) |
| `channel` | required | unique link name; peers see it on the wire |
| `botName` | required | the bot this link answers for |
| `transport` | required | per-kind block below |
| `status` | `true` | register the read-only status route |
| `skill` | `true` | register the packaged skill when the host has a skills service |

`channel` is the adapter's only name. `secret`, `accessToken` and judge `credential` are reference names in the host credentials service, not secrets. Paths are read as POSIX paths; Windows is not supported.

### p2p transport

| Field | Default | Meaning |
| --- | --- | --- |
| `listen.host` | `127.0.0.1` | concrete address only |
| `listen.port` | `7123` | |
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
| `api.url` | required | `http(s)` for `http`, `ws(s)` for `ws-forward` |
| `event.url` | same as `api.url` | `ws-forward` only; both sockets must be up for `online` |
| `reconnect` | `{ initialMs: 500, maxMs: 30000, factor: 2 }` | `ws-forward` only; `false` keeps the link offline |
| `heartbeat` | off | both socket protocols; `intervalMs` 0, `timeoutMs` must exceed it |
| `accessToken` | | reference name |
| `selfId` | from the event | a mismatched event is dropped |
| `bots` | `[]` | ids treated as bots, not as people |
| `sendTimeoutMs` | `10000` | |
| `history.group` / `history.private` | `false` | allow `read_history` per address kind |
| `fileFromUrl` | `false` | allow `send_file` from an http(s) url |
| `events.turn` | `[]` | non-message classes that may start a turn |

One adapter accepts one connection in `ws-reverse`; a new connection for the same account replaces the old one. A named class skips the mention requirement; a name outside the classes OneBot sends fails the mount.

### Behaviour blocks

| Field | Default | Meaning |
| --- | --- | --- |
| `policy.requireMention` | `false` | group messages must name the bot or everyone |
| `policy.groupBots` | `whenMentioned` | `whenMentioned`, `silent` or `answer` |
| `policy.relayLimit` | `3` | rounds one peer may hold in a row |
| `policy.relayResetMs` | `300000` | idle time that resets the count |
| `policy.budget.capacity` | off | points per window |
| `policy.budget.hardLimit` | `1` | ratio that refuses |
| `policy.budget.restrictAt` | off | ratio where a `budget` node may restrict; above 0 and below `hardLimit` |
| `policy.deny.words` / `regexes` | `[]` | refuse a message whose text matches |
| `policy.allow.peers` | `[]` | matches `source.peer`: a peer instance on p2p, or the group or user id of a OneBot event |
| `reply.default` | `auto` | `auto` or `tool` |
| `reply.byScope` | off | mode per scope: `c2c`, `group`, `p2p` |
| `reply.rules` | off | ordered rules; first match wins |
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
| `pipeline.maxTurnMs` | `120000` | one turn's budget |
| `pipeline.judgeTimeoutMs` | `8000` | one judge call, retries included |
| `pipeline.judgePoints` | `1` | points a verdict costs |
| `allowAtLeast` (judge node) | off | score that allows the message |
| `impressions.dir` | off | absolute notes root; the library is off without it |
| `impressions.import` | off | once: `{ path, as: { personId } }` or `{ path, as: { groupKey } }` |
| `turn.impressions.chars` | `400` | notes injected into a turn, `0` to `2000`; `0` injects none |
| `identity.people` / `identity.bots` | `[]` | nodes `{ id, accounts: [{ kind, instance, accountId }] }`; an account fills `author.personId` |
| `session` / `cwd` / `agentPreset` / `model` | | run turns in one session; `model` is `provider/model` |

The impression library is off until a top-level `impressions` block names an absolute `dir`. It keeps short notes about the person a turn answers or about its group; `impression_put`, `impression_get` and `impression_forget` read and write them, `turn.impressions.chars` caps how much goes in front of a turn. `impressions.import` runs once per bot at mount from a file in the host memory format; `path` is absolute, `as.personId` must be a declared person, `as.groupKey` is `<channel>|<sessionKey>` on a mounted channel, it reads bullet lines only, and a second run adds nothing. Notes are injected for `c2c` and `group` turns only; on `p2p` the three tools answer `unsupported`. `impression_put` writes about the counterpart, which needs a `personId`, or with `about: "group"` about its group; `impression_get` takes `about: "group"` too; `impression_forget` takes `all: true` or `about: "group"`. `identity` declares `people` and `bots` nodes of `{ id, accounts: [{ kind, instance, accountId }] }`; ids and accounts appear once, `accounts` may not be empty, a built-in instance must be mounted, a configured p2p peer counts, a third-party kind is only warned about, and a resolved account fills `author.personId`.

## Judge provider

Mount one of two entries. Both provide `dsbot-channel/judge`, so a profile mounts one; a second mount fails at load with `one judge service per instance`. Mount the provider before the gateway: the gateway reads the service while it mounts.

A provider holds the connection; what to ask is written on the judge node, in the fields listed under `Pipeline nodes`.

`system-one` asks the question its node names and reads a probability.

```yaml
- id: dsbot-channel/system-one
  name: dsbot-channel/system-one
  config:
    credential: JUDGE_KEY
    baseUrl: https://api.typesafe.ai/v1/systemone
    model: jev-latest
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
| `maxChars` | `2000` (`system-one`), `6000` (`llm`) | body is truncated to this; one node's `context` is capped at it too |

A key other than these four fails the mount and is named in the error. A judge service from another package that reports no `needsQuestion` or `maxChars` counts as `false` and `2000`: its nodes take a `context` of 2000 code points at most and no `question`.

The provider sets no timer of its own; `pipeline.judgeTimeoutMs` bounds the call. A `429` or `529` is retried once. Only the body, the scope, the author id, whether the bot was named and the node's `context` are sent — no history, no tools. `llm` accepts bare JSON only; a fenced block fails the verdict.

## Score provider

A `score` node needs a host service named `dsbot-channel/score`, which answers `score(event, context)` with a number, synchronously or as a promise. Mount it before the gateway: the gateway reads the service while it mounts.

```ts
import type { PipelineEvent, NodeContext } from 'dsbot-channel'

export function apply(ctx) {
  ctx.provide('dsbot-channel/score')
  ctx.set('dsbot-channel/score', {
    score(event: PipelineEvent, context: NodeContext): number {
      return context.score + 1
    },
  })
}
```

The value is added to the running score; it may be negative and it decides nothing by itself.

## How a message is decided

An inbound message is deduplicated by the adapter, then the policy keys in the table above decide whether it may become a turn, then the pipeline decides whether the turn is allowed. A refusal is recorded as `outcome: rejected` with the gate's code, with the detail in the log. `policy.deny` and `policy.allow` need a `deny` or `allow` node: a profile that declares no `pipeline` gets it added, one that declares a pipeline must add it. A judge is a pipeline node: mount a provider, then declare the node; `allowAtLeast` makes it decide, without it the node only scores and the chain still refuses at its end.

## Pipeline nodes

A node is `{ id, type }` plus the fields its type reads. The chain runs in order; the first `deny` or `allow` ends it, and a chain that reaches the end refuses. `id` names the node in `matched` and `reasons`.

| Node | Effect |
| --- | --- |
| `deny` | refuses when `policy.deny` matches; no `policy.deny` rule fails the mount |
| `allow` | allows when `policy.allow` matches and stops later `score` and `judge`; no `policy.allow` peer fails the mount |
| `judge` | scores through the host judge service; `allowAtLeast` sets its threshold, and it reads `question` and `context` |
| `score` | adds the value the host score service returns; a throw or a non-finite value refuses with `score_failed` |
| `budget` | reads the spend of the busiest window: a hard state refuses, and `mayRestrict` at `restrictAt` restricts |
| `prepare` | runs the host prepare hook, then passes; every adapter for the bot needs the hook |
| `chance` | fires with `probability`: a hit ends the chain as an `allow` or a `deny`, a miss passes |

A `judge` node names what it asks and what it adds.

| Field | Default | Meaning |
| --- | --- | --- |
| `question` | required | what this node asks; `system-one` needs one, an `llm` node may not carry it |
| `question.type` | required | `noul`, `score` or `choice` |
| `question.instructions` | required | one question or statement |
| `question.criteria` | required | `noul`: `{ true, false }`; `score`: 2 to 10 ordered levels, low to high |
| `question.options` | required | for `choice`: at least two options |
| `question.target` | required | for `choice`: one of `question.options`; its probability becomes the score |
| `question.min` / `question.max` | off | `score` only: convert a raw score; equal values fail the verdict |
| `context` | off | static material for this node: a string or a mapping of name to string |
| `probability` | required | `chance` only: 0 to 1 |
| `outcome` | required | `chance` only: `allow` or `deny` |
| `restrictSkip` | off | `budget` only: what a restrict skips; required with `mayRestrict`. `scoring` skips `score` and `judge`; `judge` skips only `judge` |
| `mayRestrict` | off | `budget` only: turn a ratio at `policy.budget.restrictAt` into a restrict |

A key other than these in `question` fails the mount and names the node and the field. One `context` may total `maxChars` code points, mapping names included; an empty name or value, another type or an over-long one fails the mount. `context` carries what the profile knows, not what happened: the body, the scope, the author and whether the bot was named are sent already, and history, sessions and tools are never read. `llm` renders it after the message facts; `system-one` sends it as `state.context`.

`question`, `context`, `probability`, `outcome`, `restrictSkip` and `mayRestrict` may be written in `pipeline.global` and in an adapter's `insert` and `override`. A session layer's `insert` takes only `id`, `type`, `after` and `before`, so it carries none of them; a session's `override` may set them.

A `chance` node takes its bucket from a fixed hash of the event key and the node id: the same message replayed takes the same outcome, and two chance nodes on one message draw independently. It records `chance_allow`, `chance_deny` or `chance_miss` with `p=` under `reasons`, and the adapter that carried the message counts it under `counters.chance[nodeId]` as `{ hit, miss }`; the key appears only after the node has run.

A `score` node adds what `dsbot-channel/score` returns. A profile that declares one without that service fails the mount; a call that throws or returns anything but a finite number refuses the turn with `score_failed` and leaves the running score untouched. The running score is in the result and readable by later nodes; it decides nothing on its own, and `allowAtLeast`, `question` and `context` stay on `judge`.

A `budget` node reads the spend of the busiest window: the ratio is the largest of the global, bot and session usage divided by `policy.budget.capacity`. `hardLimit` refuses; with `mayRestrict`, a ratio at or above `policy.budget.restrictAt` returns a restrict, which skips what `restrictSkip` names and lets the chain continue. A restrict is not an allow: a chain that ends after one still refuses, with `pipeline-restrict` in the gate. `restrictSkip` without `mayRestrict`, `mayRestrict` without `restrictAt` or without a non-empty `restrictSkip`, declares a field that would do nothing and fails the mount.

An adapter changes the chain it starts from with `inherit`, `remove`, `insert` and `override`: `inherit` names the layer (an adapter takes `global`), `remove` drops nodes by id, `insert` adds a node after or before a named node (one of the two, no reused id), `override` replaces fields by id and only those the type reads; an unknown id fails the mount.

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

`override` replaces fields by id; a judge node uses it for `allowAtLeast`, `question` and `context`, and needs one provider mounted. A chain with no `allow` node and no judge threshold refuses every message.
