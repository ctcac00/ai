# Domain Concept Format

Domain glossary terms are OKF concepts under `.okf/domain/` — one term per file, per the [OKF spec](../okf/reference/SPEC.md).

## Structure

```md
---
type: Data Entity
title: <Term>
description: <One-sentence definition.>
tags: [domain, ...]
timestamp: <ISO 8601 date>
---

# Overview

<A one or two sentence description of the term. Define what it IS, not what it does.>

_Avoid_: <other words for the same concept that the project has chosen not to use>

# Related concepts

- [<Related term>](/domain/<related-term>.md)
```

Pick `type: Data Entity` for things (nouns with a schema/shape), or a more specific type (`Process`, `Screen`, `Policy`, etc.) when "Data Entity" doesn't fit — see the spec's guidance that `type` values are producer-chosen, not centrally registered.

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max in the Overview.
- **Only include terms specific to this project's domain.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this domain, or a general programming concept? Only the former belongs.
- **One concept per file.** Don't merge multiple terms into one document — that's what `.okf/domain/index.md` and cross-links are for.
- **Cross-link liberally.** Use bundle-relative links (`/domain/other-term.md`) to related concepts, schedules, decisions, etc.

## Single vs multi-context repos

**Single context (most repos):** One `.okf/` bundle at the repo root, terms under `.okf/domain/`.

**Multiple contexts:** A separate `.okf/` bundle per context (e.g. `src/ordering/.okf/`, `src/billing/.okf/`), each with its own `domain/` directory. There is no OKF-native "map of bundles" file — if one is useful, add a plain `index.md` at the repo root linking to each context's bundle.

The skill infers which structure applies:

- If multiple `.okf/` directories exist under `src/*`, multi-context.
- If only a root `.okf/` exists, single context.
- If neither exists, create a root `.okf/domain/` lazily when the first term is resolved.

When multiple contexts exist, infer which one the current topic relates to. If unclear, ask.

## Keep the index and log current

After writing or editing a concept, update `.okf/domain/index.md` (add/adjust the entry, using the concept's `description`) and append a dated entry to the nearest `log.md`.
