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

`channel`、`botName`、`transport` 必填，`channel` 不能重复。`reply`、`turn`、`policy` 也可以写在顶层作为默认值；adapter 写哪个键就整块替换那个键，对象和数组按写的那样整体生效，不逐项合并。插件级状态里的 `config[].layers` 标明每个键来自哪一层。两个 adapter 服务同一个 bot、落在同一个会话键时，会话仍然共享，但合并窗口与上下文缓冲各有一份。`channel` 是 adapter 唯一的名字，对端在线路上看到的也是它。`kind` 默认 `p2p`；另一个内置是 `onebot`，第三方传输用 `x-[a-z0-9-]+` 的名字，最长 32 字符。`secret` 与 `accessToken` 填的是宿主任凭服务里的引用名，不是密钥本身。配置里的路径按 POSIX 解释，暂不支持 Windows。

一条 OneBot adapter 只用一种协议：`transport.protocol` 取 `http`（默认）、`ws-forward` 或 `ws-reverse`。属于另一种协议的字段会在加载配置时报错。每个 adapter 是一条链路：同一个实现只走一种协议，就只声明一个 OneBot adapter。

`delivery` 块可以写在顶层或单个 adapter 上，把回合回复切成多段并按节奏发送。只有回合回复会被切：`send_text`、拒绝与 `decline` 的说明都整段发出。`split.byBlankLine`（默认 `true`）在空行处切，`split.maxParts`（默认 `4`）把超出的部分并进最后一段、不丢弃，`split.maxChars`（默认 `0`，关闭）按码点硬切且不拆代理对与 CRLF。`pacing` 在发送下一段前等待「该段码点数 ÷ `charsPerSecond`（默认 `14`）」，夹在 `minMs`（默认 `700`）与 `maxMs`（默认 `5000`）之间；最后一段发完不等。某段失败就停掉后续段，整条回复按失败上报并带上已发出的段数。正文首尾的空行会被丢弃，段与段之间的空行也不会随消息发出。顶层和 adapter 都没有 `delivery` 块时回复整段发送；adapter 上的空块不添加任何键，顶层的值照旧生效。

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
| `delivery.split.byBlankLine` | `true` | 在空行处切分回复 |
| `delivery.split.maxParts` | `4` | 每回复段数，超出并入末段 |
| `delivery.split.maxChars` | `0` | 每段码点数，关闭 |
| `delivery.pacing.charsPerSecond` | `14` | 计算等待的阅读速度 |
| `delivery.pacing.minMs` | `700` | 段间最短等待 |
| `delivery.pacing.maxMs` | `5000` | 段间最长等待 |
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
