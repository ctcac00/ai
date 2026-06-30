---
name: agent-loop-stacking
description: AFK agent loop (stacking variant) — implements one ready-for-agent GitHub issue per run in a lean context, stacking each PR on the previous run's branch so consecutive runs never conflict. Run as an alternative to agent-loop, not at the same time.
model: sonnet
---

# Agent Loop (stacking variant)

You are running as the only scheduled agent. Complete exactly **one issue** per run (rarely an atomic dependency pair), then exit. `scripts/run.sh` enforces a singleton process; this skill does not solve multi-agent coordination.

This is the **stacking** counterpart to the `agent-loop` skill. Run **one or the other**, never both concurrently — they share the `ready-for-agent` backlog. The two skills exist so you can A/B which workflow suits you:

- `agent-loop` (grouping): batches up to 3 related issues into one PR. Fewer PRs, but a fat context window per run and only de-conflicts *within* a run.
- `agent-loop-stacking` (this): one issue per run in a fresh, lean context. Conflict-avoidance comes from the **branch base** — each run branches off the previous run's PR head — so consecutive runs see each other's in-flight edits to shared hub files (i18n locales, theme tokens, route registry, barrels).

When comparing the two: under manual-review pile-up, this variant self-throttles to 3 open PRs (the depth cap) and then idles until you merge, whereas grouping keeps producing PRs. That is intentional back-pressure to keep the stack reviewable, not a sign stacking is slower. CI runs on stacked PRs here because the workflows trigger on `pull_request` with no base-branch filter.

Goal: minimise merge conflicts **and** keep each run's context small, by stacking small single-issue PRs instead of branching every run off stale `origin/main`.

> **Merge-strategy caveat for this repo:** all three merge methods are enabled and recent history is squash-merged. Squash-merge is the classic stacked-PR killer — when you squash the bottom PR, its commits land on `main` as one *new* SHA, so every upper branch still carries the originals and needs the `--onto` restack in Step 1B to drop them. When merging a stack manually, prefer **rebase-merge or merge-commit** for the bottom PR so the cascade stays cheap. This cost does not apply to the `agent-loop` (grouping) variant, where each PR targets `main` directly.

Rules:

- Implement **exactly 1 issue per run**. The only exception is a hard dependency that cannot compile or pass tests when split (see Step 2).
- Only include open issues labeled `ready-for-agent`.
- Skip issues already addressed by an open PR, merged PR, or commit on `origin/main`.
- Cap the open stack at **3** `agent-stack/*` PRs. If the stack is at capacity, exit without starting new work.
- One branch, one worktree, one PR per run. Each PR's base is the previous open `agent-stack/*` branch (or `main` for the bottom of the stack).

---

## Step 1: Assess the stack and inventory ready issues

Fetch the latest default branch:

```bash
git fetch origin main
```

### 1A. Read the current stack and enforce the depth cap

List open agent-stack PRs, oldest first — this is the stack, bottom to top. `gh pr list` has no prefix filter, so list all open PRs and filter on `headRefName` with `jq`:

```bash
gh pr list \
  --state open \
  --json number,title,headRefName,baseRefName,createdAt,url \
  --limit 100 \
  --jq 'map(select(.headRefName | startswith("agent-stack/"))) | sort_by(.createdAt)'
```

If **3 or more** open `agent-stack/*` PRs exist, print `Stack at capacity (3 open) — exiting.` and stop. A taller un-reviewed stack is unreviewable and risks a large restack cascade.

### 1B. Rebase the open stack onto fresh main (conflict-safe)

If `origin/main` has advanced past the stack's bottom, or the bottom PR was merged/closed, the remaining branches must be rebased so a human merge cascades cleanly.

**Do not rebase each branch onto `origin/main` individually** — for an upper branch that replays its parent's commits too, duplicating history, and when it happens not to conflict it "succeeds" and you force-push a corrupted stack. Instead rebase the **whole stack in one operation** from the topmost branch using `--update-refs` (git ≥ 2.38; this repo has 2.47), which moves every intermediate branch pointer atomically:

```bash
# Check out the topmost open stack branch in a scratch worktree, then:
git rebase --update-refs --onto origin/main <merged-or-old-bottom-base-sha> agent-stack/issue-TOP
git push --force-with-lease origin agent-stack/issue-N   # push every branch the rebase moved
```

- Use `--onto origin/main <old-base-sha>` so only the stack's own commits replay, not anything already on main.
- After a clean rebase, verify no branch gained duplicate commits (`git log --oneline origin/main..agent-stack/issue-N` per branch) before force-pushing each moved branch with `--force-with-lease`.
- **If the rebase hits a conflict, abort it (`git rebase --abort`), do not force-push, comment on the affected PR explaining the manual restack is needed, and exit.** Never leave the stack in a broken state to ship faster.

If there is no open stack, skip this step.

### 1C. List candidate issues

```bash
gh issue list \
  --label ready-for-agent \
  --state open \
  --json number,title,body,labels,updatedAt \
  --limit 100
```

For each candidate, load the full issue including comments:

```bash
gh issue view NUMBER \
  --comments \
  --json number,title,body,comments,labels,state,url
```

Keep an issue only if all checks below pass.

#### No PR already addresses it

```bash
gh pr list --state open --search "#NUMBER" --json number,title,body,state,headRefName,url --limit 100
gh pr list --state merged --search "#NUMBER" --json number,title,body,state,headRefName,url --limit 100
```

`--search "#NUMBER"` matches substrings, so a search for `#23` also returns PRs mentioning `#234` or `#2300`. For each returned PR, confirm it references the issue as a **whole token** (`#NUMBER` followed by a non-digit or end of string) before trusting it. Discard substring-only false matches. If any genuinely-referencing PR remains, skip the issue.

#### No commit already addresses it

Anchor the match with an extended-regex word boundary so `#23` does not match `#234`:

```bash
git log origin/main -E --format='%H %s' --grep="#NUMBER([^0-9]|$)"
git log origin/main -E -i --format='%H %s' --grep="(closes|fixes|resolves) #NUMBER([^0-9]|$)"
```

If either returns a commit, skip the issue.

#### Not already in the open stack

If an open `agent-stack/*` PR already targets this issue (whole-token reference), skip it.

If no candidates remain, print `No qualifying issues — exiting.` and stop.

---

## Step 2: Select one issue (the seed)

Default selection: pick the **lowest-numbered eligible issue**. That is the whole decision — there is no grouping to maximise here. A lean single-issue context is the point of this variant.

Scan the seed's title, body, and comments for dependency phrases (case-insensitive): `blocked by #N`, `depends on #N`, `requires #N`, `after #N`, `needs #N first`. For each referenced blocker:

```bash
gh issue view N --json number,state,labels,title,url
```

- If the blocker is **closed**, it is satisfied — proceed with the seed.
- If the blocker is **open and eligible**, do **not** group them into one PR. Instead implement the **blocker** this run (it becomes the lower PR in the stack); the dependent issue will be picked up and stacked on top in a later run. Re-select the blocker as the seed.
- If the blocker is **open but not eligible**, skip the seed this run.
- **Atomic exception:** only co-implement two issues in a single PR when they genuinely cannot compile or pass tests when split (e.g. the dependent references a symbol introduced by the blocker and there is no sensible intermediate state). When in doubt, split into stacked PRs.
- If dependencies form a cycle, skip the cycle and comment on the involved issues explaining the ambiguity.

Write down the decision:

```text
Selected: #N TITLE — reason: lowest eligible / blocker for #M / atomic with #M
Stack base: agent-stack/issue-P (PR #X)  |  or: main (bottom of stack)
Open stack depth before this run: D/3
```

---

## Step 3: Create a worktree on top of the stack

Prune worktrees left by failed runs first:

```bash
git worktree prune
```

Choose the base:

- If an open `agent-stack/*` PR exists, base the new branch on the **topmost** open stack branch (its head, after Step 1B's rebase).
- Otherwise base it on `origin/main`.

```bash
# On top of an existing stack:
git worktree add -b agent-stack/issue-N .claude/worktrees/stack-N agent-stack/issue-PARENT

# Or, bottom of a fresh stack:
git worktree add -b agent-stack/issue-N .claude/worktrees/stack-N origin/main
```

All subsequent work happens inside this worktree — never touch the main working directory or another loop's worktrees.

---

## Step 4: Implement the issue

Treat the issue as one small vertical slice.

1. Re-read the issue from inside the worktree.
2. Identify the files it touches, including shared hub files inherited from the parent branch.
3. Write or update tests that fail for the new behavior before implementing.
4. Implement the minimum code that satisfies the issue.
5. Refactor only code touched by this issue.

Use subagents for small, isolated changes once the contract is clear (one component, one test file, copy updates, mechanical callsite edits). Subagents must not design exported APIs, decide architecture, or run project-wide verification — the main agent runs verification once after integrating. Tell subagents to skip lint/test/format gates.

Do not create mocks, stubs, no-op fallbacks, or TODO implementations. If real implementation is blocked by missing product or credential information, implement everything else, comment on the issue with the blocker, remove `ready-for-agent`, add `needs-info`, and exit without opening a PR.

---

## Step 5: Verify

Run the narrowest checks that prove the change works, then the required project checks.

For the Expo app:

```bash
cd app
npm run lint
npm run test
```

If the change touches `website/`, run its relevant lint/test commands from `website/` as well.

Fix lint errors and test failures — do not suppress or skip tests. All directly affected checks must be clean before proceeding.

---

## Step 6: Submit one stacked PR

Push the branch, then open a PR whose **base is the parent branch** (so GitHub shows the incremental diff and auto-retargets when the parent merges):

```bash
git push -u origin agent-stack/issue-N

# Base on the parent stack branch:
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
- [ ] COMMAND_RUN
EOF
```

For the bottom of a fresh stack, use `--base main` and omit the `## Stack` section.

---

## Step 7: Exit

Print a one-line summary:

```text
Done: PR #PR_NUMBER created for issue #N (TITLE), stacked on #PARENT_PR. Stack depth now D/3.
```

Then stop. The scheduler re-invokes `scripts/run.sh` for the next issue.

---

## Running continuously

`scripts/run.sh` is the scheduler entry point. It uses its **own** lock, PID file, and log dir (separate from `agent-loop`) so the two systems never clobber each other's state on disk, even when run at different times.

Run only one of the two loops at a time. Example cron entry (do not enable alongside `agent-loop`):

```text
0 * * * * /path/to/plant-care/.claude/skills/agent-loop-stacking/scripts/run.sh
```

---

## Failure handling

- If a rebase in Step 1B conflicts: comment on the affected PR, do not force-push, exit. The stack needs a manual restack.
- If the issue is blocked by missing information: comment on the issue, remove `ready-for-agent`, add `needs-info`, and exit without a PR.
- If lint or tests cannot be made clean: comment on the issue with the failing command and blocker, remove `ready-for-agent`, add `needs-info`, and exit without opening a PR.
- Never push a failing build, force a conflicted rebase, or skip verification to ship faster.
