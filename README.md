# dsbot-channel

A cordis plugin for ds-bot that carries messages between instances over a peer link.

[中文说明](./README_ZH.md)

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- pnpm
- A host running `@deepseek-ai/cordis` 4.0.x (optional peer, supplied by the host)
- The host credentials service, used to resolve peer secrets

## Install

Not published yet. Install from a checkout:

```sh
pnpm install
pnpm build
```

## Usage

Mount the plugin in a profile through its bundle patch. It starts idle: with no adapters configured it binds nothing and needs no credentials service.

Adapters are listed in the same `cordis.patch.yml`. Each entry carries its own identity and address:

```yaml
config:
  adapters:
    - kind: p2p
      channel: p2p:self
      botName: self-bot
      listen: { host: 127.0.0.1, port: 7123 }
      peers:
        - instance: peer-a
          secret: PEER_A_REFERENCE
```

`secret` holds a reference name resolved by the host, never the secret itself. Configuring a `p2p` adapter requires the host credentials provider (`@deepseek-ai/dsh-credentials-local`); without it the mount fails with `ConfigError: the credentials service is required to resolve peer secrets`.

The patch ships with `disabled: true`, so the plugin does not start until that row is set to `false`. Leaving it on is silent: the process stays healthy and no port is opened.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

