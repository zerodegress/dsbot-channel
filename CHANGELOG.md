# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Adapter kinds: `p2p` and `onebot` are built-in names, a third-party transport registers as `x-[a-z0-9-]+` within 32 characters, and a profile naming an unknown kind fails at load.
- A kind names one implementation: a factory registers once per kind, while several adapters may reuse it. A message's `source.kind` must match the kind of the adapter that carried it; a mismatch is refused with `source_kind_invalid` before a session or a charge exists.
- Event model with four parts (source, author, body, metadata), three metadata layers, and separate `eventKey` and `contentHash` fields; the declared layer cannot be read by consumers.
- Configuration validation that rejects unknown fields and wildcard listen addresses, reporting the offending field path.
- p2p wire protocol v1 at `POST /p2p/v1/message`: per-peer secrets bound to an instance, signed requests via `x-p2p-signature`, `(instance, to, eventId)` deduplication with in-flight recovery, `413` for oversized bodies and `403` for misaddressed messages.
- Self-hosted p2p listener on `127.0.0.1` by default, with its configuration checked before any socket is opened.
- Pipeline node chain that can deny, allow, restrict scoring and judging, score, or pass an event.
- Budget ledger over global, per-bot and per-session scopes, with two ways to charge: a synchronous check-and-charge decision, and a hold that is reserved up front and then settled or refunded.
- A p2p channel that runs end to end: an accepted message starts a turn with the host session controller, and the reply is sent back to the peer that sent it.
- Adapters are declared as a list, each with its own listener settings and its own peer list.
- Per-adapter `policy` rules that deny a message by word or regular expression, allow named peers through, and cap how many rounds one peer may hold, tuned with `relayLimit` and `relayResetMs`.
- Per-adapter `policy.budget` with a required `capacity` in points and an optional `hardLimit` ratio; once the window reaches the hard limit the next turn is refused.
- `pipeline.maxTurnMs` and `pipeline.judgeTimeoutMs`, so a profile sets the ceiling one turn may occupy and the judging deadline inside it.

### Changed

- A conversation's quota is counted under the key its adapter supplies (`p2p:<instance>` for a p2p link), not under the host session id; several host sessions of one peer share one pool, which is what "a quota for that peer" means.

- An adapter declares its transport in a `p2p` block; `peers`, `listen`, `dedupe`, `inflightTtlMs`, `sentAtWindowMs`, `maxBodyBytes` and `waitMs` written on the adapter itself now fail to load.
- A transport mounts through one adapter contract, so the core no longer imports a transport and reports `AdapterStatus` only.
- Every adapter requires its own `instance` and a `channel` no other adapter uses, and peer secrets are credential references resolved through the host rather than inline values. An empty adapter list mounts the plugin without opening a listener.

### Fixed

- A reply carries its own `reply:<uuid>` id and names the message it answers in `inReplyTo`; the chain root travels as a signed `chainId`, so an event id no longer grows with every hop and a closed chain stays closed.
- A peer on the previous protocol is refused with `401` and the distinct code `protocol_mismatch`, which the transport also counts with the time it last happened.
- A session layer declared at run time now decides what that session's next turn runs; before, it was stored, readable, and never consulted.
- A profile whose adapters answer for one bot with different pipelines or rules is refused at load time, instead of silently dropping every message on one adapter.
- Signature verification now covers `eventId`, `sentAt` and `body`, and signatures are base64-encoded as the wire protocol specifies.
- Stale in-flight reservations are reclaimed after their TTL, so a crashed delivery no longer blocks the same `eventId`.
