# dsbot-channel

A cordis plugin for ds-bot that carries messages between instances over a peer link.

[中文说明](./README_ZH.md)

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- pnpm
- The host credentials service, for peer secrets
- The host session controller service, for running turns

## Install

Not published yet. Install from a checkout:

```sh
pnpm install
pnpm build
```

## Usage

Mount the plugin in a profile through its bundle patch. It starts idle: with no adapters it binds nothing.

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

`kind` names the transport and defaults to `p2p`. The built-in kinds are `p2p` and `onebot`; any other transport registers as `x-[a-z0-9-]+`, at most 32 characters. A kind names one implementation: a factory registers once per kind, and several adapters may reuse it (two p2p links are two adapters of `p2p`). A message's `source.kind` must be the kind of the adapter that carried it, and a profile naming an unknown kind fails to load.

Set `policy.requireMention: true` on an adapter to refuse group messages that mention neither the bot (`self`) nor everyone (`all`). It is off by default, leaves direct chats alone, and cannot be enabled on a transport that cannot tell the three apart.

OneBot 11 is built in and speaks reverse HTTP: the implementation pushes events to the listener and replies are sent by calling its HTTP API. Media is received but not sent in this version.

```yaml
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

`reply` chooses how a turn answers. `auto` lets it write text; `tool` requires a tool call and discards a plain answer with a warning. Ordered rules win over the by-scope map, which wins over the default:

```yaml
reply:
  default: auto
  byScope:
    group: tool
  rules:
    - when: { source: { kind: p2p }, body: { text: { words: [ping] } } }
      mode: auto
```

The patch ships disabled. Set `disabled: false` on that row to start the listener.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```
