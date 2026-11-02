# dsbot-channel

[English](./README.md) | 中文

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

ds-bot 的消息网关：多个外部平台的事件进到同一个 Bot，回答投回它来的那个会话。

要不要开口是一个显式决定——`no_reply`、`decline`、relay 回合上限、管道闸门；配了 `policy.budget` 时，每一轮按 Bot 记账。这些选择，加上用 `inReplyTo` 标出回答的是哪条消息，就是本项目朝 DSH 团队用 Super Agent 原型探索的方向走的那一步。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- pnpm
- 宿主的凭据服务，用于解析适配器密钥
- 宿主的会话控制服务，用于跑回合
- 宿主的 tools 服务，当 profile 可能选择 tool 模式时

## 安装

```sh
dsh plugin --profile PROFILE_NAME add dsbot-channel
```

`PROFILE_NAME` 是 Bot 运行所用的 profile 名，例如 `web` 或 `tui`。

要改插件本身，改用源码安装：

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

设 `policy.requireMention: true` 后，群消息如果既没有点名 bot、也没有 @ 所有人，就会被拒掉。它需要能分辨提及的传输，所以适用于 `onebot`，不适用于 `p2p`。

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

patch 出厂是启用的，但不带 adapter，所以基座处于空闲状态；profile 自己声明 adapter 后 listener 才会启动。

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

## 许可证

MIT，见 [LICENSE](./LICENSE)。
