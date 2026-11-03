# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An impression library keeps short notes about the person a turn answers, or about its group: `impression_put`, `impression_get` and `impression_forget` act only on that counterpart, a note carries the messages that support it (at least one, at most 16), a repeated note gains evidence instead of a copy, confidence halves every 90 days and a record below 0.2 is no longer read, a note may cross platforms only as address, language, taboo or manner, and forgetting a record takes its evidence with it. Notes live under `impressions.dir`, one JSON file per subject, `0600` under `0700` and replaced by an atomic rename; without that field the library is off, a damaged file refuses the mount instead of being rebuilt, and the directory is created only on the first write.

### Changed

- OneBot can carry events and actions over a WebSocket as well as over HTTP: `transport.protocol` picks `http` (unchanged), `ws-forward` or `ws-reverse`, and one adapter speaks exactly one of them. A forward link dials and retries with jittered backoff, reporting `reconnecting` while it waits and staying `offline` only when retrying is off; when an `event.url` is named, both sockets must be open before it says `online`. A reverse link hosts one connection per adapter, refusing a wrong token or another account, replacing its own account's connection with a single warning. Both directions ping every 30 seconds and close a socket that leaves a ping unanswered for 10 seconds, so a half-open connection behind a NAT does not read as healthy; that is separate from `heartbeat`, which only says whether the implementation still sends events. `ws` is the package's first real runtime dependency — the harness does not provide it — so the production tree is no longer empty; it still never carries a `@deepseek-ai/*` package.
- A p2p media item may carry a file's name as a third element: `['file', url, name]`. An item without one signs and travels exactly as before, so an older peer sees the bytes it always saw; an item with one is refused whole by a peer from 0.2.0, so sending a named file needs both ends upgraded. A receiver that knows the shape stamps the name on the event, and only a file carries one. `capabilities.file.out` is on again for p2p, so `send_file` sends there as well.
- The package declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` as optional peers instead of dependencies: the bundle leaves both external, so a dependency entry only made every install fetch a second copy of the harness tree. The production tree now declares no harness package, publishing runs `pnpm audit --prod` before it packs, and `packageManager` pins the pnpm that wrote the lockfile.

## [0.2.0] - 2026-11-03

### Added

- An `identity` block declares who an account belongs to: `people[]` and `bots[]` name `(kind, instance, accountId)` accounts, and the gateway stamps `author.personId` after the adapters and before admission, overwriting whatever an adapter put there — a rejected message carries it too. A `p2p` or `onebot` binding that names an instance which cannot exist fails the mount; a third-party kind's namespace is unknowable and only warns. The graph is configuration, rebuilt at mount, and `personId` never enters `eventKey`, `contentHash` or `sessionKey`.
- `send_file` sends on OneBot now: `upload_group_file` or `upload_private_file` with the receiver's `name`, a url only when `transport.fileFromUrl: true` says the implementation takes one (most accept a path on their own host), and no download on our side. The receipt is `file_id`, then `message_id`, then a `local:` id when the platform gives neither. The built-in p2p link carries a url only, so `send_file` answers `unsupported_capability` there; a link travels in the text instead.
- `read_history` reads earlier messages where the transport can page them: OneBot answers from `get_group_msg_history` and `get_friend_msg_history` when `transport.history` opens that address kind, one page per call, with `next` carrying the cursor for the page before it, and a message that the list ended answering as an empty success rather than a failure.
- A turn can read the messages it did not answer: `turn.context.messages` keeps that many earlier messages per conversation and puts them in front of the turn as a `[context]` block, while `turn.context.chars` drops the oldest whole message once the text no longer fits. The buffer records every inbound group message after admission, including the ones a policy refused, and leaves out the messages the turn already carries; it is off by default (`messages: 0`) and never holds this bot's own replies.
- A bot's group message follows `policy.groupBots`: `whenMentioned` (the default) answers it only when it names this bot or everyone, `silent` never answers one, and `answer` treats it like a person. The check runs before `requireMention`, and a transport that cannot tell mentions apart falls back to `silent`.
- A turn can answer messages that arrive together: `turn.coalesceMs` opens a window, `maxBatch` and `maxChars` close it early, admission still runs per message, and the batch is charged and recorded once. `TurnRecord` reports `merged` and `mergedKeys`, and the default `coalesceMs: 0` keeps one message per turn.
- `send_image` really sends on OneBot: an http(s) url becomes an image segment in the same message as the caption, one API call per send, and a caption rides the text field instead of a second one. A transport that cannot send images still answers `unsupported_capability`, and a handle is only usable by the instance that issued it.
- A `prepare` node runs now: an adapter may supply a synchronous `prepare` hook that sees the event and the session key, and it runs before every turn that reaches the node, as a side effect only — it cannot answer, is never charged, and never touches the guidance ledger, which stays once per conversation. A profile that declares the node fails to load unless every adapter answering for that bot carries the hook, and a session layer is refused the moment it introduces the node on a bot without one, rather than failing on every turn; a hook that throws is reported and the turn continues.
- `send_image`, `send_file` and `read_history` sit beside `send_text`: each names a channel and an address, checks that transport's static capability set when it is called, and answers `unsupported_capability` naming the bit and the channel when the transport cannot carry it. A transport that carries neither answers that way; a local path is refused as an argument rather than sent.
- A limit state names each level by the dimension it belongs to: `byDimension` reports `global`, `bot` and `conversation` beside the key map, so a reader no longer parses a session key to learn which dimension tripped.
- `turn-stats` separates a quiet end from a refusal: `suppressed` stays the sum, with `ended` and `refused` beside it, and the tools report which one they took.

### Changed

- `capabilities.history` answers `{ group, private }` instead of one boolean, and `SendFailureCode` gains `unsupported` for a request the transport cannot carry at all: neither OneBot history API belongs to OneBot 11, so a link declares each address kind it really serves rather than guessing, and an implementation without the action says so instead of showing an empty page.
- A p2p message may now carry an empty `body` when it also carries media: a media-only message has no words to send, and the receiver used to refuse it with `400 body must be a non-empty string`. A request with neither text nor media is still refused.
- A context owns its adapter registry: `dsbot-channel/registry` provides it, an adapter plugin injects it, and the gateway reads it, so two copies of the package no longer each keep a module-level map that the other cannot see. The profile mounts `dsbot-channel/registry`, then the adapters, then `dsbot-channel`; a missing registry now fails the mount and names the plugin to add, and an adapter mounted after the gateway fails with the kinds the gateway could see.
- `CapabilitySet` answers media in four parts — `{ in, out, fromUrl, fromHandle }` for `image`, `file` and `voice` — instead of one boolean, and a media tool asks both whether the transport can send the type and whether it can do so from the source it was given. OneBot declares images and files in every direction and voice inbound only; p2p declares no media. The owner stays out of the content hash, so the same media seen from two instances is still the same content.
- `LimitState.byScope` is now `byKey`: the field maps ledger keys (`global`, `bot:<id>`, and the adapter's session key) to levels, while `reply.byScope` maps a scope (`c2c`/`group`/`p2p`) to a reply mode. A caller that read the old name no longer compiles.
- `decline` takes a `reason` from the closed set a channel can tell the sender, plus an optional `note`, counts toward the reply ceiling like a reply does, and is charged at the rejected rate instead of being refunded.

### Removed

- `DeclaredMeta.claimedIdentity` is gone. It was a leftover slot that every adapter filled with `null` and nothing ever read; with identity now declared in the profile, a per-event field that looks like a claim would only invite an adapter to think it can name its sender. It never took part in any decision.
- `registerAdapter`, `adapterFactory` and `knownAdapterKinds` are gone from the entry. A third-party transport ships as a plugin built with `defineAdapterPlugin({ kind, create })`, which registers with the context's registry when it mounts; the old module-level call would register into one copy's map and leave the gateway's copy empty.
- `judge` and `push` are gone from `CHARGE_KINDS` and from the point table: nothing charged either kind, the `judge` node cannot be bound in this version, and the push tool never touched the ledger. `points` holds `accepted` and `rejected` only, a turn is always charged as a bot call, and `TurnBilling` no longer takes a `chargeKind`.

### Fixed

- A `policy.budget.hardLimit` outside `(0, 1]` is refused at mount time: `0` made every turn hard the moment it started, while a value above `1` could never trip. A decimal limit also trips on the point it names, not one past it.
- A refusal now reaches the peer it refuses: `decline` posted an empty body, which the receiving parser rejects, so every refusal came back `400` and the sender never learned it was declined. The chosen reason travels as `reason`, and the note (or `declined` when there is none) travels as `body`.
- The reply ceiling counts per conversation on every transport now: `admit` and `recordReply` used two spellings of the peer, so on OneBot the count never matched and `relayLimit` never fired, while a person speaking never cleared it. Both go through one key, and a person's message resets it.

## [0.1.0] - 2026-11-02

### Added

- `meta.adapter` carries the transport's own raw payload, untouched: core never parses it, it takes no part in the event key or the content hash, and a reader may look at it. OneBot stores `raw_message` there, p2p stores the envelope fields the wire carried; a payload over 8 KB is left out with a warning rather than truncated.
- Two read-only surfaces for a host: `dsbot-channel.usage` reports each bot's limits and what every conversation spent, and `dsbot-channel.turns` reports the recent turns with their window, outcome and duration in a bounded ring buffer. Neither is read on a decision path, and no record carries a message body.
- A read-only status route on every listening transport: `/p2p/v1/status` and `/onebot/status` both answer an `AdapterStatus` to a loopback caller, and `AdapterStatus` gains required `counters` (auth failures, unknown paths, underruns, protocol mismatches, send failures by code, last failure).
- An OneBot 11 transport over reverse HTTP: the implementation pushes events to a loopback listener, replies call its HTTP API, an optional access token guards both directions, and mention is reported as `self`/`others`/`all` from the message array. Media is carried in but never sent in this version.
- A `reply` block chooses how a turn answers: `default` and `byScope` (`c2c`/`group`/`p2p`), plus ordered `rules` whose `when` matches source, author, transport and body, combined with AND, `not` and `any`. The first match wins. In `tool` mode a plain text answer is discarded with a warning and counted as `dropped`; a profile that can choose `tool` fails to load when the host has no tools service.
- Adapter kinds: `p2p` and `onebot` are built in, a third-party transport registers as `x-[a-z0-9-]+` within 32 characters and mounts through one adapter contract. A message's `source.kind` must match the adapter that carried it, and an unknown kind or a mismatch is refused before a session or a charge exists.
- An event of four parts — source, author, body and metadata — with three metadata layers, one of them unreadable by consumers, and separate `eventKey` and `contentHash` fields.
- Profile validation at load: unknown fields, wildcard listen addresses, an adapter without its own `instance`, a `channel` another adapter already uses, or one bot answered by adapters with different pipelines are refused with the offending field path.
- The p2p transport: wire protocol v1 at `POST /p2p/v1/message` with signed requests, per-peer secrets bound to an instance, `(instance, to, eventId)` deduplication with in-flight recovery, `413` for oversized bodies and `403` for misaddressed messages, on a listener that binds `127.0.0.1` by default and is checked before any socket opens.
- Adapters listed in the profile, each with its own peers and listener settings. Peer secrets are credential references, not inline values, and an empty list mounts the plugin without opening a listener.
- Per-adapter `policy`: deny by word or regular expression, allow named peers, cap the rounds one peer holds with `relayLimit` and `relayResetMs`, and `policy.budget` with a required `capacity` and an optional `hardLimit`.
- A `pipeline` in the profile, global and per bot, sets the nodes a turn runs — deny, allow, restrict scoring and judging, score, or pass — with `maxTurnMs` and `judgeTimeoutMs` bounding how long a turn may take and how long a judge may take inside it. A host may add one more layer for a session at run time.
- A p2p channel that runs end to end: an accepted message starts a turn with the host session controller, and the reply is sent back to the peer that sent it.
- `mentioned` on an event reports `self`, `others` and `all` separately, so an adapter says whether a message names the bot, someone else, or everyone; `policy.requireMention: true` refuses group messages that name neither the bot nor everyone, and is off by default.
- A media reference is `{ type, url }` with a non-empty `url`, and both fields take part in the content hash. An adapter that can only name a media item by a token of its own drops it and warns: core never sees a platform token.
- `decline` closes the conversation with a refusal the adapter sends (`RefuseInput`), and reports `declined: false` when a transport cannot send one.
- `send_text` addresses a message by `target` alone; a caller that still passes `scope` gets `unsupported_argument` rather than silence.
- Guidance and the tool-mode notice ride as bracketed blocks on their own lines: `[<kind>]` for the adapter's guidance, `[tool-mode]` for the mode notice. Guidance rides a conversation once; the mode block repeats only on a switch into tool mode.
- An adapter declares the capabilities it carries at mount time, beside the sampled ones in its status.

### Fixed

- A hand off that throws before returning a promise is reported like any other failure instead of answering 500: the event stays claimed, so a peer that resends gets a duplicate rather than a second turn, and a deterministic fault can no longer put one message in a resend loop.
- A reply carries its own `reply:<uuid>` id and names the message it answers in `inReplyTo`; the chain root travels as a signed `chainId`, so an event id no longer grows with every hop and a closed chain stays closed.
- A peer on the previous protocol is refused with `401` and the distinct code `protocol_mismatch`, which the transport also counts with the time it last happened.
- A profile whose adapters answer for one bot with different pipelines or rules is refused at load time, instead of silently dropping every message on one adapter.
- A signed request covers the whole envelope, not only the body: `eventId`, `chainId`, `to`, `sender`, `instance`, `body` and `sentAt` always, plus `status`, `reason`, `final`, `inReplyTo` and `inReplyToExcerpt` when present. Signatures are base64-encoded as the wire protocol specifies.
- Stale in-flight reservations are reclaimed after their TTL, so a crashed delivery no longer blocks the same `eventId`.
