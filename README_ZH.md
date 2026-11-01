# dsbot-channel

ds-bot 的 cordis 插件，实例之间通过 peer 链路互发消息。

[English](./README.md)

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- pnpm
- 宿主的凭据服务，用于解析对端密钥
- 宿主的会话控制服务，用于跑回合

## 安装

尚未发布。从源码安装：

```sh
pnpm install
pnpm build
```

## 用法

通过插件的 bundle patch 在 profile 里挂载。基座启动后处于空闲状态。

adapter 写在同一个 `cordis.patch.yml` 里：

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

`instance` 和 `channel` 每个 adapter 都必填，`channel` 不能重复。`secret` 填的是宿主的凭据服务里的引用名，不是密钥本身。

`kind` 声明这条通道的传输，不写默认 `p2p`；内置 `p2p` 和 `onebot`，第三方传输用 `x-[a-z0-9-]+` 的名字，不超过 32 个字符。

在 adapter 上设 `policy.requireMention: true` 后，群消息如果既没有点名 bot，也没有 @ 所有人，就会被拒掉。

OneBot 11 内置。事件接收地址是 `listen.path`，默认 `/onebot/event`；本版接收媒体但不出站发送媒体。

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

`reply` 决定一个回合怎么作答：`auto` 允许直接写文本，`tool` 要求必须调用工具。有序规则优先于按作用域的映射，再回落到默认值：

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

在 adapter 上设 `status: false` 可不注册它的状态路由。

patch 出厂是禁用的。把那一行的 `disabled` 改成 `false`，listener 才会启动。

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```
