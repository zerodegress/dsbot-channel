# dsbot-channel

English | [中文](./README_ZH.md)

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A message gateway for ds-bot: events from several external platforms reach one bot, and answers go back to the conversation they came from.

Whether to speak at all is an explicit decision — `no_reply`, `decline`, the relay round limit, pipeline gates — and with `policy.budget` set every turn is metered per bot. Those choices, together with `inReplyTo` marking which message an answer answers, are the step this project takes in the direction the DSH team explores with its Super Agent prototype.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- pnpm
- The host credentials service, for adapter secrets
- The host session controller service, for running turns
- The host tools service, when a profile can choose tool mode

Tested against DS-Bot 0.2.x, 0.2.5 at the time of this release. Compatibility with later DS-Bot releases is not guaranteed.

## Install

Install it from the dsh UI.

You can also install it from a terminal:

```sh
dsh plugin --profile ds-bot add dsbot-channel
```

Run this against the profile that runs your bot.

Alternatively, build from source:

```sh
pnpm install
pnpm build
```

## Usage

Mount the plugin in a profile through its bundle patch. It starts idle.

Adapters are listed in the same `cordis.patch.yml`:

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
```

`instance` and `channel` are both required on every adapter, and `channel` must be unique. `secret` is a reference name in the host credentials service, not the secret itself.

`kind` names the transport and defaults to `p2p`; the built-in kinds are `p2p` and `onebot`, and any other transport registers as `x-[a-z0-9-]+`, at most 32 characters.

Set `policy.requireMention: true` to refuse group messages that mention neither the bot nor everyone. It needs a transport that can tell mentions apart, so it applies to `onebot` rather than `p2p`.

OneBot 11 is built in. It receives events on `listen.path`, which defaults to `/onebot/event`; media is received but not sent in this version.

```yaml
config:
  adapters:
    - kind: onebot
      channel: onebot:self
      instance: onebot
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7331 }
        api: { url: "http://127.0.0.1:3000" }
        accessToken: ONEBOT_TOKEN
```

`reply` chooses how a turn answers: `auto` lets it write text, `tool` requires a tool call. Ordered rules win over the by-scope map, which wins over the default:

```yaml
config:
  reply:
    default: auto
    byScope:
      group: tool
    rules:
      - when: { source: { kind: p2p }, body: { text: { words: [ping] } } }
        mode: auto
```

Set `status: false` on an adapter to leave its status route unregistered.

The patch ships enabled with no adapters, so the base starts idle; a profile declares its own adapters to start a listener.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## License

MIT. See [LICENSE](./LICENSE).
