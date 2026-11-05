# dsbot-channel

[English](./README.md) | 中文

[![](https://img.shields.io/npm/v/dsbot-channel)](https://www.npmjs.com/package/dsbot-channel) [![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.4-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh) [![DS-Bot](https://img.shields.io/badge/DS--Bot-0.2.x-4D6BFE)](https://github.com/Fei2411/DS-Bot) [![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness) [![](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

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
| `kind` | `p2p` | `p2p`、`onebot`，第三方传输用 `x-[a-z0-9-]+` |
| `channel` | required | 链路唯一名字，对端在线上也看到它 |
| `botName` | required | 这条链路服务的 Bot |
| `transport` | required | 按 kind 的配置块，见「对端」与「OneBot」 |
| `session` | off | 所有回合都跑在同一个已有会话里 |
| `cwd` | off | 它创建的会话所在目录 |
| `agentPreset` | off | 它创建的会话所用 preset |
| `model` | off | 这些会话的模型，写作 `provider/model` |
| `status` | `true` | 注册只读状态路由 |
| `skill` | `true` | 宿主有 skills 服务时注册包内技能 |

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
| `events.turn` | `[]` | 允许开回合的非消息事件类 |

一个 adapter 只用一种协议；属于另一种协议的字段在加载期被拒。一个实现只对应一个 adapter，不是两个。`events.turn` 填 `notice.group_recall`、`request.friend` 这类类名；其余非消息事件只被记录与计数、不开回合，`meta_event` 与自己的回声永不开回合，写了 OneBot 不发的事件类会在加载期报错，被点名的类跳过提及要求。

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
      - { id: score, type: judge, allowAtLeast: 0.6 }
```

`judge` 节点需要宿主服务 `dsbot-channel/judge`，它以 `{ score, reason? }` 回应 `judge(event, context)`。声明了节点但没有该服务，挂载失败；判定超时或抛错分别以 `judge_timeout`、`judge_failed` 拒绝该消息，分数不是 0–1 的有限数同样判失败。`allowAtLeast` 也可以在 bot 或 session 层 insert/override。`judgeTimeoutMs` 不得超过 `maxTurnMs`。

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
    question:
      type: noul
      instructions: Is this message worth answering?
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
| `maxChars` | `2000`（`system-one`）、`6000`（`llm`） | 正文截断上限 |
| `question` | required | 要问的类型化问题，`system-one` 用 |
| `question.type` | required | `noul`、`score` 或 `choice` |
| `question.instructions` | required | 一句问题或陈述 |
| `question.criteria` | `noul`：`{ true, false }`；`score`：2 到 10 档有序 | |
| `question.options` | required | 选项，`choice` 用 |
| `question.target` | required | `choice` 用：取哪一项的概率作为分数 |
| `question.min` / `.max` | off | 仅 `score`：换算原始分；两者相等判失败 |

两个入口都只发送正文、作用域、作者 id 与是否被点名——不带历史、不带工具——并在 `pipeline.judgeTimeoutMs` 内对 `429` / `529` 重试一次。`llm` 只接受裸 JSON。同一个 profile 挂第二个 provider 会在加载期失败。

## 一条消息怎么被判定

入站消息走三步：adapter 先去重，policy 关卡决定它能不能成为回合，pipeline 再决定这个回合放不放行。被拒绝的回合会以 `outcome: rejected` 加 gate 的 code 记进 turns 快照，具体原因写日志。

| policy 键 | 默认 | 决定什么 |
| --- | --- | --- |
| `policy.requireMention` | `false` | 群消息必须点名机器人或 @全体；分辨不了提及的传输（`p2p`）在挂载期直接拒绝这个配置 |
| `policy.groupBots` | `whenMentioned` | 另一个机器人的群消息怎么处理：`whenMentioned`、`silent` 或 `answer` |
| `policy.relayLimit` / `policy.relayResetMs` | `3` / `300000` | 一个对端最多连续占几轮，以及重置这个计数的空闲时间 |
| `policy.deny.words` / `policy.deny.regexes` | `[]` | 拒绝消息的子串与正则，匹配不区分大小写 |
| `policy.allow.peers` | `[]` | `allow` 节点匹配的 `source.peer`；命中即放行并结束链条 |
| `policy.budget.capacity` / `policy.budget.hardLimit` | 写了 `budget` 就必填 / `1` | 每个窗口的点数，以及网关据此拒绝的比例，按硬窗口执行 |

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
| `judge` | 通过宿主 judge 服务打分；阈值是 `allowAtLeast`。 |
| `prepare` | 执行宿主提供的 prepare 钩子，然后通过。为该 bot 服务的每个 adapter 都必须带这个钩子，否则挂载失败。 |

| 字段 | 含义 |
| --- | --- |
| `id` | `matched` 与 `reasons` 用它指代该节点。 |
| `type` | 上面四种之一。 |
| `allowAtLeast` | 仅 `judge`：0 到 1 的分数。 |

`score` 与 `budget` 在 schema 里有声明，但这一版绑不上：score 节点需要的评分函数没有提供，budget 节点需要的会话级判定管道带不了。声明它们会在挂载期失败并给出原因；真正的花费限制由网关自己的硬窗口执行，且只有写了 `policy.budget` 的 profile 才有这个窗口。

adapter 用四个键调整它继承到的链条：`inherit` 指定从哪一层开始（adapter 层只能是 `global`），`remove` 按 id 删节点，`insert` 把节点插到某个 id 之前或之后，`override` 按 id 替换节点字段。`insert` 的 `after` 与 `before` 只能写一个、不能复用已有的 id；`override` 只写该节点类型拥有的字段；`remove` 或 `override` 指向不存在的 id 会让挂载失败。

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

`override` 按 id 替换节点字段，judge 节点用它改 `allowAtLeast`；judge 节点还需要先挂上一个 provider。上面的链条没有 `allow` 节点也没有 judge 阈值，因此会拒绝每一条消息，只用于演示层操作。

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
