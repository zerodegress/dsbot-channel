# dsbot-channel

[English](./README.md) | 中文

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

ds-bot 的消息网关：多个外部平台的事件进到同一个 Bot，回答投回它来的那个会话。

默认值列：写具体值就是默认值，`required` 表示必须设置，`off` 表示什么都没设——不写这个键就不会发生。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`，以及 pnpm
- 宿主的服务：凭据（适配器密钥）、会话控制（跑回合）、tools（tool 模式）。宿主提供 session persistence 时，每条回复投递成功后经它 flush 会话日志。

已在 DS-Bot 0.2.x 上测试；不保证与后续版本兼容。

## 安装

在 dsh 界面里安装，或在终端里：

```sh
dsh plugin --profile ds-bot add dsbot-channel
```

从源码构建：`pnpm install`，再 `pnpm build`。

## 配置

通过 bundle patch 在 profile 里挂载。出厂启用但没有 adapter，不配就一直空闲。

## 适配

```yaml
config:
  adapters:
    - kind: onebot
      channel: onebot:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7331 }
        api: { url: "http://127.0.0.1:3000" }
        accessToken: ONEBOT_TOKEN
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `kind` | `p2p` | `p2p`、`onebot`、`webhook`、`mail`，第三方传输用 `x-[a-z0-9-]+` |
| `channel` | required | 链路唯一名字，对端在线上也看到它 |
| `botName` | required | 这条链路服务的 Bot |
| `transport` | required | 按 kind 的配置块，见「对端」「OneBot」「Webhook」与「邮件」 |
| `session` | off | 所有回合都跑在同一个已有会话里 |
| `cwd` | off | 它创建的会话所在目录 |
| `agentPreset` | off | 它创建的会话所用 preset |
| `model` | off | 这些会话的模型，写作 `provider/model` |
| `status` | `true` | 注册只读状态路由 |
| `skill` | `true` | 宿主有 skills 服务时注册包内技能 |

`capabilities.outbound` 为 `false` 的 adapter 永不回写：core 不调它的 `send` 与 `refuse`，`send_text` 工具对它返回 `unsupported`，它的会话也没有可继承的地址。它的回合照常运行，所以允许它开回合的 profile 必须让回复路径始终选 `tool`，否则挂载失败。

`channel` 是 adapter 唯一的名字。`reply`、`turn`、`policy`、`delivery` 也可以写在顶层；adapter 没写的键一律继承，写了的键整值替换，数组按原样生效、不逐项合并。`pipeline` 自成一层：顶层写 `global` 节点、`maxTurnMs`、`judgeTimeoutMs` 与 `judgePoints`，adapter 上写 `inherit`、`remove`、`insert`、`override`。`events` 只在 adapter 上读；`impressions` 与 `identity` 只能写在顶层。插件状态在 `config[].layers` 里标出每个键来自哪一层。`secret` 与 `accessToken` 是宿主任凭服务里的引用名，不是密钥。路径按 POSIX 解释，不支持 Windows。

## 对端

```yaml
config:
  adapters:
    - kind: p2p
      channel: p2p:self
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 7123 }
        peers: { peer-a: PEER_A_REFERENCE }
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `transport.listen.host` | `127.0.0.1` | 只接受具体地址 |
| `transport.listen.port` | `7123` | |
| `transport.peers` | required | 对端 instance 到 secret 引用的列表或映射 |
| `transport.dedupe.ttlMs` / `.limit` | `604800000` / `100000` | 重放窗口与条数 |
| `transport.inflightTtlMs` | `300000` | 超过它仍未完成的 claim 视为残留 |
| `transport.sentAtWindowMs` | `300000` | 签名新鲜度窗口 |
| `transport.maxBodyBytes` | `65536` | 请求体上限 |
| `transport.waitMs` | `10000` | 重复消息等待多久 |

写成列表条目的对端还可以带 `url`、`host`、`botName`；映射的值只能是 secret 引用。两种形态混用会在挂载期被拒。`peers[].instance` 是对端的名字，不是本链路的——这是唯一一处不是本 adapter `channel` 的名字。同一对端 instance 的两条条目必须用不同 secret。`transport.inflightTtlMs` 必须大于 `pipeline.maxTurnMs`。

## OneBot

```yaml
config:
  adapters:
    - kind: onebot
      channel: onebot:ws
      botName: self-bot
      transport:
        protocol: ws-reverse
        listen: { host: 127.0.0.1, port: 7332, path: /onebot/ws }
        accessToken: ONEBOT_TOKEN
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `transport.protocol` | `http` | `http`、`ws-forward` 或 `ws-reverse` |
| `transport.listen.host` | `127.0.0.1` | 只接受具体地址 |
| `transport.listen.port` | `7331` | |
| `transport.listen.path` | `http`：`/onebot/event`；`ws-reverse`：`/onebot/ws` | 事件路径 |
| `transport.api.url` | required | `http` 用 `http(s)`、`ws-forward` 用 `ws(s)`：动作端点 |
| `transport.event.url` | 同 `api.url` | `ws-forward`：事件 socket |
| `transport.reconnect` | `{ initialMs: 500, maxMs: 30000, factor: 2 }` | `ws-forward`：`false` 表示不重连 |
| `transport.heartbeat` | off | socket 存活检查；`timeoutMs` 必须大于 `intervalMs` |
| `transport.accessToken` | off | 引用名 |
| `transport.selfId` | 取自事件 | 与本机不符的事件被丢弃 |
| `transport.bots` | `[]` | 这些 id 按 bot 计，不按人计 |
| `transport.sendTimeoutMs` | `10000` | 单次动作超时 |
| `transport.history.group` / `.private` | `false` | 按地址种类允许 `read_history` |
| `transport.fileFromUrl` | `false` | 允许 `send_file` 用 http(s) url |
| `events.turn` | `[]` | 允许开回合的非消息事件类；adapter 自己的动作用 `action.<type>` |

一个 adapter 只用一种协议；属于另一种协议的字段在加载期被拒。一个实现只对应一个 adapter，不是两个。`events.turn` 按 `<kind>.<type>` 填类名：OneBot 自己的 `notice.group_recall`、`request.friend` 这类，或 adapter 为 push、CI、定时器事件定义的 `action.<type>`。其余非消息事件只被记录与计数、不开回合，`meta_event` 与自己的回声永不开回合，写了未知类名会挂载失败，被点名的类跳过提及要求。

## Webhook

评论所在的房间按 issue 或 pull request 命名：`gh:<owner>/<repo>#<number>`；只属于仓库的事件（如 push、release）所在房间是 `gh:<owner>/<repo>`。

```yaml
config:
  adapters:
    - kind: webhook
      channel: gh:acme/api
      botName: self-bot
      transport:
        listen: { host: 127.0.0.1, port: 8463, path: /github/webhook }
        secret: WEBHOOK_SECRET
        token: API_TOKEN
        api: https://api.github.com
        login: acme-bot
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `transport.listen.host` / `.port` / `.path` | `127.0.0.1` / `8463` / `/github/webhook` | 调用到达的位置 |
| `transport.secret` | required | 凭据引用：原始请求体的 HMAC-SHA256 密钥 |
| `transport.token` | required | 凭据引用，用来发评论 |
| `transport.dialect` | `auto` | `github`、`forgejo`，或由请求头判断的 `auto`；请求写了另一种方言时返回 400 |
| `transport.api` | `https://api.github.com` | 评论 API 的基地址 |
| `transport.login` | required | 本 bot 的 login，用于解析 `@` |
| `transport.bots` | `[]` | 计入 bot 发言的 login |
| `transport.repos` | `[]` | 可选的 `owner/repo` 白名单 |

issue 评论、review 评论，或带正文的 pull request review 会起一个回合，回复作为评论发回同一个 issue。评论之外的事件，例如 `issues`、`pull_request`、`push`、`release` 与 CI 运行，是 `action` 事件：只带一行摘要，除非类的名字写进 `events.turn`（`action.push`、`action.ci`、`action.issues` 等），否则不起回合。ping 与 installation 事件直接回 200，在进网关前丢掉。签名校验不通过的请求直接 401，不进网关；签名通过但没有事件头的请求回 400；同一次投递、或同一条评论换个 delivery 重投，只跑一次。这个 adapter 只写评论，不编辑、不关闭任何东西。

## 邮件

一个邮箱是一条链路，房间按线程根划分：`mail:<thread-root>`。邮件列表地址是回复目标，直邮回给发件人。

```yaml
config:
  adapters:
    - kind: mail
      channel: mail:bot
      botName: self-bot
      transport:
        imap: { host: 127.0.0.1, port: 993, secure: true, user: bot@example.test, password: IMAP_SECRET, mailbox: INBOX, pollMs: 30000 }
        smtp: { host: 127.0.0.1, port: 465, secure: true, user: bot@example.test, password: SMTP_SECRET }
        from: bot@example.test
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `transport.imap.host` / `.port` / `.user` / `.password` | required | 读取用的邮箱；`password` 是凭据引用 |
| `transport.imap.secure` | `true` | 到邮箱的 TLS；`false` 为明文 |
| `transport.imap.mailbox` | `INBOX` | 轮询的文件夹 |
| `transport.imap.pollMs` | `30000` | 轮询间隔 |
| `transport.smtp.host` / `.port` / `.user` / `.password` | required | 回信走哪台服务器；`password` 是凭据引用 |
| `transport.smtp.secure` | `true` | `true`、`false` 或 `starttls` |
| `transport.from` | required | 回信的发件地址 |
| `transport.signature` | off | 追加在回信正文后的署名 |
| `transport.listUnsubscribe` | off | 回信上的 `List-Unsubscribe` |
| `transport.bots` | `[]` | 计入 bot 发言的发件人 |
| `transport.lists` | `[]` | 头里没写明时按列表处理的地址 |
| `transport.maxAttachmentBytes` | `10485760` | 记录为元数据的附件上限；超过的丢弃并告警 |

IMAP 与 SMTP 由 `imapflow` 和 `nodemailer` 承担，下面的配置字段不随库变化。一条线程就是一条链：回信带 `In-Reply-To` 与完整的 `References`，所以回复落回原来的讨论。根取 `References` 第一条，缺则 `In-Reply-To`，再缺则自身 `Message-ID`。列表邮件回给列表，直邮回给发件人。HTML 按文本读取：脚本、样式、图片与标签都被剥掉。附件不交给模型：只记录名字、类型与大小，超过 `maxAttachmentBytes` 的丢弃并告警。

## 回合与切段

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `reply.default` | `auto` | `auto` 或 `tool` |
| `reply.byScope` | off | 按作用域指定模式：`c2c`、`group`、`p2p` |
| `reply.rules` | off | 有序规则，首个命中生效 |
| `turn.coalesceMs` | `0` | 合并窗口；`0` 表示一条消息一个回合 |
| `turn.maxBatch` | `10` | 每批条数 |
| `turn.maxChars` | `8000` | 批次预算 |
| `turn.context.messages` | `0` | 放在回合前的历史条数 |
| `turn.context.chars` | `2000` | 上下文预算 |
| `turn.impressions.chars` | `400` | 注入回合的笔记上限；`0` 表示不注入 |
| `delivery.split.byBlankLine` | `true` | 按空行切段 |
| `delivery.split.maxParts` | `4` | 每回复段数，超出并入最后一段 |
| `delivery.split.maxChars` | `0` | 每段字符数上限 |
| `delivery.pacing.charsPerSecond` | `14` | 计算等待的阅读速度 |
| `delivery.pacing.minMs` | `700` | 段间最短等待 |
| `delivery.pacing.maxMs` | `5000` | 段间最长等待 |

只有回合回复会被切段；`send_text`、拒绝与婉拒消息整条发出。任何地方都没写 `delivery` 时回复整条发出。一批只计费一次、只留一条记录。每段前的等待是「该段码点数 ÷ `charsPerSecond`」，夹在 `minMs` 与 `maxMs` 之间，最后一段之后不等待。`maxChars: 0` 关闭硬切，空的 `delivery` 块不添加任何键。某段失败即停止，回复按失败记录已发出的段数。

## 判定

```yaml
config:
  pipeline:
    global:
      - id: worthy
        type: judge
        allowAtLeast: 0.6
        question:
          type: noul
          instructions: Is this message worth answering?
          criteria: { true: worth answering, false: not worth answering }
        context: This bot answers questions about the project only.
```

`judge` 节点需要宿主服务 `dsbot-channel/judge`，它以 `{ score, reason? }` 回应 `judge(event, context)`。声明了节点但没有该服务，挂载失败；判定超时或抛错分别以 `judge_timeout`、`judge_failed` 拒绝该消息，分数不是 0–1 的有限数同样判失败。`allowAtLeast` 也可以由 adapter 的 `insert` 或 `override` 写入，或由 session 的 `override` 写入；judge 节点读哪些字段、能写在哪一层，见「管道节点」。`judgeTimeoutMs` 不得超过 `maxTurnMs`。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.maxTurnMs` | `120000` | 一个回合的预算 |
| `pipeline.judgeTimeoutMs` | `8000` | 一次判定，含重试 |
| `pipeline.judgePoints` | `1` | 一次判定扣的点数 |
| `allowAtLeast`（judge 节点） | off | 达到该分数就放行 |

两个入口提供该服务，二选一，并且必须**排在网关之前**。

```yaml
- id: dsbot-channel/system-one
  name: dsbot-channel/system-one
  config:
    credential: JUDGE_KEY
    baseUrl: https://api.typesafe.ai/v1/systemone
    model: jev-latest
```

```yaml
- id: dsbot-channel/llm
  name: dsbot-channel/llm
  config:
    credential: JUDGE_KEY
    baseUrl: https://openrouter.ai/api/v1
    model: vendor/model
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `credential` | required | 引用名 |
| `baseUrl` | required | 绝对 http(s) 地址；`llm` 向 `{baseUrl}/chat/completions` 发请求 |
| `model` | required | 模型 id |
| `maxChars` | `2000`（`system-one`）、`6000`（`llm`） | 正文截断上限；同时也是单个节点 `context` 的码点上限 |

两个入口都发送正文、作用域、作者 id、是否被点名以及节点的 `context`——不带历史、不带工具——并在 `pipeline.judgeTimeoutMs` 内对 `429` / `529` 重试一次。`llm` 只接受裸 JSON。同一个 profile 挂第二个 provider 会在加载期失败。其余键会在挂载期失败并在错误里点名；别的包提供的 judge 服务不报 `needsQuestion` / `maxChars` 时按 `false` / `2000` 处理。

## 评分

`score` 节点需要宿主服务 `dsbot-channel/score`，它以 `score(event, context)` 返回一个数，同步或异步均可。它必须**排在网关之前**：网关挂载时读取该服务。返回值累加进分数，可以为负，它自己不做判定。后续节点在 `context.score` 里能看到累计分，读它的 judge provider 可以把它并进自己的判定。内置 provider 不读这个分，所以它不会进提示词。`allowAtLeast` 比的是 judge 自己的分，不是累计分。

```ts
import type { PipelineEvent, NodeContext } from 'dsbot-channel'

export function apply(ctx) {
  ctx.provide('dsbot-channel/score')
  ctx.set('dsbot-channel/score', {
    score(event: PipelineEvent, context: NodeContext): number {
      return context.score + 1
    },
  })
}
```

## 一条消息怎么被判定

入站消息走三步：adapter 先去重，policy 关卡决定它能不能成为回合，pipeline 再决定这个回合放不放行。被拒绝的回合会以 `outcome: rejected` 加 gate 的 code 记进 turns 快照，具体原因写日志。

| policy 键 | 默认 | 决定什么 |
| --- | --- | --- |
| `policy.requireMention` | `false` | 群消息必须点名机器人或 @全体；分辨不了提及的传输（`p2p`、`mail`）在挂载期直接拒绝这个配置 |
| `policy.groupBots` | `whenMentioned` | 另一个机器人的群消息怎么处理：`whenMentioned`、`silent` 或 `answer` |
| `policy.relayLimit` / `policy.relayResetMs` | `3` / `300000` | 一个对端最多连续占几轮，以及重置这个计数的空闲时间 |
| `policy.deny.words` / `policy.deny.regexes` | `[]` | 拒绝消息的子串与正则，匹配不区分大小写 |
| `policy.allow.peers` | `[]` | `allow` 节点匹配的 `source.peer`；命中即放行并结束链条 |
| `policy.budget.capacity` / `policy.budget.hardLimit` | 写了 `budget` 就必填 / `1` | 每个窗口的点数，以及网关据此拒绝的比例，按硬窗口执行 |
| `policy.budget.restrictAt` | off | `budget` 节点可以转入 restrict 的比例；大于 0 且小于 `hardLimit` |

空词、非法正则、空对端名都会让挂载失败。`policy.deny` 与 `policy.allow` 要靠节点才生效：没声明 `pipeline` 的 profile 会自动补上节点，声明了就得自己加，否则规则静默失效。

judge 是**管道里的一个节点**，不是关卡：先挂 provider，再声明节点。不带 `allowAtLeast` 时它只加分，链条走到末尾没有放行仍然拒绝；带了就按阈值判定，达到放行、低于拒绝。

三种常见起点：

```yaml
# 群里只在被点名时回复
config:
  policy: { requireMention: true }
```

```yaml
# 先挡垃圾词，再由 judge 判定（需先挂 provider）
config:
  policy:
    deny: { words: [spam], regexes: ['^\s*$'] }
  pipeline:
    global:
      - { id: guard, type: deny }
      - { id: verdict, type: judge, allowAtLeast: 0.6 }
```

```yaml
# 先挂 provider，再按 judge 的置信度放行
config:
  pipeline:
    global:
      - { id: verdict, type: judge, allowAtLeast: 0.6 }
```

## 管道节点

节点是 `{ id, type }` 加上该类型读取的字段。链条按顺序执行，遇到第一个 `deny` 或 `allow` 就结束；走到末尾仍未放行的按拒绝处理。

| 节点 | 作用 |
| --- | --- |
| `deny` | `policy.deny` 命中即拒绝。没有 `policy.deny` 规则时声明 `deny` 节点会让挂载失败。 |
| `allow` | `policy.allow` 命中即放行，并跳过后面所有 `score` 与 `judge`。没有 `policy.allow` 对端时声明 `allow` 节点会让挂载失败。 |
| `judge` | 通过宿主 judge 服务打分；`allowAtLeast` 是阈值，节点还读取 `question` 与 `context`。 |
| `score` | 加上宿主 score 服务返回的值；抛错或不是有限数时以 `score_failed` 拒绝。 |
| `budget` | 读取最忙窗口的花费：hard 拒绝，`mayRestrict` 在 `restrictAt` 处转入 restrict。 |
| `prepare` | 执行宿主提供的 prepare 钩子，然后通过。为该 bot 服务的每个 adapter 都必须带这个钩子，否则挂载失败。 |
| `chance` | 按 `probability` 命中：命中即以 `allow` 或 `deny` 结束链条，未命中则交给下一个节点。 |
| `when` | 用一个 Matcher 判定：命中返回它的 `outcome`，未命中直接通过。 |

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `id` | required | `matched` 与 `reasons` 用它指代该节点。 |
| `type` | required | 上面八种之一。 |
| `allowAtLeast` | off | 仅 `judge`：0 到 1 的分数。 |
| `question` | required | 仅 `judge`：这个节点问什么。`system-one` 必须有；`llm` 节点带了会挂载失败。 |
| `question.type` | required | `noul`、`score` 或 `choice`。 |
| `question.instructions` | required | 一句问题或陈述。 |
| `question.criteria` | required | `noul`：`{ true, false }`；`score`：2 到 10 档，由低到高。 |
| `question.options` | required | 仅 `choice`：至少两项。 |
| `question.target` | required | 仅 `choice`：`question.options` 中的一项，取它的概率作为分数。 |
| `question.min` / `.max` | off | 仅 `score`：换算原始分；两者相等判失败。 |
| `context` | off | 仅 `judge`：静态材料，字符串或「名字→字符串」映射。 |
| `probability` | required | 仅 `chance`：0 到 1。 |
| `outcome` | required | `when`：`allow`、`deny` 或 `pass`；`chance`：`allow` 或 `deny`。 |
| `test` | required | 仅 `when`：它读取的 Matcher。 |
| `when` | off | 仅 `chance`：它掷骰前要满足的 Matcher。 |
| `restrictSkip` | off | 仅 `budget`：restrict 跳过什么，与 `mayRestrict` 同用时必填。`scoring` 跳过 `score` 与 `judge`；`judge` 只跳 `judge`。 |
| `mayRestrict` | off | 仅 `budget`：比例达到 `policy.budget.restrictAt` 时转入 restrict。 |

`question` 里上述字段之外的键会让挂载失败，错误带节点 id 与字段名。单个 `context` 的码点总数不得超过 provider 的 `maxChars`，映射的名字也计入；名字或值为空、类型不对或超长都会挂载失败。`context` 是配置方知道的材料，不是发生过的事：正文、作用域、作者与是否被点名本来就随事件发送，历史、会话与工具一律不读。`llm` 把它渲染在消息事实之后；`system-one` 放进 `state.context`。

`when` 节点用一个 Matcher 判定：命中返回它的 `outcome`，未命中直接通过。同一个 Matcher 也可以给 `chance` 做前置条件；条件不成立时直接通过，不掷骰、不记 `counters.chance`、不写 `chance_miss`。

| Matcher 键 | 取值 | 含义 |
| --- | --- | --- |
| `scope` | `c2c`、`group`、`p2p` | 会话类型 |
| `peer` | 字符串，或 `{ in: [...] }` / `{ notIn: [...] }` | 事件里的对端；事件没有 `peer` 时 `in` 不匹配、`notIn` 匹配 |
| `mentioned` | `true` / `false` | 本 bot 或所有人被点名 |
| `replyToMe` | `true` / `false` | 这条消息引用了本 bot 在同一 channel 上发出的消息 |
| `ownRecent` | `true` / `false` | 本 bot 在本会话说过话、会话静默不足十分钟，且此后收到的消息少于十条 |

至少写一个键，写了多个必须同时成立。本 bot 成功发出消息会把 `ownRecent` 归零，发送失败不归零；会话静默满十分钟后过期，期间有新消息会刷新。`replyToMe` 由 adapter 给出，没有父消息 id 时恒为 false；非消息事件两者都为 false。没有键、未知键、`in` 与 `notIn` 同时写、空列表或非布尔值都会让挂载失败。命中会把 `when_allow` 或 `when_deny` 记进 `reasons`；`pass` 与未命中不记。

```yaml
config:
  pipeline:
    global:
      - { id: named, type: when, test: { mentioned: true }, outcome: allow }
      - { id: roll, type: chance, when: { ownRecent: false }, probability: 0.99, outcome: deny }
```

`chance` 节点的落桶值来自「事件键 + 节点 id」的固定哈希：同一条消息重放结果相同，同一条消息上的两个 chance 节点互相独立。它在 `reasons` 下记 `chance_allow`、`chance_deny` 或 `chance_miss`（带 `p=`），承载这条消息的 adapter 在 `counters.chance[nodeId]` 记 `{ hit, miss }`；该键只在节点实际跑过之后出现。

`score` 节点加上宿主服务 `dsbot-channel/score` 返回的值。声明了节点却没有该服务，挂载失败；调用抛错或返回的不是有限数，该消息以 `score_failed` 拒绝，累计分数保持不变。累计分数在结果里；它自己不做判定，`allowAtLeast`、`question` 与 `context` 仍只归 `judge`。

`budget` 节点读取最忙窗口的花费：比例取 global、bot 与 session 三者用量的最大值除以 `policy.budget.capacity`。`hardLimit` 拒绝；配了 `mayRestrict` 时，比例达到 `policy.budget.restrictAt` 就返回 restrict，跳过 `restrictSkip` 指定的节点并让链条继续。restrict 不是放行：走到链尾仍然拒绝，网关记为 `pipeline-restrict`。`restrictSkip` 没配 `mayRestrict`、`mayRestrict` 没配 `restrictAt`、或 `mayRestrict` 的 `restrictSkip` 为空，都是不会生效的字段，挂载失败。

adapter 用四个键调整它继承到的链条：`inherit` 指定从哪一层开始（adapter 层只能是 `global`），`remove` 按 id 删节点，`insert` 把节点插到某个 id 之前或之后，`override` 按 id 替换节点字段。`insert` 的 `after` 与 `before` 只能写一个、不能复用已有的 id；`override` 只写该节点类型拥有的字段；`remove` 或 `override` 指向不存在的 id 会让挂载失败。`question`、`context`、`probability`、`outcome`、`test`、`when`、`restrictSkip` 与 `mayRestrict` 可以写在 `pipeline.global`，也可以写在 adapter 的 `insert` 或 `override` 里。session 的 `insert` 只接受 `id`、`type`、`after`、`before`，带不了这几个字段；session 的 `override` 可以写。

```yaml
config:
  policy:
    deny: { words: [spam] }
  pipeline:
    global:
      - { id: guard, type: deny }
      - { id: shadow, type: deny }
  adapters:
    - kind: p2p
      channel: p2p:peer-a
      botName: self-bot
      transport: { listen: { host: 127.0.0.1, port: 7123 }, peers: { peer-b: PEER_B_REFERENCE } }
      pipeline:
        remove: [shadow]
        insert: [{ id: extra, type: deny, after: guard }]
```

`override` 按 id 替换节点字段，judge 节点用它改 `allowAtLeast`、`question` 与 `context`；judge 节点还需要先挂上一个 provider。上面的链条没有 `allow` 节点也没有 judge 阈值，因此会拒绝每一条消息，只用于演示层操作。

## 身份与印象库

`identity` 是顶层块，含 `people` 与 `bots` 两个列表。每个节点是 `{ id, accounts: [{ kind, instance, accountId }] }`；节点 id 与账号都只能出现一次，`accounts` 不能为空。内置 kind 的账号必须指向已挂载的实例，已配置的 p2p 对端也算；第三方 kind 只警告。解析到的账号会被写入 `author.personId`。

`impressions.dir` 是笔记根目录的绝对路径，不配它印象库就关闭。`impressions.import` 在挂载时为每个 bot 跑一次：`{ path, as: { personId } }` 或 `{ path, as: { groupKey } }`；`path` 必须是绝对路径，`personId` 必须是已声明的人、不能是 bot，`groupKey` 是已挂载通道上群会话的 `<channel>|<sessionKey>`。它只读 bullet 行，放不下的会警告但不挡挂载；再跑一次不会新增任何记录。

`turn.impressions.chars` 限制放在回合前的笔记量：默认 `400`，范围 `0`–`2000`，`0` 关闭注入。笔记只对 `c2c` 与 `group` 回合注入，`p2p` 从不注入，且在那里三个工具都返回 `unsupported`。`impression_put` 写本回合对端（该账号需有 `personId`），带 `about: "group"` 时写本群；`impression_get` 读该对端在 `c2c`、`group` 或 `cross` 中的一个分区，带 `about: "group"` 时读群存档；`impression_forget` 按 id 删，`all: true` 时删掉关于该对端的全部，带 `about: "group"` 时删本群。

## 各块写在哪一层

| 块 | 可写的位置 |
| --- | --- |
| `reply`、`turn`、`policy`、`delivery` | 顶层与每个 adapter，按每个键继承 |
| `pipeline` | 顶层写 `global` 节点、`maxTurnMs`、`judgeTimeoutMs`、`judgePoints`；adapter 写 `inherit`、`remove`、`insert`、`override` |
| `events` | 只在 adapter |
| `impressions`、`identity` | 只能顶层 |

## 许可证

MIT，见 [LICENSE](./LICENSE)。
