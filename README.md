# dsbot-channel

English | [中文](./README_ZH.md)

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A message gateway for ds-bot: events from several external platforms reach one bot, and answers go back to the conversation they came from.

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

```yaml
config:
  adapters:
    - kind: p2p
      channel: p2p:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7123 }
        peers:
          - instance: peer-a
            secret: PEER_A_REFERENCE
    - kind: onebot
      channel: onebot:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7331 }
        api: { url: "http://127.0.0.1:3000" }
        accessToken: ONEBOT_TOKEN
    - kind: onebot
      channel: onebot:ws
      botName: self-bot
      transport:
        protocol: ws-reverse
        listen: { host: 127.0.0.1, port: 7332, path: /onebot/ws }
        accessToken: ONEBOT_TOKEN
```

`transport.peers` takes either a list or a mapping of peer instance to secret reference, `peers: { peer-a: PEER_A_REFERENCE }`. The list form also carries `url`, `host` and `botName`; a mapping value is only a secret reference, so a peer that needs one of the other fields stays in the list form. A profile that mixes the two forms, or maps an instance to something that is not a secret reference, is refused at mount.

`channel`, `botName` and `transport` are required, and `channel` must be unique. `reply`, `turn` and `policy` may also be written at the top level as defaults; an adapter replaces the keys it writes whole, so an object or an array is taken as written and not merged field by field. The plugin-level status names the level that supplied each key under `config[].layers`. Two adapters that answer for the same bot and session key still share that session, but each keeps its own coalescing window and context buffer. `channel` is the adapter's only name; peers see it on the wire too. `kind` defaults to `p2p`; `onebot` is the other built-in, and a third-party transport registers as `x-[a-z0-9-]+`, at most 32 characters. `secret` and `accessToken` are reference names in the host credentials service, not the secrets themselves. Paths in a profile are read as POSIX paths; Windows is not supported.

An OneBot adapter speaks one protocol: `transport.protocol` is `http` (the default), `ws-forward` or `ws-reverse`. A field that belongs to another protocol is refused when the profile loads. Each adapter is one link: an implementation reached over one protocol gets one OneBot adapter, not two.

A `pipeline` block declares the node chain. A `judge` node needs the host service `dsbot-channel/judge`, which answers `judge(event, context)` with `{ score, reason? }`; a profile that declares the node without the service fails the mount, and a judge that times out or throws refuses the message with `judge_timeout` or `judge_failed`. A judge node may also carry `allowAtLeast` (0 to 1): a verdict at or above it allows the message, one below it refuses with `judge_below_threshold` and the score, and without it the node only scores.

The impression library is off until a top-level `impressions` block names an absolute `dir`. It keeps short notes about the person a turn answers or about its group; `impression_put`, `impression_get` and `impression_forget` read and write them.

| Field | Default | Meaning |
| --- | --- | --- |
| `policy.requireMention` | `false` | groups must mention |
| `policy.groupBots` | `whenMentioned` | bot messages in groups |
| `policy.budget.capacity` | off | points per window |
| `policy.budget.hardLimit` | `1` | ratio that refuses |
| `reply.default` | `auto` | how a turn answers |
| `reply.byScope` | — | mode per scope |
| `reply.rules` | — | ordered overrides |
| `turn.coalesceMs` | `0` | merge window |
| `turn.maxBatch` | `10` | messages per batch |
| `turn.maxChars` | `8000` | batch budget |
| `turn.context.messages` | `0` | earlier messages |
| `turn.context.chars` | `2000` | context budget |
| `pipeline.judgeTimeoutMs` | `8000` | one judge call |
| `pipeline.judgePoints` | `1` | points a verdict costs |
| `allowAtLeast` (judge node) | off | score that allows the message |
| `impressions.dir` | off | notes root |
| `transport.protocol` | `http` | OneBot: how it connects |
| `transport.heartbeat` | off | OneBot on a socket: liveness |
| `transport.reconnect` | backoff | OneBot `ws-forward`: backoff, `false` to stay offline |
| `transport.history.group` | `false` | OneBot: group history |
| `transport.history.private` | `false` | OneBot: private history |
| `transport.fileFromUrl` | `false` | OneBot: file from a url |
| `status` | `true` | status route |

## License

MIT. See [LICENSE](./LICENSE).
