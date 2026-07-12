---
name: fix-open-issue
description: AFK agent loop — implements one ready-for-agent GitHub issue per run in a lean context. PRs branch off main by default and stack on an open agent PR only when a declared dependency or predicted file overlap requires it; never work downstream of a dependency without green CI.
model: sonnet
disable-model-invocation: true
---

# Fix Open Issue (parallel PRs, stack on overlap)

You are running as the only scheduled agent. Complete exactly **one issue** per run, then exit. `scripts/run.sh` enforces a singleton process.

Goal: **minimise merge conflicts between agent PRs.** Each run branches off `origin/main` by default. Stack on an open agent PR only when the issue declares a dependency on it, or the issue's predicted files overlap that PR's changed files. Unrelated issues ship as parallel PRs that merge independently.

**Hub files are excluded from overlap prediction:** `app/src/shared/i18n/locales/*`, `app/src/shared/theme.ts`, and barrel `index.ts` files. Nearly every UI issue appends to them; the edits are append-only, so conflicts there are rare and trivial — counting them would re-serialise all work into one stack.

> **Merge-strategy caveat (stacks only):** squash-merging the bottom PR of a chain lands its commits on `main` as one new SHA, so upper branches still carry the originals and need the `--onto` restack in Step 1B. When merging a chain manually, prefer rebase-merge or merge-commit for the bottom PR.

Invariants (base selection, gates, and restacks live in the steps):

- Implement **exactly 1 issue per run**. Only exception: a hard dependency pair that cannot compile or pass tests when split (see Step 2).
- Only open issues labeled `ready-for-agent`. Skip issues already addressed by an open PR, merged PR, or commit on `origin/main`.
- **Never work downstream of a dependency whose PR has failing or pending CI.** Green CI on the direct parent is required before stacking on it (the parent branch contains all lower commits, so its green CI covers the chain beneath it).
- Chains cap at depth **5**; parallel PRs and chain count are uncapped — a full chain only blocks stacking onto it.
- One branch, one worktree, one PR per run.
- Every PR body must include the close keyword line `Closes #N` for the selected issue. Title references like `(#N)` do not count.

---

## Step 1: Assess open agent PRs and inventory ready issues

```bash
git fetch origin main
```

### 1A. Map open agent PRs into chains

List open agent PRs, oldest first, with base branches and CI status:

```bash
gh pr list \
  --state open \
  --json number,title,headRefName,baseRefName,createdAt,url,statusCheckRollup \
  --limit 100 \
  --jq 'map(select(.headRefName | startswith("agent-stack/"))) | sort_by(.createdAt)'
```

Reconstruct chains: a PR whose base is another agent PR's head branch is stacked on it; a PR based on `main` is a chain bottom. A standalone PR is a chain of depth 1. Record each chain's top branch, depth, and top-PR CI status.

**Feedback gate:** audit **every** open agent PR with `pr-feedback-audit --pr X`, oldest first. On the first `UNADDRESSED_FEEDBACK=true`, print `PR #X has unaddressed feedback - run address-pr-feedback --pr X instead.` and stop this skill. Keep feedback detection rules in `pr-feedback-audit`; this skill only consumes the gate result.

There is no global CI gate — CI is checked per chosen parent in Step 2.

### 1B. Restack broken chains

For each chain whose **bottom PR was merged or closed**, rebase the **whole chain in one operation** from its topmost branch using `--update-refs` (never rebase each branch individually — that duplicates parent commits and corrupts the chain):

```bash
# Check out the chain's topmost branch in a scratch worktree, then:
git rebase --update-refs --onto origin/main <merged-or-old-bottom-base-sha> agent-stack/issue-TOP
git push --force-with-lease origin agent-stack/issue-N   # push every branch the rebase moved
```

- Use `--onto origin/main <old-base-sha>` so only the chain's own commits replay.
- Verify no branch gained duplicate commits (`git log --oneline origin/main..agent-stack/issue-N` per branch) before force-pushing.
- **On conflict: `git rebase --abort`, do not force-push, comment on the affected PR that a manual restack is needed, exit.**
- After force-pushing, CI re-runs on the moved branches; wait for the top PR's checks before stacking on it (the per-parent CI check in Step 2 applies).

If `origin/main` merely advanced, restack **only** the chain this run stacks onto (before creating the worktree in Step 3); leave other chains alone. Parallel `main`-based PRs never need restacking.

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

## Step 2: Select one issue and choose its base

Pick the **lowest-numbered eligible issue**. Then scan its title, body, and comments for dependency phrases (case-insensitive): `blocked by #N`, `depends on #N`, `requires #N`, `after #N`, `needs #N first`, `conflicts with PR #N`. For each blocker `#N`:

```bash
gh issue view N --json number,state,url
gh pr list --state open --search "#N" --json number,headRefName,statusCheckRollup,url --limit 20
```

- Blocker **closed** → satisfied.
- Blocker open with an **open PR whose CI is all green** → satisfied, provided that chain's depth < 5 (otherwise skip this issue this run). Base = top branch of that PR's chain.
- Blocker open with a PR whose **CI is failing or pending** → skip this issue this run. Never build downstream of non-green CI.
- Blocker **open with no PR** and eligible → implement the blocker instead this run (re-select it as the issue).
- Blocker open with no PR and not eligible → skip this issue this run.
- Dependency cycle → skip the cycle, comment on the involved issues.
- **Atomic exception:** co-implement two issues in one PR only when they cannot compile or pass tests when split. When in doubt, split into stacked PRs.

If no declared dependency decides the base, predict overlap: guess the files the issue touches (title/body/comments plus its domain slice — `app/src/domains/<slice>`, `app/app/` routes, `website/`), list each open agent PR's changed files with `gh pr diff N --name-only`, drop hub files from both sides, intersect. Overlap → base = **top branch of that PR's chain**, provided its top CI is green and depth < 5 (otherwise skip this issue this run and try the next candidate). No overlap → base = `main`. Prediction only picks the starting base — Step 5B's merge-test catches mispredictions.

Write down the decision on one line: `Selected: #N — base main | agent-stack/issue-P (overlap: FILES / depends on #M)`.

---

## Step 3: Create a worktree on the chosen base

```bash
git worktree prune

# Stacking on a chain (its topmost branch):
git worktree add -b agent-stack/issue-N .claude/worktrees/stack-N agent-stack/issue-PARENT

# Parallel PR off main:
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

If lint or tests cannot be made clean for reasons the agent cannot resolve, comment on the issue with the blocker, remove `ready-for-agent`, add `needs-info`, and exit without a PR.

---

## Step 5B: Merge-test against open agent PRs

Prediction can be wrong. Before opening the PR, prove the branch merges cleanly with every open agent chain it does not share history with:

```bash
git fetch origin 'refs/heads/agent-stack/*:refs/remotes/origin/agent-stack/*'
# For each chain top NOT in this branch's ancestry:
git merge-tree --write-tree HEAD origin/agent-stack/issue-M   # requires git ≥ 2.38; conflict output = real conflict
```

- All clean → keep the planned base.
- Conflict with a chain whose top CI is **green** → rebase this branch onto that chain's top, make it the PR base, re-run Step 5 and this merge-test.
- Conflict with a chain whose top CI is **failing or pending** → do not stack on it, and do not open a conflicting parallel PR. Find the issue #K that PR #M closes (`gh pr view M --json closingIssuesReferences`). Discard the branch, comment on the issue: `Conflicts with PR #M — treat as blocked by #K (the issue #M closes).`, exit without a PR. The next run's dependency scan reads issue comments and will stack this issue once that chain is green.

---

## Step 6: Submit one PR

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

For a parallel PR, use `--base main` and omit the `## Stack` section.

---

## Step 7: Exit

Print one line — `Done: PR #PR_NUMBER for issue #N, base BASE.` — then stop. The scheduler re-invokes `scripts/run.sh` for the next issue.

---

## Running continuously

`scripts/run.sh` is the scheduler entry point (own lock, PID file, log dir). Example cron entry:

```text
0 * * * * /path/to/repo/skills/engineering/fix-open-issue/scripts/run.sh
```

Every unresolved blocker path above ends in comment + exit without a PR, or comment + abort without force-pushing. Never push a failing build, force a conflicted rebase, or skip verification to ship faster.
