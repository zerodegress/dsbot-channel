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

Mount the plugin in a profile through its bundle patch, then supply `botName`, `peers` and `listen` in the profile's own `cordis.patch.yml`. Peer secrets are references resolved by the host, never literals in the config.

The patch ships with `disabled: true`, so the plugin does not start until that row is set to `false`. Leaving it on is silent: the process stays healthy and no port is opened.

The host credentials provider (`@deepseek-ai/dsh-credentials-local`) must be mounted in the profile first. Without it the mount fails with `ConfigError: the credentials service is required to resolve peer secrets`.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

