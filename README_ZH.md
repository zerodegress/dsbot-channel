# dsbot-channel

[English](./README.md) | 中文

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

ds-bot 的消息网关：多个外部平台的事件进到同一个 Bot，回答投回它来的那个会话。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`，以及 pnpm
- 宿主的服务：凭据（解析密钥）、会话控制（跑回合）、tools（tool 模式）。宿主提供 session persistence 时，每条回复投递成功后经它 flush 会话日志。

已在 DS-Bot 0.2.x 上测试；不保证与后续版本兼容。

## 安装

在 dsh 界面里安装，或在终端里：

```sh
dsh plugin --profile ds-bot add dsbot-channel
```

从源码构建：`pnpm install`，再 `pnpm build`。

## 配置

通过 bundle patch 在 profile 里挂载。出厂启用但没有 adapter，不配就一直空闲。

```yaml
config:
  adapters:
    - kind: p2p
      channel: p2p:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7123 }
        peers:
          - instance: peer-a
            secret: PEER_A_REFERENCE
    - kind: onebot
      channel: onebot:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7331 }
        api: { url: "http://127.0.0.1:3000" }
        accessToken: ONEBOT_TOKEN
    - kind: onebot
      channel: onebot:ws
      botName: self-bot
      transport:
        protocol: ws-reverse
        listen: { host: 127.0.0.1, port: 7332, path: /onebot/ws }
        accessToken: ONEBOT_TOKEN
```

`transport.peers` 可以写成列表，也可以写成「对端 instance → 密钥引用」的映射，如 `peers: { peer-a: PEER_A_REFERENCE }`。列表写法还能带 `url`、`host` 与 `botName`；映射的值只能是密钥引用，需要这几项的对端仍用列表写法。同一份 `peers` 里混写两种写法，或映射的值不是密钥引用，都会在挂载期被拒绝。

`channel`、`botName`、`transport` 必填，`channel` 不能重复。`reply`、`turn`、`policy` 也可以写在顶层作为默认值；adapter 写哪个键就整块替换那个键，对象和数组按写的那样整体生效，不逐项合并。插件级状态里的 `config[].layers` 标明每个键来自哪一层。两个 adapter 服务同一个 bot、落在同一个会话键时，会话仍然共享，但合并窗口与上下文缓冲各有一份。`channel` 是 adapter 唯一的名字，对端在线路上看到的也是它。`kind` 默认 `p2p`；另一个内置是 `onebot`，第三方传输用 `x-[a-z0-9-]+` 的名字，最长 32 字符。`secret` 与 `accessToken` 填的是宿主任凭服务里的引用名，不是密钥本身。配置里的路径按 POSIX 解释，暂不支持 Windows。

一条 OneBot adapter 只用一种协议：`transport.protocol` 取 `http`（默认）、`ws-forward` 或 `ws-reverse`。属于另一种协议的字段会在加载配置时报错。每个 adapter 是一条链路：同一个实现只走一种协议，就只声明一个 OneBot adapter。

`pipeline` 块声明节点链。`judge` 节点需要宿主提供 `dsbot-channel/judge` 服务，它以 `judge(event, context)` 返回 `{ score, reason? }`；声明了节点却没有这个服务会挂载失败，判定超时或抛错时按 `judge_timeout` / `judge_failed` 拒绝这条消息。`judge` 节点还可以带 `allowAtLeast`（0 到 1）：判定分达到或超过它就放行，低于它则以 `judge_below_threshold` 连同分数拒绝；不配则只计分。bot/session 层可以在 judge 节点上插入或覆盖 `allowAtLeast`。判定分必须是 0 到 1 之间的有限数，否则无论是否配阈值都按 `judge_failed` 处理。

印象库默认关闭，配置顶层的 `impressions` 块给出绝对路径的 `dir` 才启用。它存放关于本回合对端或本群的短笔记，用 `impression_put`、`impression_get`、`impression_forget` 读写。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `policy.requireMention` | `false` | 群消息必须点名 |
| `policy.groupBots` | `whenMentioned` | 群内 Bot 消息 |
| `policy.budget.capacity` | 关闭 | 每窗口点数 |
| `policy.budget.hardLimit` | `1` | 拒绝比例 |
| `reply.default` | `auto` | 回合怎么答 |
| `reply.byScope` | — | 按作用域 |
| `reply.rules` | — | 有序覆盖规则 |
| `turn.coalesceMs` | `0` | 合并窗口 |
| `turn.maxBatch` | `10` | 每批条数 |
| `turn.maxChars` | `8000` | 批次预算 |
| `turn.context.messages` | `0` | 历史条数 |
| `turn.context.chars` | `2000` | 上下文预算 |
| `pipeline.judgeTimeoutMs` | `8000` | 单次判定上限 |
| `pipeline.judgePoints` | `1` | 一次判定扣的点数 |
| `allowAtLeast`（judge 节点） | 关闭 | 达到该分数才放行 |
| `impressions.dir` | 关闭 | 笔记根目录 |
| `transport.protocol` | `http` | OneBot：连接方式 |
| `transport.heartbeat` | 关闭 | OneBot 走 socket：存活检查 |
| `transport.reconnect` | 退避重试 | OneBot `ws-forward`：退避重试，`false` 表示不重连 |
| `transport.history.group` | `false` | OneBot：读群历史 |
| `transport.history.private` | `false` | OneBot：读私聊历史 |
| `transport.fileFromUrl` | `false` | OneBot：用 url 发文件 |
| `status` | `true` | 状态路由 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
