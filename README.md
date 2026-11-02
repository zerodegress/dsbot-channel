# dsbot-channel

English | [中文](./README_ZH.md)

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A message gateway for ds-bot: events from several external platforms reach one bot, and answers go back to the conversation they came from.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`, and pnpm
- The host services: credentials (adapter secrets), session controller (turns), tools (tool mode)

Tested against DS-Bot 0.2.x (0.2.5 at the time of this release); later releases are not guaranteed.

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
      instance: self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7123 }
        peers:
          - instance: peer-a
            secret: PEER_A_REFERENCE
    - kind: onebot
      channel: onebot:self
      instance: onebot
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7331 }
        api: { url: "http://127.0.0.1:3000" }
        accessToken: ONEBOT_TOKEN
```

`channel`, `instance`, `botName` and `transport` are required, and `channel` must be unique. `kind` defaults to `p2p`; `onebot` is the other built-in, and a third-party transport registers as `x-[a-z0-9-]+`, at most 32 characters. `secret` and `accessToken` are reference names in the host credentials service, not the secrets themselves.

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
| `transport.history.group` | `false` | OneBot: group history |
| `transport.history.private` | `false` | OneBot: private history |
| `transport.fileFromUrl` | `false` | OneBot: file from a url |
| `status` | `true` | status route |

## License

MIT. See [LICENSE](./LICENSE).
