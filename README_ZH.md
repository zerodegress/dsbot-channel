# dsbot-channel

ds-bot 的 cordis 插件，实例之间通过 peer 链路互发消息。

[English](./README.md)

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- pnpm
- 宿主运行 `@deepseek-ai/cordis` 4.0.x（可选 peer，由宿主提供）
- 宿主的凭据服务，用于解析对端密钥

## 安装

尚未发布。从源码安装：

```sh
pnpm install
pnpm build
```

## 用法

通过插件的 bundle patch 在 profile 里挂载，然后在 profile 自己的 `cordis.patch.yml` 里提供 `botName`、`peers` 和 `listen`。对端密钥写引用名，由宿主解析，配置里不放密钥原文。

patch 出厂是 `disabled: true`，把那一行改成 `false` 之前插件不会启动。保持原样是静默的：进程正常，但端口不开。

宿主的凭据 provider（`@deepseek-ai/dsh-credentials-local`）必须先挂进 profile。缺了它，挂载会以 `ConfigError: the credentials service is required to resolve peer secrets` 失败。

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

