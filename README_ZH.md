# dsbot-channel

[English](./README.md) | 中文

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

ds-bot 的消息网关：多个外部平台的事件进到同一个 Bot，回答投回它来的那个会话。

要不要开口是一个显式决定——`no_reply`、`decline`、relay 回合上限、管道闸门；配了 `policy.budget` 时，每一轮按 Bot 记账。这些选择，加上用 `inReplyTo` 标出回答的是哪条消息，就是本项目朝 DSH 团队用 Super Agent 原型探索的方向走的那一步。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- pnpm
- 宿主的凭据服务，用于解析适配器密钥
- 宿主的会话控制服务，用于跑回合
- 宿主的 tools 服务，当 profile 可能选择 tool 模式时

已在 DS-Bot 0.2.x 上测试（本版发布时为 0.2.5）。不保证与后续版本的兼容性。

## 安装

在 dsh 的界面里安装。

也可以在终端里直接装：

```sh
dsh plugin --profile ds-bot add dsbot-channel
```

profile 写运行 Bot 的那个。

亦可从源码构建：

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

群里由 bot 发出的消息按 `policy.groupBots` 处理：默认 `whenMentioned`，只有点名本 bot 或 @ 所有人才回答；`silent` 一律不答；`answer` 当普通人处理。这条判断先于 `requireMention`，分辨不了提及的传输会退化为 `silent`。

OneBot 11 内置。事件接收地址是 `listen.path`，默认 `/onebot/event`；媒体出入都走实现的 api。

`read_history` 从能翻页的传输读更早的消息。OneBot 用 `transport.history: { group: true, private: true }` 按地址种类分别打开，默认都关闭——这两个 API 都不属于 OneBot 11；一页返回 `records`，还有更早的消息时附带 `next`，它是下次作为 `before` 传回的游标。

`send_file` 在 OneBot 上真的会发出去：走 `upload_group_file` 或 `upload_private_file`，一个文件一次调用，`name` 必填——接收方需要文件名。只有当 `transport.fileFromUrl: true` 说明该实现接受 url 时，文件才以 url 形式发送（多数实现只认自己机器上的路径），适配器不会去下载它。内置的 p2p 链路只搬运 url，所以 `send_file` 在它上面返回 `unsupported_capability`，链接请用消息发送。

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

`turn` 决定一个回合回答几条消息。`coalesceMs` 以毫秒为单位开一个窗口，窗口内到达的消息合起来回答，`maxBatch` / `maxChars` 可提前收口。默认 `0` 保持一条消息一个回合；合并的一批只计费一次、只记一条记录：

```yaml
config:
  turn:
    coalesceMs: 1200
    maxBatch: 10
    maxChars: 8000
    context:
      messages: 30
      chars: 2000
```

`turn.context.messages` 会保留该会话最近这么多条消息，以 `[context]` 块放在回合正文之前，让回答知道前面发生了什么；`chars` 是这块的字符上限，超出时按整条丢弃最旧的消息。默认关闭（`0`），预算 `2000`。

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
