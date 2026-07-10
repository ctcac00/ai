---
name: cleanup-stale-branches
description: Clean up stale local and remote git branches (and their worktrees) that have already been merged. Use this whenever the user mentions stale branches, leftover branches, branch cleanup, pruning branches, "too many branches", merged branches piling up, cleaning up worktrees, or wants to tidy up after agents/PRs have created lots of throwaway branches. Handles squash-merged PRs that `git branch --merged` alone cannot detect.
disable-model-invocation: true
---

# Cleanup Stale Branches

Repos worked on by many agents accumulate branches and worktrees fast. Most are dead weight — the PR merged, but the branch ref, the remote branch, and the worktree all linger. This skill finds the ones that are safe to remove and deletes them, locally and on the remote, only after the user confirms.

## The one thing that makes this non-trivial

This repo squash-merges PRs. When a PR is squash-merged, GitHub collapses all its commits into a single new commit on `main` and discards the original commits. That means `git branch --merged main` **will not** report a squash-merged branch as merged — its tip commit is not an ancestor of `main`. Relying on `git branch --merged` alone would leave most of the clutter behind and create the impression that "cleanup doesn't work."

The fix is to also ask GitHub which PR head branches were merged (`gh pr list --state merged`) and treat those as stale. The bundled script already does this — don't reimplement the detection by hand.

## Workflow

### 1. Detect

Run the bundled detection script from anywhere inside the repo:

```bash
bash "$(git rev-parse --show-toplevel)/.claude/skills/cleanup-stale-branches/scripts/find_stale.sh"
```

It fetches+prunes, resolves the default branch, and prints one tab-separated line per stale local branch:

```
<branch>	<reason>	<worktree_path_or_->
```

`reason` is one of:

- `ancestor-merged` — tip is an ancestor of the default branch (normal/rebase merge)
- `squash-merged` — branch name matches a merged PR head on GitHub (the squash case)
- `gone-upstream` — its upstream remote branch was deleted (`[gone]` after prune)

The script **never deletes anything** and never proposes the default branch or the branch currently checked out. If it prints nothing, tell the user there's nothing to clean up and stop.

### 2. Confirm

Show the user a compact table of what was found — branch, reason, and whether a worktree is attached — and ask for the go-ahead before deleting anything. Group by reason so they can sanity-check. Call out the `squash-merged` ones explicitly, since those are the ones a naive cleanup would miss.

If the list is long, it's fine to ask "delete all N, or do you want to exclude any?" rather than confirming each one individually. Respect any branch the user wants to keep.

### 3. Delete

For each branch the user approved, in this order:

1. **Worktree first** (if the third column isn't `-`). A branch checked out in a worktree can't be deleted until the worktree is gone:

   ```bash
   git worktree remove <worktree_path>
   ```

   If it refuses because of uncommitted changes, **stop and ask** — don't `--force` over someone's work. Untracked-but-trivial cases (e.g. build artifacts) can be forced only after you've looked and confirmed there's nothing valuable.

2. **Local branch:**

   ```bash
   git branch -d <branch>
   ```

   Use `-d` (safe delete), not `-D`. For squash-merged branches `-d` will complain that the branch isn't fully merged — that's expected, because the commits were squashed. Only in that case, and only for a branch the detector flagged as `squash-merged` and the user approved, fall back to `git branch -D <branch>`.

3. **Remote branch**, if it still exists:
   ```bash
   git push origin --delete <branch>
   ```
   Many will already be gone (that's the `gone-upstream` reason). A failure because the remote ref doesn't exist is fine — note it and move on.

### 4. Report

Summarize what happened: branches deleted locally, branches deleted on remote, worktrees removed, and anything skipped (with the reason — e.g. "kept `wip-foo`: worktree had uncommitted changes"). Keep it short.

## Guardrails

- **Confirm before destroying.** Detection is automatic; deletion is not. Never delete without an explicit go-ahead.
- **Never touch the default branch or the current branch.** The script already excludes them; don't add them back.
- **Prefer safe deletes.** `git branch -d` and `git worktree remove` without `--force` are the defaults. Escalating to `-D`/`--force` requires either a detector reason that justifies it (squash-merged) or a deliberate user OK after you've inspected what would be lost.
- **A failed remote delete is usually harmless** (branch already gone). A failed worktree removal is a signal to stop and look.
