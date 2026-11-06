# dsbot-channel

English | [中文](./README_ZH.md)

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

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
| `kind` | `p2p` | `p2p`, `onebot`, `webhook`, `mail`, or `x-[a-z0-9-]+` for a third-party transport |
| `channel` | required | unique link name; peers see it on the wire |
| `botName` | required | the bot this link answers for |
| `transport` | required | per-kind block; see Peers, OneBot, Webhook and Email |
| `session` | off | run every turn in one existing session |
| `cwd` | off | directory for the sessions this adapter creates |
| `agentPreset` | off | preset for the sessions it creates |
| `model` | off | `provider/model` for those sessions |
| `status` | `true` | register the read-only status route |
| `skill` | `true` | register the packaged skill when the host has a skills service |

An adapter whose `capabilities.outbound` is `false` is never written back: core does not call its `send` or `refuse`, the `send_text` tool answers `unsupported` for it, and a session of it has no address to inherit. Its turns still run, so a profile that lets such an adapter start turns needs a reply block that always chooses `tool`, or the mount fails.

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
| `events.turn` | `[]` | non-message classes that may start a turn; an adapter names its own `action.<type>` |

One adapter speaks one protocol; a field of another protocol is refused at load. One implementation reaches one adapter, not two. `events.turn` names classes as `<kind>.<type>`: OneBot's own, such as `notice.group_recall` or `request.friend`, or an adapter's `action.<type>` for push, CI and timer events. Every other non-message event is recorded and counted without starting a turn, `meta_event` or a self echo never starts one, an unknown name fails the mount, and a named class skips the mention requirement.

## Webhook

A comment lives in a room named for its issue or pull request: `gh:<owner>/<repo>#<number>`. An event that belongs to the repository alone, such as a push or a release, lives in `gh:<owner>/<repo>`.

```yaml
config:
  adapters:
    - kind: webhook
      channel: gh:acme/api
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 8463, path: /github/webhook }
        secret: WEBHOOK_SECRET
        token: API_TOKEN
        api: https://api.github.com
        login: acme-bot
```

| Field | Default | Meaning |
| --- | --- | --- |
| `transport.listen.host` / `.port` / `.path` | `127.0.0.1` / `8463` / `/github/webhook` | where the calls arrive |
| `transport.secret` | required | credential reference: the HMAC-SHA256 key of the raw body |
| `transport.token` | required | credential reference used to post a comment |
| `transport.dialect` | `auto` | `github`, `forgejo`, or `auto` to read it from the request headers; a request naming the other dialect gets 400 |
| `transport.api` | `https://api.github.com` | base URL of the comment api |
| `transport.login` | required | the bot's own login, used for `@` mentions |
| `transport.bots` | `[]` | logins counted as bot speech |
| `transport.repos` | `[]` | optional `owner/repo` allow list |

An issue comment, a review comment, or a pull request review that carries a body runs a turn, and the answer is posted as a comment on the same issue. Events that are not comments, such as `issues`, `pull_request`, `push`, `release` and CI runs, are `action` events: each carries a one line summary and starts no turn unless its class is listed in `events.turn` (`action.push`, `action.ci`, `action.issues`, …). A ping or installation event is answered with 200 and dropped before the gateway. A request whose signature does not verify is refused with 401 and never reaches the gateway; one that verifies but names no event header is refused with 400; a repeated delivery, or the same comment under a new delivery, runs once. The answer is the only thing this adapter writes: it never edits or closes anything.

## Email

A mailbox is a room keyed by the thread root: `mail:<thread-root>`. A mailing list address is the reply target; a direct mail answers its sender.

```yaml
config:
  adapters:
    - kind: mail
      channel: mail:bot
      botName: self-bot
      transport:
        imap: { host: 127.0.0.1, port: 993, secure: true, user: bot@example.test, password: IMAP_SECRET, mailbox: INBOX, pollMs: 30000 }
        smtp: { host: 127.0.0.1, port: 465, secure: true, user: bot@example.test, password: SMTP_SECRET }
        from: bot@example.test
```

| Field | Default | Meaning |
| --- | --- | --- |
| `transport.imap.host` / `.port` / `.user` / `.password` | required | the mailbox the link reads; `password` is a credential reference |
| `transport.imap.secure` | `true` | TLS to the mailbox; `false` reads plaintext |
| `transport.imap.mailbox` | `INBOX` | folder to poll |
| `transport.imap.pollMs` | `30000` | how often the folder is read |
| `transport.smtp.host` / `.port` / `.user` / `.password` | required | where an answer is sent; `password` is a credential reference |
| `transport.smtp.secure` | `true` | `true`, `false` or `starttls` |
| `transport.from` | required | the address answers are sent from |
| `transport.signature` | off | text appended after the answer |
| `transport.listUnsubscribe` | off | `List-Unsubscribe` value on an answer |
| `transport.bots` | `[]` | senders counted as bot speech |
| `transport.lists` | `[]` | addresses that count as lists when the headers do not name one |
| `transport.maxAttachmentBytes` | `10485760` | largest attachment recorded; larger ones are dropped with a warning |

The IMAP and SMTP links run through `imapflow` and `nodemailer`; the fields above do not depend on them. A thread is one chain: an answer carries `In-Reply-To` and the whole `References` chain, so it lands where the conversation is. The root is the first `References` entry, else `In-Reply-To`, else the message's own `Message-ID`. A list message answers the list, a direct message answers its sender. HTML is read as text: scripts, styles, images and tags are dropped. Attachments are not passed to the model: a name, a type and a size are recorded, and one over `maxAttachmentBytes` is dropped with a warning.

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

Only a turn reply is split; `send_text`, decline and refusal messages go out whole. Without a `delivery` block anywhere a reply is sent whole. A batch is charged and recorded once. Each wait before a part is the part's code points divided by `charsPerSecond`, kept inside `minMs` and `maxMs`; the last part is not followed by a wait. `maxChars: 0` turns the hard cut off, and an empty `delivery` block adds no keys. A part that fails stops the rest and the reply is reported failed with the parts already sent.

## Judge

```yaml
config:
  pipeline:
    global:
      - id: worthy
        type: judge
        allowAtLeast: 0.6
        question:
          type: noul
          instructions: Is this message worth answering?
          criteria: { true: worth answering, false: not worth answering }
        context: This bot answers questions about the project only.
```

A `judge` node needs the host service `dsbot-channel/judge`, which answers `judge(event, context)` with `{ score, reason? }`. A profile that declares the node without the service fails the mount; a judge that times out or throws refuses the message with `judge_timeout` or `judge_failed`, and a score that is not a finite number from 0 to 1 fails it the same way. `allowAtLeast` and `belowThreshold` may also be set by an adapter's `insert` or `override`, or by a session's `override`; the fields a judge node reads, and where they may be written, are listed under `Pipeline nodes`. `judgeTimeoutMs` must not exceed `maxTurnMs`.

| Field | Default | Meaning |
| --- | --- | --- |
| `pipeline.maxTurnMs` | `120000` | one turn's budget |
| `pipeline.judgeTimeoutMs` | `8000` | one judge call, retries included |
| `pipeline.judgePoints` | `1` | points a verdict costs |
| `allowAtLeast` (judge node) | off | score that allows the message |
| `belowThreshold` (judge node) | `deny` | what a score below `allowAtLeast` does: `deny` refuses, `pass` moves on |

Two entries fill that service; mount one of them **before** the gateway.

```yaml
- id: dsbot-channel/system-one
  name: dsbot-channel/system-one
  config:
    credential: JUDGE_KEY
    baseUrl: https://api.typesafe.ai/v1/systemone
    model: jev-latest
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
| `maxChars` | `2000` (`system-one`), `6000` (`llm`) | body is truncated to this; one node's `context` is capped at it too |

Both entries send the body, the scope, the author id, whether the bot was named and the node's `context` — no history, no tools — and retry once on `429` or `529` inside `pipeline.judgeTimeoutMs`. `llm` accepts bare JSON only. A second provider on one profile fails at load. Any other key fails the mount and is named in the error; a judge service from another package that reports no `needsQuestion` or `maxChars` is read as `false` / `2000`.

## Score

A `score` node needs the host service `dsbot-channel/score`, which answers `score(event, context)` with a number, synchronously or as a promise. Mount it before the gateway: the gateway reads the service while it mounts. The value is added to the running score; it may be negative and it decides nothing by itself. Later nodes see the running score in `context.score`, and a judge provider that reads it can fold it into its own verdict. The two built-in providers do not read it, so a score never enters their prompt. `allowAtLeast` compares the judge's own score, not the running total.

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

## How a message is decided

An inbound message goes through three steps: the adapter drops a duplicate, the policy gate decides whether it may become a turn at all, and the pipeline decides whether the turn is allowed. A refusal is recorded in the turns snapshot as `outcome: rejected` with the gate's code, and its detail goes to the log.

| Policy key | Default | What it decides |
| --- | --- | --- |
| `policy.requireMention` | `false` | a group message must name the bot or everyone; a transport that cannot tell mentions (`p2p`, `mail`) refuses this at mount |
| `policy.groupBots` | `whenMentioned` | how another bot's group message is treated: `whenMentioned`, `silent` or `answer` |
| `policy.relayLimit` / `policy.relayResetMs` | `3` / `300000` | how many turns in a row one peer may hold, and the idle time that resets it |
| `policy.deny.words` / `policy.deny.regexes` | `[]` | substrings and regular expressions that refuse a message; matching is case-insensitive |
| `policy.allow.peers` | `[]` | `source.peer` values an `allow` node matches; a match allows the message and ends the chain |
| `policy.budget.capacity` / `policy.budget.hardLimit` | required once `budget` is written / `1` | points per window and the ratio at which the gateway refuses, set as a hard window |
| `policy.budget.restrictAt` | off | ratio where a `budget` node may restrict; above 0 and below `hardLimit` |

An empty word, an invalid pattern or an empty peer name fails the mount. `policy.deny` and `policy.allow` only take effect through a node: a profile that declares no `pipeline` gets the node added for it, and a profile that declares one has to add the node itself, or the rule silently does nothing.

A judge enters as one node of the pipeline, not as a gate: mount a provider first, then declare the node. Without `allowAtLeast` the node only adds its score, and a chain that ends without an allow still refuses; with it, a score at or above the threshold allows the message, and one below refuses it, or with `belowThreshold: pass` adds its score and passes the chain on, recorded as `judge_below_threshold_pass`. A judge call costs its `judgePoints` whether it decides or only scores, and `belowThreshold` does not change that.

Three starting points:

```yaml
# a group where the bot answers only when named
config:
  policy: { requireMention: true }
```

```yaml
# refuse spam words, then let a judge decide (provider mounted first)
config:
  policy:
    deny: { words: [spam], regexes: ['^\s*$'] }
  pipeline:
    global:
      - { id: guard, type: deny }
      - { id: verdict, type: judge, allowAtLeast: 0.6 }
```

```yaml
# answer when the judge is reasonably sure, with a provider mounted first
config:
  pipeline:
    global:
      - { id: verdict, type: judge, allowAtLeast: 0.6 }
```

## Pipeline nodes

A node is `{ id, type }` plus the fields its type reads. The chain runs in order; the first `deny` or `allow` ends it, and a chain that reaches the end refuses.

| Node | Effect |
| --- | --- |
| `deny` | Refuses when `policy.deny` matches. A `deny` node with no `policy.deny` rule fails the mount. |
| `allow` | Allows when `policy.allow` matches, and stops every later `score` and `judge`. An `allow` node with no `policy.allow` peer fails the mount. |
| `judge` | Scores through the host judge service; `allowAtLeast` sets its threshold, `belowThreshold` decides what a lower score does, and it reads `question` and `context`. |
| `score` | Adds the value the host score service returns. A throw or a non-finite value refuses with `score_failed`. |
| `budget` | Reads the spend of the busiest window: a hard state refuses, and `mayRestrict` at `restrictAt` restricts. |
| `prepare` | Runs the host prepare hook, then passes. Every adapter answering for the bot must carry the hook, or the mount fails. |
| `chance` | Fires with `probability`: a hit ends the chain as an `allow` or a `deny`, a miss passes to the next node. |
| `when` | Decides by a Matcher: a match returns its `outcome`, no match passes. |

| Field | Default | Meaning |
| --- | --- | --- |
| `id` | required | Names the node in `matched` and `reasons`. |
| `type` | required | One of the eight above. |
| `allowAtLeast` | off | `judge` only: a score from 0 to 1. |
| `belowThreshold` | `deny` | `judge` only: `deny` or `pass`, what a score below `allowAtLeast` does. Fails the mount without `allowAtLeast`. |
| `question` | required | `judge` only: what this node asks. `system-one` needs one; an `llm` node may not carry it. |
| `question.type` | required | `noul`, `score` or `choice`. |
| `question.instructions` | required | One question or statement. |
| `question.criteria` | required | `noul`: `{ true, false }`; `score`: 2 to 10 ordered levels, low to high. |
| `question.options` | required | `choice` only: at least two options. |
| `question.target` | required | `choice` only: one of `question.options`; its probability becomes the score. |
| `question.min` / `.max` | off | `score` only: convert a raw score; equal values fail the verdict. |
| `context` | off | `judge` only: static material, a string or a mapping of name to string. |
| `probability` | required | `chance` only: 0 to 1. |
| `outcome` | required | `when`: `allow`, `deny` or `pass`; `chance`: `allow` or `deny`. |
| `test` | required | `when` only: the Matcher it reads. |
| `when` | off | `chance` only: the Matcher it rolls behind. |
| `restrictSkip` | off | `budget` only: what a restrict skips; required with `mayRestrict`. `scoring` skips `score` and `judge`; `judge` skips only `judge`. |
| `mayRestrict` | off | `budget` only: turn a ratio at `policy.budget.restrictAt` into a restrict. |

A key other than these inside `question` fails the mount and names the node and the field. One `context` may total the provider's `maxChars` in code points, mapping names included; an empty name or value, another type or an over-long one fails the mount. `context` is what the profile knows, not what happened: the body, the scope, the author and the mention flag are sent already, and no history, session or tool is read. `llm` renders it after the message facts; `system-one` sends it as `state.context`.

A `when` node decides by a Matcher: a match returns its `outcome`, no match passes. The same Matcher guards a `chance` node; a guard that does not hold passes without rolling, without a `counters.chance` entry and without a `chance_miss` reason.

| Matcher key | Values | Meaning |
| --- | --- | --- |
| `scope` | `c2c`, `group`, `p2p` | the conversation kind |
| `peer` | a string, or `{ in: [...] }` / `{ notIn: [...] }` | the peer the event names; when the event names no peer, `in` does not match and `notIn` does |
| `mentioned` | `true` / `false` | this bot or everyone was named |
| `replyToMe` | `true` / `false` | the message quotes something this bot sent on the same channel |
| `ownRecent` | `true` / `false` | this bot has spoken here, the conversation has been quiet for less than ten minutes, and fewer than ten messages have arrived since |

At least one key is required and every key present must hold. A successful send by the bot resets `ownRecent` and a failed send does not; it expires after ten minutes without a message in the conversation, and a message in the conversation refreshes it. `replyToMe` is reported by the adapter, false when the transport carries no parent message id; both are false for non-message events. A matcher with no key, an unknown key, both `in` and `notIn`, an empty list or a non-boolean flag fails the mount. A match records `when_allow` or `when_deny` under `reasons`; `pass` and a miss record nothing.

```yaml
config:
  pipeline:
    global:
      - { id: named, type: when, test: { mentioned: true }, outcome: allow }
      - { id: roll, type: chance, when: { ownRecent: false }, probability: 0.99, outcome: deny }
```

A `chance` node takes its bucket from a fixed hash of the event key and the node id, so the same message replayed takes the same outcome and two chance nodes on one message draw independently. It records `chance_allow`, `chance_deny` or `chance_miss` with `p=` under `reasons`, and the adapter that carried the message counts it under `counters.chance[nodeId]` as `{ hit, miss }`; that key appears only after the node has run.

A `score` node adds what the host service `dsbot-channel/score` returns. A profile that declares one without that service fails the mount; a call that throws or returns anything but a finite number refuses the message with `score_failed` and leaves the running score untouched. The running score is in the result; it decides nothing on its own, and `allowAtLeast`, `question` and `context` stay on `judge`.

A `budget` node reads the spend of the busiest window: the ratio is the largest of the global, bot and session usage divided by `policy.budget.capacity`. `hardLimit` refuses; with `mayRestrict`, a ratio at or above `policy.budget.restrictAt` returns a restrict, which skips what `restrictSkip` names and lets the chain continue. A restrict is not an allow: a chain that ends after one still refuses, and the gate records `pipeline-restrict`. `restrictSkip` without `mayRestrict`, `mayRestrict` without `restrictAt`, or `mayRestrict` with an empty `restrictSkip` declares a field that would do nothing and fails the mount.

An adapter changes the chain it starts from with four keys: `inherit` names the layer it starts from, which for an adapter is `global`; `remove` drops nodes by id, `insert` adds a node after or before a named node, and `override` replaces fields of a node by id. `insert` sets exactly one of `after` or `before` and cannot reuse an existing id; `override` writes only fields the node's type reads; `remove` or `override` naming an id that is not there fails the mount. `question`, `context`, `probability`, `outcome`, `test`, `when`, `restrictSkip` and `mayRestrict` may be written in `pipeline.global` and in an adapter's `insert` or `override`. A session's `insert` takes only `id`, `type`, `after` and `before`, so it carries none of them; a session's `override` may set them.

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

`override` replaces fields by id and is what a judge node uses to change `allowAtLeast`, `question` and `context`; a judge node also needs one provider mounted. The chain above has no `allow` node and no judge threshold, so it refuses every message; it shows the layer operations only.

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
