# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Event model with four parts (source, author, body, metadata), three metadata layers, and separate `eventKey` and `contentHash` fields; the declared layer cannot be read by consumers.
- Configuration validation that rejects unknown fields and wildcard listen addresses, reporting the offending field path.
- p2p wire protocol v1 at `POST /p2p/v1/message`: per-peer secrets bound to an instance, signed requests via `x-p2p-signature`, `(instance, to, eventId)` deduplication with in-flight recovery, `413` for oversized bodies and `403` for misaddressed messages.
- Self-hosted p2p listener on `127.0.0.1` by default, with its configuration checked before any socket is opened.
- Pipeline node chain that can deny, allow, restrict scoring and judging, score, or pass an event.
- Budget ledger over global, per-bot and per-session scopes, with two ways to charge: a synchronous check-and-charge decision, and a hold that is reserved up front and then settled or refunded.
- Adapters are declared as a list: each mounted adapter opens its own peer listener, hands accepted messages to the host session controller, and sends the reply back to the peer that sent it.

### Changed

- Every adapter requires its own `instance` and a `channel` no other adapter uses, and peer secrets are credential references resolved through the host rather than inline values. An empty adapter list mounts the plugin without opening a listener.

### Fixed

- Signature verification now covers `eventId`, `sentAt` and `body`, and signatures are base64-encoded as the wire protocol specifies.
- Stale in-flight reservations are reclaimed after their TTL, so a crashed delivery no longer blocks the same `eventId`.
