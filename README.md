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
      listen: { host: 127.0.0.1, port: 7123 }
      peers:
        - instance: peer-a
          secret: PEER_A_REFERENCE
```

`instance` and `channel` are both required on every adapter, and `channel` must be unique. `secret` is a reference name in the host credentials service, not the secret itself.

The patch ships disabled. Set `disabled: false` on that row to start the listener.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```
