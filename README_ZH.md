# dsbot-channel

ds-bot 的 cordis 插件，实例之间通过 peer 链路互发消息。

[English](./README.md)

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- pnpm
- 宿主的凭据服务，用于解析对端密钥

## 安装

尚未发布。从源码安装：

```sh
pnpm install
pnpm build
```

## 用法

通过插件的 bundle patch 在 profile 里挂载。基座启动后处于空闲状态：没配 adapter 就什么都不绑。

adapter 写在同一个 `cordis.patch.yml` 里：

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

`secret` 填的是宿主任凭服务里的引用名，不是密钥本身。

patch 出厂是禁用的。把那一行的 `disabled` 改成 `false`，listener 才会启动。

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```
