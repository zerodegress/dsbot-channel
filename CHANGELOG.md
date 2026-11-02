# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-02

### Added

- `turn-stats` separates a quiet end from a refusal: `suppressed` stays the sum, with `ended` and `refused` beside it, and the tools report which one they took.
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
- `decline` closes the conversation with a refusal the adapter sends (`RefuseInput`), and reports `declined: false` when a transport cannot send one. It takes a `reason` from the closed set a channel can tell the sender, plus an optional `note`, counts toward the reply ceiling like a reply does, and is charged at the rejected rate instead of being refunded.
- `send_text` addresses a message by `target` alone; a caller that still passes `scope` gets `unsupported_argument` rather than silence.
- Guidance and the tool-mode notice ride as bracketed blocks on their own lines: `[<kind>]` for the adapter's guidance, `[tool-mode]` for the mode notice. Guidance rides a conversation once; the mode block repeats only on a switch into tool mode.
- An adapter declares the capabilities it carries at mount time, beside the sampled ones in its status.

### Fixed

- A refusal now reaches the peer it refuses: `decline` posted an empty body, which the receiving parser rejects, so every refusal came back `400` and the sender never learned it was declined. The chosen reason travels as `reason`, and the note (or `declined` when there is none) travels as `body`.
- The reply ceiling counts per conversation on every transport now: `admit` and `recordReply` used two spellings of the peer, so on OneBot the count never matched and `relayLimit` never fired, while a person speaking never cleared it. Both go through one key, and a person's message resets it.
- A hand off that throws before returning a promise is reported like any other failure instead of answering 500: the event stays claimed, so a peer that resends gets a duplicate rather than a second turn, and a deterministic fault can no longer put one message in a resend loop.
- A reply carries its own `reply:<uuid>` id and names the message it answers in `inReplyTo`; the chain root travels as a signed `chainId`, so an event id no longer grows with every hop and a closed chain stays closed.
- A peer on the previous protocol is refused with `401` and the distinct code `protocol_mismatch`, which the transport also counts with the time it last happened.
- A profile whose adapters answer for one bot with different pipelines or rules is refused at load time, instead of silently dropping every message on one adapter.
- A signed request covers the whole envelope, not only the body: `eventId`, `chainId`, `to`, `sender`, `instance`, `body` and `sentAt` always, plus `status`, `reason`, `final`, `inReplyTo` and `inReplyToExcerpt` when present. Signatures are base64-encoded as the wire protocol specifies.
- Stale in-flight reservations are reclaimed after their TTL, so a crashed delivery no longer blocks the same `eventId`.
