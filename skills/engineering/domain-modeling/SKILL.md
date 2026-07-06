---
name: domain-modeling
description: Build and sharpen a project's domain model. Use when the user wants to pin down domain terminology or a ubiquitous language, record an architectural decision, or when another skill needs to maintain the domain model.
---

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* the domain bundle for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## Where the model lives

The domain model is an [OKF](../okf/SKILL.md) knowledge bundle at `.okf/` (repo root, unless the project already uses another location):

```
.okf/
├── index.md
├── domain/
│   ├── index.md
│   └── <concept>.md          ← one glossary term per file
└── decisions/
    ├── index.md
    └── <NNNN>-<slug>.md       ← one ADR per file, sequentially numbered
```

Multi-context repos (a monorepo with genuinely separate domains) may keep a bundle per context instead of one at the root — check for existing `.okf/` directories under `src/*` before assuming single-context. If none exists, default to a single bundle at the repo root.

Create files lazily — only when you have something to write. If no `.okf/domain/` directory exists, create it (with an `index.md`) when the first term is resolved. Same for `.okf/decisions/`.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in `.okf/domain/`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Write the concept inline

When a term is resolved, write or update its concept file in `.okf/domain/` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

A domain concept file should be totally devoid of implementation details. Do not treat it as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary entry and nothing else.

Update the directory's `index.md` and append a dated entry to the bundle's `log.md` in the same pass — don't leave the bundle's index stale. Use the bundle resolved in [Where the model lives](#where-the-model-lives) above, not necessarily the repo-root `.okf/`.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

## Validate before finishing

Run the [`validate`](../validate/SKILL.md) skill (`/validate <bundle-dir> --strict`) after writing or editing concepts. Resolve every `ERROR`; warnings are soft.
