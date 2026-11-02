# dsbot-channel

[English](./README.md) | 中文

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

ds-bot 的消息网关：多个外部平台的事件进到同一个 Bot，回答投回它来的那个会话。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`，以及 pnpm
- 宿主的三个服务：凭据（解析密钥）、会话控制（跑回合）、tools（tool 模式）

已在 DS-Bot 0.2.x 上测试。

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

`kind`（`p2p` 或 `onebot`）、`channel`、`instance`、`botName`、`transport` 都是必填，`channel` 不能重复。`secret` 与 `accessToken` 填的是宿主任凭服务里的引用名，不是密钥本身。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `policy.requireMention` | `false` | 群消息必须点名 |
| `policy.groupBots` | `whenMentioned` | 群内 Bot 消息 |
| `policy.budget.capacity` | 关闭 | 每窗口点数 |
| `policy.budget.hardLimit` | `1` | 拒绝比例 |
| `reply.default` | `auto` | 回合怎么答 |
| `reply.byScope` | — | 按作用域 |
| `turn.coalesceMs` | `0` | 合并窗口 |
| `turn.maxBatch` | `10` | 每批条数 |
| `turn.context.messages` | `0` | 历史条数 |
| `status` | `true` | 状态路由 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
