# dsbot-channel

[English](./README.md) | 中文

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

ds-bot 的消息网关：多个外部平台的事件进到同一个 Bot，回答投回它来的那个会话。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`，以及 pnpm
- 宿主的三个服务：凭据（解析密钥）、会话控制（跑回合）、tools（tool 模式与印象工具）

已在 DS-Bot 0.2.x 上测试（本版发布时为 0.2.5）；不保证与后续版本兼容。

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
      instance: self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7123 }
        peers:
          - instance: peer-a
            secret: PEER_A_REFERENCE
    - kind: onebot
      channel: onebot:self
      instance: onebot
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7331 }
        api: { url: "http://127.0.0.1:3000" }
        accessToken: ONEBOT_TOKEN
```

`channel`、`instance`、`botName`、`transport` 必填，`channel` 不能重复。`kind` 默认 `p2p`；另一个内置是 `onebot`，第三方传输用 `x-[a-z0-9-]+` 的名字，最长 32 字符。`secret` 与 `accessToken` 填的是宿主任凭服务里的引用名，不是密钥本身。配置里的路径按 POSIX 解释，暂不支持 Windows。

印象库默认关闭；`impressions` 是配置顶层的块，不是 adapter 里的字段，`dir` 指向绝对路径才启用。把它放在本仓库之外。每只 Bot 的笔记放在 `<dir>/<sha256(botName)>/` 下，按 `person/` 与 `group/` 分两层，每个 subject 一个 `<sha256(subject)>.json`；文件 `0600`、目录 `0700`，用原子 rename 替换。`impression_put`、`impression_get`、`impression_forget` 只作用于本回合对端，或带 `about: "group"` 时作用于本群；每条笔记带支持它的消息，`impression_get` 返回 90 天半衰后剩下的置信度。

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
| `impressions.dir` | 关闭 | 笔记根目录，每个 subject 一个哈希文件 |
| `transport.history.group` | `false` | OneBot：读群历史 |
| `transport.history.private` | `false` | OneBot：读私聊历史 |
| `transport.fileFromUrl` | `false` | OneBot：用 url 发文件 |
| `status` | `true` | 状态路由 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
