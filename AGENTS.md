# AGENTS.md

A message gateway for ds-bot: events from several external platforms reach one bot, and answers go back to the conversation they came from. Read `README.md` first; it is the only document a user of this package gets. This file is for agents that change the repository.

This file is the one exception to the rule that the repository holds no documents beyond `README.md`, `README_ZH.md` and `CHANGELOG.md`: it is agent instructions, not user documentation.

## Layout

```
src/                the gateway: contract, pipeline, admission, sessions, tools, adapters
test/               unit and end-to-end tests
CHANGELOG.md        changelog, English only
README.md           the only user-facing document
README_ZH.md        the same document in Chinese
```

Anything a person needs in order to use or change the package lives here. Everything else stays out of the repository.

## Commands

```sh
pnpm install --frozen-lockfile   # before any claim that tests pass
pnpm test                        # unit and end-to-end
pnpm typecheck
pnpm lint
pnpm build
pnpm audit:prod                  # production dependency tree, before publishing
```

All four gates (test, typecheck, lint, build) must be green before delivery. Rerun them after a change; do not cite an earlier run.

## Commits

- One commit per completed step; one commit does one thing.
- English conventional commits; an imperative subject, lowercase, no trailing period.
- Never force-push pushed history; never rewrite someone else's branch.
- Read the full change list before committing. Exclude keys, absolute paths, internal addresses, build output, logs and scratch files.

## Branches and pull requests

- Branch from the latest `main`, and put the issue number in the branch name.
- Open a pull request with the `WIP:` prefix before writing code; one branch carries one pull request.
- Promote it (drop `WIP:`) only when all of these hold: the desensitization scan passed, `mergeable: true`, the branch contains the latest `main`, and no review or comment asks for changes.
- A pull request body is English, code blocks included, and ends with `Closes #N`.
- Issue and pull request titles are English. Issue bodies may be Chinese.
- Tags and releases are created by the repository owner, never by an agent.

## Documents

- Only `README.md`, `README_ZH.md`, `CHANGELOG.md` and this file live in the repository.
- Documentation is written for the people who use or change the package. It states what is true and how to use it, keeps implementation detail to what a reader needs, and does not narrate how or why a decision was made. Reasoning that is still being worked out does not belong in a document at all.
- The README states what the package is and how to configure it. It does not explain design decisions, does not say what is missing, and does not review history.
- `README.md` and `README_ZH.md` change together, in the same commit.
- Configuration facts have one home: the skill body shipped in the package. Change a configuration field, and the skill body and the README section change in the same batch; when they disagree, the skill body wins.
- `CHANGELOG.md` is English, follows keepachangelog, and describes behaviour for a user. Sections are `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`. It records no internal refactors and no implementation detail.
- One fact lives in one place. When a second place needs it, link to it or read from the same source; do not copy it.

## Code

- ESM throughout. Import across packages by name; local relative imports carry `.ts`.
- No comments by default. Documentation comments state the contract in at most two lines. Put the reasoning in the commit message.
- Configuration is validated at load time and fails there. An error names the field and the action that fixes it.
- `@deepseek-ai/*` appears in `peerDependencies` or `devDependencies`, never in the production tree.

## Tests

- Write the test before the delivery. A test describes behaviour, not correctness.
- Behaviour changes together with its test, and the pull request says why.
- Fixtures use loopback and documentation addresses only: `127.0.0.1`, `203.0.113.9`, `example.test`.
- Do not rerun a check that already passed. Exhaustive runs belong to CI or to whoever asks for one.
- When you report results, give the command and its real output. If you could not get a result, write that you did not.

## Desensitization

Nothing entering the repository may contain real names or contact details, private email addresses, private domains, cloud accounts, tokens or keys, internal addresses, absolute paths that carry a user name, or host names. Use `{{EMAIL}}`, `{{DOMAIN}}`, `{{TOKEN}}` and `{{USER}}` as placeholders.

Public account names and public work addresses may appear, after checking each one.

## Versions and release

- Versions follow semver; a breaking change under 0.x bumps the minor version.
- A release commit changes three things at once: renames the top of `CHANGELOG.md` and adds an empty `[Unreleased]`, bumps `package.json`, and updates the badges and the tested-against claim written in both READMEs.
- While releasing, read `[Unreleased]` once more and cut anything that is not a fact.

## Working in a team

The work is divided into functions:

- direction and design; opening every pull request and handing out work;
- implementation;
- the adapter contract and its acceptance points; verifying a head before it ships;
- behaviour review of what runs inside the gateway;
- the desensitization scan on every increment;
- documented facts;
- hosts, containers, deployment and link verification;
- primary sources, with citations.

**Relay.** Every step ends by naming the next owner. A step that ends without a name stops the work; only the coordinator may end a chain deliberately. Work that one role asks another to do is answered by the one that asked.

**Handoff format.** An implementer reports the branch, the commit and the tree hash, then stops. Nothing else is expected of it until the next request.

**Order per change.** Implement and report a head. Verify against the acceptance points; a verification breaks one assertion on purpose to show the test can fail. Scan the increment for anything private. Update the pull request body, run the repository check, promote the pull request, and the owner merges.

**Decisions the owner keeps.** Priorities, releases and anything else a human owns stay with the repository owner; a change that needs such a decision is written down as an open question, not guessed.

## Editing this file

Keep each rule self-contained and link out for background. Delete a rule when it no longer constrains anything; do not grow the file for completeness. A new rule belongs in the section it actually governs.
