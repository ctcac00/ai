---
name: refactor-docs
description: >
  Refactor existing documentation into the modern layout. Use when
  asked to migrate CLAUDE.md, agents.md, or legacy specs; clean up documentation
  drift; or reorganise content into an OKF bundle (domain + decisions),
  skills/ (behaviour).
---

# refactor-docs

## Purpose

Migrate legacy documentation into the modern split:

| Content type | Destination |
|---|---|
| Domain vocabulary, entity definitions, screen names, invariants | `.okf/domain/<concept>.md` (one concept per file) |
| Agent behaviour, coding guidelines, response style | `skills/` |
| Architectural decisions and their rationale | `.okf/decisions/<NNNN>-<slug>.md` |
| Tooling, commands, env setup | `README.md` or project-local runbook |

See the `okf` skill for the bundle conventions (frontmatter, one-concept-per-file, index.md/log.md).

## Procedure

1. **Read** the provided document(s) in full.
2. **Categorise** every paragraph into one of the four content types above.
3. **Check for duplication** — if a concept or decision already exists in `.okf/`, merge into that file; don't append a duplicate.
4. **Draft output files** for each destination — one OKF concept file per domain term, one OKF decision file per ADR.
5. **Update `index.md`** for each touched `.okf/` directory, and append a dated entry to the nearest `log.md`.
6. **Produce a deletion diff** showing what to remove from the source.
7. **Never invent content** — only reorganise what is already written.
8. **Validate** the bundle (`/okf:validate .okf --strict` or the fallback script in the `okf` skill) before finishing.

## Domain concept and decision format

Use the formats in [domain-modeling/CONTEXT-FORMAT.md](../domain-modeling/CONTEXT-FORMAT.md) (domain concepts) and [domain-modeling/ADR-FORMAT.md](../domain-modeling/ADR-FORMAT.md) (decisions) — don't duplicate them here.

## Notes

- CLAUDE.md should be deleted entirely once its content is distributed.
- A domain concept file is a glossary + invariants entry, NOT an architecture guide or how-to.
- Skills must be project-local (`.agents/skills/`) and symlinked into `.claude/skills/`.
- `docs/agents/` files are skill references — keep them; do not merge into `.okf/`.
