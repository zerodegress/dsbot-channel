# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

### Changed

- `/p2p/v1/status` answers an `AdapterStatus` instead of the old `{channel, bot, instance, snapshot}` report; the route had never been registered in a shipped build, so nothing read it. `ListenerHealth` now carries `lastFailure`, the way `ConnectionHealth` does.
- An adapter declares its transport in `adapters[].transport` instead of `adapters[].p2p`; the old key now fails to load with an error that names the new one.
- Prompt injections are bracketed blocks now: `[<kind>]` for the adapter's guidance and `[tool-mode]` for the mode notice, each on its own line with a blank line before the message. The guidance still rides a conversation once; the mode block repeats only on a switch into tool mode.
- `mentioned` on an event is now `{ self, others, all }` instead of one boolean, so an adapter says whether a message names the bot, someone else, or everyone. A profile may set `policy.requireMention` to refuse group messages that name neither the bot nor everyone; it is off by default. The old boolean no longer compiles against the new field.
- `decline` uses the transport's `refuse` capability and closes the conversation silently, reporting `declined: false`, when a channel has none.
- A media reference is `{ type, url, handle }`, at least one of `url` and `handle` present; `handle` is the adapter's opaque token, core carries it untouched, and both take part in the content hash.
- An adapter declares the capabilities it carries at mount time, beside the sampled ones in its status.
- A conversation's quota is counted under the key its adapter supplies (`p2p:<instance>` for a p2p link) rather than the host session id, so every turn of that conversation accumulates in one pool.
- An adapter declares its transport in a `p2p` block; `peers`, `listen`, `dedupe`, `inflightTtlMs`, `sentAtWindowMs`, `maxBodyBytes` and `waitMs` written on the adapter itself now fail to load.
- Core no longer exports `sessionKeyFor` or `ScopePair`, so an old import of either fails to compile. Only the adapter that saw a message knows its session key; `InboundGate.admit` takes that key as an argument instead of filling in `p2p:<peer>`.

### Removed

- `send_text` no longer takes a `scope` argument, and its result no longer returns one: the address in `target` already says where a message goes. A caller that still passes it gets `unsupported_argument` instead of silence.
- `softLimit` is gone: the ledger, `policy.budget` and a pipeline node's fields no longer accept it, and a quota has only a hard limit. Nothing read the soft threshold, so a profile that set one was configuring a limit that never fired.
- The p2p internals are no longer re-exported: signing, dedupe, mapping, the wire protocol, the listener, peer secrets, the send helper and the status route live under the adapter directory, and the package surface is the adapter contract plus the core.
- `registerBuiltinAdapter` is gone from the entry: only the composition root registers a built-in kind, and a third-party transport uses `registerAdapter`.
- `ChannelStats`, `ChannelSnapshot`, `ChannelFailure` and `ChannelState` are gone from the entry: the status shape is `AdapterStatus` with its `counters`, and the snapshot stays a transport-side container. `AdapterCounters` is exported in their place.
- The `event-layers` module and its exports (`transportLayer`, `derivedLayer`, `declareLayer`, `readDeclared`, `LayerViolationError`, `LAYERS`): no production code called it, and an event still carries its three layers as plain fields.
- `dedupeKeyFor`, `replyIdempotencyKey` and `unstableDedupeKey`: nothing in the package called them, and each transport already builds the key its own dedupe uses.
- `digestBody` and `defaultPipelineNodes`: nothing called the first, and the second described a template the builder cannot run, so keeping it only invited a `BuildError`.
- The `policy.score`, `policy.judge` and `policy.prepare` keys: the profile could write them, and loading then refused them. Unknown policy keys now fail through the same unknown-field check as any other typo.
- The connection half of the status helpers (`buildConnectionHealth`, `isFresh`, `mayInformQuota`, `statusNotification`, `ChannelRef`, `STALE_AFTER_MS`, `CONNECTION_STATES`): every transport in the package listens rather than dials, so no production path built or read one. Listener health and the status route stay.

### Fixed

- A hand off that throws before returning a promise is reported like any other failure instead of answering 500: the event stays claimed, so a peer that resends gets a duplicate rather than a second turn, and a deterministic fault can no longer put one message in a resend loop.
- A reply carries its own `reply:<uuid>` id and names the message it answers in `inReplyTo`; the chain root travels as a signed `chainId`, so an event id no longer grows with every hop and a closed chain stays closed.
- A peer on the previous protocol is refused with `401` and the distinct code `protocol_mismatch`, which the transport also counts with the time it last happened.
- A profile whose adapters answer for one bot with different pipelines or rules is refused at load time, instead of silently dropping every message on one adapter.
- Signature verification now covers `eventId`, `sentAt` and `body`, and signatures are base64-encoded as the wire protocol specifies.
- Stale in-flight reservations are reclaimed after their TTL, so a crashed delivery no longer blocks the same `eventId`.
