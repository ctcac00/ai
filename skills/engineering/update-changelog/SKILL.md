---
name: update-changelog
description: Refreshes CHANGELOG.md's [Unreleased] section from merged PRs/commits since the last version entry, keeping only user-facing changes. Use when asked to update the changelog, refresh CHANGELOG, or summarize what changed since the last release.
---

# Update Changelog

Refresh `CHANGELOG.md`'s `[Unreleased]` section from work merged since the last
version section. Deliberate, on-demand — run when cutting a release or wanting
a snapshot. Do not run this automatically per-commit: this repo's commit
styles are too mixed (`feat(android): …`, `Refactor app source …`, `Add
loop-claude.sh`) for a reliable per-commit classifier.

## Quick start

```
/update-changelog
```

## Workflow

### 1. Find the cut point

Parse `CHANGELOG.md` for the most recent `## [<version>] - <date>` heading
(the first one *after* `[Unreleased]`). Use that release as an exclusive cut
point: changes merged on the release date are already part of that release and
must not be copied back into `[Unreleased]`. If no version section exists, fall
back to the file's first commit date.

### 2. Gather candidate changes since the cut point

Prefer merged PR bodies over raw commit subjects — PR bodies in this repo
carry `Closes #N` and a `## Summary` (mandated by the `fix-open-issue` skill),
which classify far more reliably than commit subjects alone.

```bash
gh pr list --state merged --search "merged:><cut-date>" \
  --json number,title,body,mergedAt,url --limit 100
```

Fall back to commit subjects only for merges with no corresponding PR:

```bash
git log origin/main --after="<cut-date> 23:59:59" --format='%H %s'
```

### 3. Classify: user-facing vs internal

Keep only changes a user of the app or website would notice:

- New features (`feat`), bug fixes (`fix`), branding/asset changes, anything
  visibly different in the app, website, or store listing.

Drop everything else:

- Refactors, tests, chores, skills/tooling changes, dependency bumps with no
  user-visible effect, CI config, documentation about the codebase itself.

When unsure whether a change is user-facing, err toward dropping it — the
changelog is for users, not contributors.

### 4. Map to Keep-a-Changelog categories

- New functionality → `Added`
- Behavior or asset changes → `Changed`
- Bug fixes → `Fixed`
- Removals → `Removed`

Only include the categories that have at least one entry.

### 5. Merge into `[Unreleased]`, idempotently

Before adding an entry, check whether its issue/PR number already appears
anywhere in `[Unreleased]`. If it does, skip it — never add a duplicate.

Match the existing entry format: a bold theme lead-in when several changes
share a theme, ending with the issue link(s):

```
- **Branding.** Replace placeholder splash/icon assets with terracotta brand
  ([#261](https://github.com/ctcac00/plant-care/issues/261)).
```

Use `https://github.com/ctcac00/plant-care/issues/N` for the link regardless
of whether `N` is technically a PR — this repo's existing entries always link
the issue.

If no user-facing changes were found, leave (or restore) the placeholder line
`_No unreleased changes yet._` and no category headings under
`[Unreleased]`.

### 6. Preserve structure

Do not touch the header note about inferred version numbers, or any section
below `[Unreleased]`. Only `[Unreleased]`'s contents change.

## Verification

This is a markdown process skill with no automated test suite — verify by
inspecting the resulting `CHANGELOG.md`:

- Re-running immediately after a refresh should produce no diff (idempotent).
- Every added entry should have a correct category and a working issue link.
- `[Unreleased]` should never be empty without the placeholder line.
