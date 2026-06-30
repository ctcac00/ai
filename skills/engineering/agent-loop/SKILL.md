---
name: agent-loop
description: AFK agent loop — batches related ready-for-agent GitHub issues, implements up to three in one worktree/PR, and exits.
model: sonnet
---

# Agent Loop

You are running as the only scheduled agent. Complete exactly **one coordinated issue group** per run, then exit. `scripts/run.sh` is responsible for enforcing a singleton process; this skill does not solve multi-agent coordination.

Goal: reduce merge conflicts by landing related issues that touch the same files in one PR instead of several competing small PRs.

Rules:

- Work on **1–3 issues per run**. Never include more than 3 issues.
- Only include open issues labeled `ready-for-agent`.
- Skip issues already addressed by an open PR, merged PR, or commit on `origin/main`.
- Respect issue dependencies before grouping or implementing.
- Create one branch, one worktree, and one PR for the group.

---

## Step 1: Inventory ready issues

Fetch the latest default branch:

```bash
git fetch origin main
```

List open ready issues:

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

### 1A. No PR already addresses it

Check open and merged PRs that reference the issue. Treat any open or merged PR mentioning the issue as already addressing it.

```bash
gh pr list --state open --search "#NUMBER" --json number,title,body,state,headRefName,url --limit 100
gh pr list --state merged --search "#NUMBER" --json number,title,body,state,headRefName,url --limit 100
```

`--search "#NUMBER"` matches substrings, so a search for `#23` also returns PRs that mention `#234` or `#2300`. For each returned PR, confirm it references the issue as a **whole token** (`#NUMBER` followed by a non-digit or end of string, e.g. `Closes #23`, `#23.`, `#23)`) before trusting it. Discard substring-only false matches.

If any genuinely-referencing PR remains, skip the issue.

### 1B. No commit already addresses it

Search `origin/main` for commits that reference the issue. Anchor the match with an extended-regex word boundary so `#23` does not match `#234`:

```bash
git log origin/main -E --format='%H %s' --grep="#NUMBER([^0-9]|$)"
git log origin/main -E -i --format='%H %s' --grep="(closes|fixes|resolves) #NUMBER([^0-9]|$)"
```

If either command returns a commit, skip the issue.

### 1C. Dependencies are safe

Scan the issue title, body, and comments for dependency phrases, case-insensitive:

- `blocked by #N`
- `depends on #N`
- `requires #N`
- `after #N`
- `needs #N first`

For every referenced blocker:

```bash
gh issue view N --json number,state,labels,title,url
```

Rules:

- If the blocker is closed, it is satisfied.
- If the blocker is open and is also a ready, unaddressed candidate, include it in the same group before the dependent issue.
- If the blocker is open but not eligible, skip the dependent issue.
- If including blockers would make the group larger than 3, skip the dependent issue for this run.
- If dependencies form a cycle, skip the cycle and comment on the involved issues explaining the ambiguity.

If no candidates remain, print `No qualifying issues — exiting.` and stop.

---

## Step 2: Choose a related group

Use grouping to avoid future merge conflicts, not to maximize batch size. A group of 1 is valid when no safe related issues exist.

When there are many candidates, use read-only subagents to summarize small batches of issue titles/bodies/comments. Ask for:

- Related issue numbers mentioned explicitly.
- Dependency edges.
- Likely files or directories touched.
- Shared subsystem or route.
- Whether the issue looks small and independent.

Subagents must not edit files, run project-wide checks, or make final grouping decisions.

Grouping algorithm:

1. Sort eligible issues by issue number.
2. Pick the lowest-numbered eligible issue as the seed.
3. Add required open blockers first, ordered before dependents.
4. Add related issues until the group has at most 3 issues.

Prefer additions in this order:

1. Explicit relationship in issue text/comments (`related to #N`, `same area as #N`, `split from #N`, `follow-up to #N`).
2. Direct dependency that can be completed in the same group.
3. Predicted overlap in the same concrete files.
4. Same route, store, module, native surface, or backend integration.
5. Same non-`ready-for-agent` labels.

Do **not** add unrelated issues just to reach 3. If more than 3 issues are related, choose the tightest dependency/file-overlap cluster and leave the rest for a later run.

Before implementing, write down the group:

```text
Selected group:
- #N TITLE — reason: seed/dependency/file overlap/etc.
- #M TITLE — reason: related via ...

Excluded related issues:
- #K TITLE — reason: exceeds max group size / blocked / weaker overlap
```

---

## Step 3: Create a worktree

First prune worktrees left behind by failed or abandoned runs so they don't accumulate:

```bash
git worktree prune
```

Create one group branch from `origin/main`:

```bash
git fetch origin main
git worktree add -b agent/issues-N-M-K .claude/worktrees/issues-N-M-K origin/main
```

All subsequent work happens inside this worktree — never touch the main working directory.

---

## Step 4: Implement the group

Treat the selected issues as one small product slice.

1. Re-read every grouped issue from inside the worktree.
2. Identify shared files, invariants, and dependency order.
3. Write or update tests that fail for the grouped behavior before implementation.
4. Implement the minimum code that satisfies all grouped issues.
5. Refactor only code touched by the group.

Use subagents for small, independent changes after the shared contract is clear:

- Good subagent work: one isolated component, one test file, copy/text updates, mechanical callsite edits.
- Bad subagent work: shared architecture, exported API design, dependency ordering, final integration, project-wide verification.
- Tell subagents to skip lint/test/format gates. The main agent runs verification once after integrating all changes.
- If subagents may touch related files, give them exact file/symbol targets and require coordination before changing shared interfaces.

Do not create mocks, stubs, no-op fallbacks, or TODO implementations. If real implementation is blocked by missing product or credential information, implement everything else, comment on the issue with the blocker, remove `ready-for-agent`, add `needs-info`, and exit without opening a PR.

---

## Step 5: Verify

Run the narrowest checks that prove the grouped change works, then the required project checks.

For the Expo app:

```bash
cd app
npm run lint
npm run test
```

If the group touches `website/`, run its relevant lint/test commands from `website/` as well.

If lint fails, fix lint errors before continuing. If tests fail, fix the failures — do not suppress or skip tests.

All directly affected checks must be clean before proceeding.

---

## Step 6: Submit one PR

Push the completed group branch before creating the PR. `gh pr create` must receive the already-pushed head branch so unattended runs never prompt:

```bash
git push -u origin agent/issues-N-M-K

gh pr create \
  --title "GROUP_TITLE (#N, #M, #K)" \
  --base main \
  --head "agent/issues-N-M-K" \
  --body-file - <<'EOF'
Closes #N
Closes #M
Closes #K

## Summary
BRIEF_DESCRIPTION_OF_THE_GROUPED_CHANGE

## Grouping rationale
- #N and #M both touch FILE_OR_SUBSYSTEM.
- #K depends on #N.

## Test plan
- [ ] COMMAND_RUN
- [ ] COMMAND_RUN
EOF
```

For a one- or two-issue group, omit unused `Closes` lines and issue numbers.

---

## Step 7: Exit

Print a one-line summary:

```text
Done: PR #PR_NUMBER created for issues #N/#M/#K (GROUP_TITLE).
```

Then stop. The scheduler re-invokes `scripts/run.sh` for the next group.

---

## Running continuously

`scripts/run.sh` is the scheduler entry point. It enforces a single local process with a lock and PID file, runs this skill headlessly, and logs output to `.agent-logs/`.

Example cron entry:

```text
0 * * * * /path/to/plant-care/.claude/skills/agent-loop/scripts/run.sh
```

---

## Failure handling

- If a grouped issue is blocked by missing information: comment on that issue, remove `ready-for-agent`, add `needs-info`, and continue only if the remaining group still makes sense.
- If the remaining group no longer makes sense, comment on every grouped issue, remove `ready-for-agent` where appropriate, and exit without a PR.
- If lint or tests cannot be made clean: comment on every grouped issue with the failing command and blocker, remove `ready-for-agent`, add `needs-info`, and exit without opening a PR.
- Never push a failing build or skip verification to ship faster.
