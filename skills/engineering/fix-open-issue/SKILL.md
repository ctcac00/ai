---
name: fix-open-issue
description: AFK agent loop — implements one ready-for-agent GitHub issue per run in a lean context, stacking each PR on the previous run's branch. An issue whose blocker has an open PR with green CI is unblocked; never work downstream of a dependency without green CI.
model: sonnet
---

# Fix Open Issue (stacked PRs)

You are running as the only scheduled agent. Complete exactly **one issue** per run, then exit. `scripts/run.sh` enforces a singleton process.

Each run branches off the previous run's PR head instead of stale `origin/main`, so consecutive runs see each other's in-flight edits to shared hub files (i18n locales, theme tokens, route registry, barrels).

> **Merge-strategy caveat:** squash-merging the bottom PR lands its commits on `main` as one new SHA, so upper branches still carry the originals and need the `--onto` restack in Step 1B. When merging a stack manually, prefer rebase-merge or merge-commit for the bottom PR.

Rules:

- Implement **exactly 1 issue per run**. Only exception: a hard dependency pair that cannot compile or pass tests when split (see Step 2).
- Only open issues labeled `ready-for-agent`.
- Skip issues already addressed by an open PR, merged PR, or commit on `origin/main`.
- An issue blocked by another issue is **unblocked** once the blocker is closed, or the blocker has an open PR whose CI is **green**. Stack the new PR directly on top of that blocker's own PR branch — not on the current topmost stack branch, if they differ.
- **Never work downstream of a dependency whose PR has failing or pending CI.** Green CI on the direct parent is required before stacking on it (the parent branch contains all lower commits, so its green CI covers the stack beneath it).
- Cap the open stack at **5** `agent-stack/*` PRs. At capacity, exit without starting new work.
- If the upstream stack PR has unaddressed review feedback according to `pr-feedback-audit --pr X`, do **not** implement a new issue. Run `address-pr-feedback --pr X` for that PR instead.
- One branch, one worktree, one PR per run. Each PR's base is the topmost open `agent-stack/*` branch (or `main` for the bottom of the stack).
- Every PR body must include the close keyword line `Closes #N` for the selected issue. Title references like `(#N)` do not count.

---

## Step 1: Assess the stack and inventory ready issues

```bash
git fetch origin main
```

### 1A. Read the current stack and enforce the depth cap

List open agent-stack PRs, oldest first (bottom to top), with CI status:

```bash
gh pr list \
  --state open \
  --json number,title,headRefName,baseRefName,createdAt,url,statusCheckRollup \
  --limit 100 \
  --jq 'map(select(.headRefName | startswith("agent-stack/"))) | sort_by(.createdAt)'
```

If **5 or more** open `agent-stack/*` PRs exist, print `Stack at capacity (5 open) — exiting.` and stop.

**CI gate:** if the topmost open stack PR's CI is failing or still pending, print `Parent PR #X CI not green — exiting.` and stop. Do not stack on a branch without green CI.

**Feedback gate:** audit the topmost open stack PR with `pr-feedback-audit --pr X`. If the audit reports `UNADDRESSED_FEEDBACK=true`, print `Parent PR #X has unaddressed feedback - run address-pr-feedback --pr X instead.` and stop this skill. Keep feedback detection rules in `pr-feedback-audit`; this skill only consumes the gate result before stacking more work.

### 1B. Restack onto fresh main if the bottom moved

If `origin/main` has advanced past the stack's bottom, or the bottom PR was merged/closed, rebase the **whole stack in one operation** from the topmost branch using `--update-refs` (never rebase each branch individually — that duplicates parent commits and corrupts the stack):

```bash
# Check out the topmost open stack branch in a scratch worktree, then:
git rebase --update-refs --onto origin/main <merged-or-old-bottom-base-sha> agent-stack/issue-TOP
git push --force-with-lease origin agent-stack/issue-N   # push every branch the rebase moved
```

- Use `--onto origin/main <old-base-sha>` so only the stack's own commits replay.
- Verify no branch gained duplicate commits (`git log --oneline origin/main..agent-stack/issue-N` per branch) before force-pushing.
- **On conflict: `git rebase --abort`, do not force-push, comment on the affected PR that a manual restack is needed, exit.**
- After force-pushing, CI re-runs on the moved branches from scratch, invalidating any CI status read in Step 1A before this restack. Re-run Step 1A's CI gate against the topmost branch's new commit before proceeding to Step 1C: poll `gh pr checks <topmost-pr>` (or re-fetch `statusCheckRollup`) until it is green, or exit with `Parent PR #X CI not green — exiting.` if it fails.

If there is no open stack, skip this step.

### 1C. List candidate issues

```bash
gh issue list --label ready-for-agent --state open \
  --json number,title,body,labels,updatedAt --limit 100
```

For each candidate, load it fully:

```bash
gh issue view NUMBER --comments --json number,title,body,comments,labels,state,url
```

Keep an issue only if all checks pass:

**No PR already addresses it** (open or merged):

```bash
gh pr list --state open --search "#NUMBER" --json number,title,state,headRefName,url --limit 100
gh pr list --state merged --search "#NUMBER" --json number,title,state,headRefName,url --limit 100
```

`--search "#NUMBER"` matches substrings (`#23` also hits `#234`). Confirm each returned PR references the issue as a whole token (`#NUMBER` followed by a non-digit or end of string); discard false matches. Any genuine match → skip the issue.

**No commit already addresses it** (word-boundary anchored):

```bash
git log origin/main -E --format='%H %s' --grep="#NUMBER([^0-9]|$)"
```

If no candidates remain, print `No qualifying issues — exiting.` and stop.

---

## Step 2: Select one issue

Pick the **lowest-numbered eligible issue**. Then scan its title, body, and comments for dependency phrases (case-insensitive): `blocked by #N`, `depends on #N`, `requires #N`, `after #N`, `needs #N first`. For each blocker `#N`:

```bash
gh issue view N --json number,state,url
gh pr list --state open --search "#N" --json number,headRefName,statusCheckRollup,url --limit 20
```

- Blocker **closed** → satisfied.
- Blocker open with an **open PR whose CI is all green** → satisfied. Record that PR's `headRefName` as the base for Step 3 — stack directly on the blocker's own branch, which may not be the current topmost stack branch.
- Blocker open with a PR whose **CI is failing or pending** → skip this issue this run. Never build downstream of non-green CI.
- Blocker **open with no PR** and eligible → implement the blocker instead this run (re-select it as the issue).
- Blocker open with no PR and not eligible → skip this issue this run.
- Dependency cycle → skip the cycle, comment on the involved issues.
- **Atomic exception:** co-implement two issues in one PR only when they cannot compile or pass tests when split. When in doubt, split into stacked PRs.

Write down the decision:

```text
Selected: #N TITLE — reason
Base: agent-stack/issue-P (PR #X, CI green)  |  or: main
Stack depth before this run: D/5
```

`agent-stack/issue-P` here is the blocker's own branch when the seed has a satisfied blocker (per Step 2), and only falls back to the topmost open stack branch when the seed has no blocker.

---

## Step 3: Create a worktree on top of the stack

```bash
git worktree prune

# Base is the branch selected in Step 2 (blocker's own branch if the seed had one,
# otherwise the topmost open stack branch):
git worktree add -b agent-stack/issue-N .claude/worktrees/stack-N agent-stack/issue-PARENT

# Or, bottom of a fresh stack (no open stack, no blocker):
git worktree add -b agent-stack/issue-N .claude/worktrees/stack-N origin/main
```

All work happens inside this worktree — never touch the main working directory or other worktrees.

---

## Step 4: Implement the issue

Treat the issue as one small vertical slice:

1. Re-read the issue from inside the worktree.
2. Identify the files it touches, including shared hub files inherited from the parent branch.
3. Write or update tests that fail for the new behavior before implementing.
4. Implement the minimum code that satisfies the issue.
5. Refactor only code touched by this issue.

Use subagents for small, isolated changes once the contract is clear. Subagents must not design exported APIs, decide architecture, or run project-wide verification; tell them to skip lint/test/format gates — the main agent verifies once after integrating.

No mocks, stubs, no-op fallbacks, or TODO implementations. If blocked by missing product or credential information: comment on the issue, remove `ready-for-agent`, add `needs-info`, exit without a PR.

---

## Step 5: Verify

Run the narrowest checks that prove the change, then the required project checks:

```bash
cd app
npm run lint
npm run test
```

If the change touches `website/`, run its lint/test from `website/` too. Fix failures — never suppress or skip tests.

---

## Step 6: Submit one stacked PR

```bash
git push -u origin agent-stack/issue-N

gh pr create \
  --title "TITLE (#N)" \
  --base agent-stack/issue-PARENT \
  --head agent-stack/issue-N \
  --body-file - <<'EOF'
Closes #N

## Summary
BRIEF_DESCRIPTION_OF_THE_CHANGE

## Stack
- Stacked on #PARENT_PR (base branch `agent-stack/issue-PARENT`).
- Merge bottom-up: merge #PARENT_PR before this one.

## Test plan
- [ ] COMMAND_RUN
EOF
```

For the bottom of a fresh stack, use `--base main` and omit the `## Stack` section.

---

## Step 7: Exit

```text
Done: PR #PR_NUMBER created for issue #N (TITLE), stacked on #PARENT_PR. Stack depth now D/5.
```

Then stop. The scheduler re-invokes `scripts/run.sh` for the next issue.

---

## Running continuously

`scripts/run.sh` is the scheduler entry point (own lock, PID file, log dir). Example cron entry:

```text
0 * * * * /path/to/plant-care/.claude/skills/fix-open-issue/scripts/run.sh
```

---

## Failure handling

- Restack conflict in Step 1B: comment on the affected PR, do not force-push, exit.
- Issue blocked on missing info, or lint/tests cannot be made clean: comment on the issue with the blocker, remove `ready-for-agent`, add `needs-info`, exit without a PR.
- Never push a failing build, force a conflicted rebase, or skip verification to ship faster.
