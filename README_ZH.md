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

通过插件的 bundle patch 在 profile 里挂载。基座启动后处于空闲状态：没配 adapter 就什么都不绑。

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

`instance` 和 `channel` 每个 adapter 都必填，`channel` 不能重复。`secret` 填的是宿主任凭服务里的引用名，不是密钥本身。

`kind` 声明这条通道的传输，不写默认 `p2p`。内置 kind 是 `p2p` 和 `onebot`；第三方传输注册时必须用 `x-[a-z0-9-]+`，不超过 32 个字符。一个 kind 对应一个实现：每个 kind 只能注册一次工厂，但可以有多个 adapter 复用它（两条 p2p 链接就是 `p2p` 的两个 adapter）。消息的 `source.kind` 必须等于承载它的适配器的 kind；profile 里写未知 kind 会在加载期失败。

在 adapter 上设 `policy.requireMention: true` 后，群消息如果既没有点名 bot（`self`），也没有 @ 所有人（`all`），就会被直接拒掉。该开关默认关闭，私聊不受影响；对于无法区分 `self`、`others`、`all` 的通道，不能开启这个开关，开启后会在加载期报错。

OneBot 11 是内置通道，走反向 HTTP：实现方把事件推到我们的监听器，回复则通过调用它的 HTTP API 发出。本版接收媒体但不出站发送媒体。

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

宿主还可以只读查询 `dsbot-channel.usage` 与 `dsbot-channel.turns`：前者报告每条会话的配额消耗，后者列出最近回合及其结束方式。两者都只读。

监听类通道会在回环地址上提供一条只读状态路由：p2p 适配器是 `/p2p/v1/status`，OneBot 适配器是 `/onebot/status`。它返回健康状态、能力与计数器；经转发器到达的请求会被拒绝。在 adapter 上设 `status: false` 即可不注册该路由。

`reply` 决定一个回合怎么作答。`auto` 允许直接写文本；`tool` 要求必须调用工具，纯文本会被丢弃并记一条 warn。有序规则优先于按作用域的映射，再回落到默认值：

```yaml
reply:
  default: auto
  byScope:
    group: tool
  rules:
    - when: { source: { kind: p2p }, body: { text: { words: [ping] } } }
      mode: auto
```

patch 出厂是禁用的。把那一行的 `disabled` 改成 `false`，listener 才会启动。

## 开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```
