---
name: pr-housekeeping
description: Finds open PRs with unresolved inline review comments and issue-level (conversation) comments, then implements the fixes. Enumerates open PRs, surfaces all unaddressed feedback of both kinds, picks the best PR to tackle, reads the comments, makes the code changes, commits, and replies to each thread/comment. Use when asked to address PR feedback, work through review comments, fix open PR reviews, or do PR housekeeping.
model: sonnet
---

# PR Housekeeping

Finds open PRs with unresolved review comments — both inline (diff-anchored) and issue-level (general PR conversation) — and fixes them.

## Quick start

```
/pr-housekeeping
```

Runs against the current repo. Scope can be narrowed:

```
/pr-housekeeping --pr 42
/pr-housekeeping --author @me
```

## Workflow

### 1. Enumerate targets

```bash
gh pr list --state open --json number,title,author,isDraft,updatedAt \
  --jq '[.[] | select(.isDraft == false)]'
```

Skip draft PRs (`isDraft == false`). If `--pr N` was given, only process that PR.

### 2. Fetch unresolved comments per PR — both kinds

Two distinct comment surfaces exist on a PR; check both.

**Inline review comments** (anchored to a diff line):

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments \
  --paginate --jq '[.[] | select(.in_reply_to_id == null)]'
```

Top-level review comments only (not replies). A thread is **unresolved** if no existing reply contains "addressed", "fixed", "done", "resolved", or a commit SHA.

Check replies per thread:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments \
  --paginate --jq '[.[] | select(.in_reply_to_id == <comment_id>)]'
```

**Issue-level comments** (general PR conversation, not anchored to a line — a PR is also an issue in the GitHub API):

```bash
gh api repos/{owner}/{repo}/issues/{pr}/comments \
  --paginate --jq '[.[] | select(.user.type == "User" or .user.type == "Bot")]'
```

These have no reply/thread structure — they're flat. Treat a comment as **unresolved** if it reads as feedback/a request (not just praise or discussion) and no later comment in the same list (from the PR author or from us) acknowledges it with "addressed", "fixed", "done", "resolved", or a commit SHA. Use judgment: skip comments that are purely informational, automated CI summaries, or already-resolved discussion.

Also check PR reviews submitted with a body but no inline comments (e.g. "Request changes" with summary text only):

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews \
  --paginate --jq '[.[] | select(.body != "" and (.state == "CHANGES_REQUESTED" or .state == "COMMENTED"))]'
```

Review bodies are **immutable** — the record always exists regardless of any follow-up. Before treating a review body as unresolved, check whether an issue-level comment already acknowledges it. Fetch the issue comments and look for a later comment that mentions the reviewer's login and contains "addressed", "fixed", "done", "resolved", or a commit SHA:

```bash
gh api repos/{owner}/{repo}/issues/{pr}/comments \
  --paginate --jq '[.[] | select(.body | test("@<reviewer_login>|addressed|fixed|done|resolved|[0-9a-f]{7,}"; "i"))]'
```

If such a comment exists and was posted **after** the review's `submitted_at`, treat the review body as already addressed and skip it.

### 3. Pick one PR to address

If `--pr N` was not given, pick the PR with the most unresolved items (inline threads + issue-level comments + review bodies, combined). Ties broken by oldest `updated_at`. Present a brief summary of what's pending before proceeding.

### 4. Checkout the PR branch locally

```bash
gh pr checkout <pr_number>
```

### 5. Read and understand each comment

For each unresolved inline thread, fetch the full comment body and the surrounding file context:

```bash
gh api repos/{owner}/{repo}/pulls/comments/{comment_id} --jq '{body, path, line, diff_hunk}'
```

Read the file at the commented path. For issue-level comments and review bodies, there's no anchored path/line — read the comment body in full and infer the affected file(s) from its content (and from the PR's changed files if needed: `gh pr diff <pr_number> --name-only`).

Understand what change is being requested before touching anything.

### 6. Implement the fixes

Address all unresolved comments on the chosen PR:

- Make the minimal code change that satisfies the reviewer's concern.
- Do not refactor or clean up code beyond what the comment asks for.
- If a comment is ambiguous, apply the most conservative reasonable interpretation.
- If a comment is genuinely impossible or contradictory, note it in the report and skip — do not guess.

### 7. Commit the changes

Group related fixes into logical commits. Use descriptive messages referencing the PR:

```bash
git add <files>
git commit -m "address review feedback on PR #<n>: <short description>"
```

Push to the PR branch:

```bash
git push
```

### 8. Reply to each addressed item

Inline review thread — reply on the same thread:

```bash
gh api repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies \
  -X POST \
  -f body="Addressed in <sha> — <one-line description of what changed>."
```

Issue-level comment or review body — there's no thread to reply into, so post a new issue comment referencing it:

```bash
gh api repos/{owner}/{repo}/issues/{pull_number}/comments \
  -X POST \
  -f body="Re: @<commenter>'s comment above — addressed in <sha>: <one-line description of what changed>."
```

Use the shortest unambiguous SHA (7 chars) of the commit that last touched the relevant file. One reply per comment thread or issue-level comment — never bundle multiple acknowledgements into one reply.

### 9. Report

Print a summary table:

```
PR #42  inline  src/auth.ts:88    fixed   → committed a3f9c12, replied
PR #42  inline  README.md:12      fixed   → committed a3f9c12, replied
PR #42  issue   (conversation)    fixed   → committed a3f9c12, replied
PR #51  inline  api/routes.ts:34  skipped → comment ambiguous, needs human clarification
```

## Safety rules (must follow)

1. **Never resolve/close a thread** — only add a reply.
2. **Never reply twice** — check for existing replies before posting.
3. **Never process draft PRs** unless explicitly asked.
4. **Never push to main/master** — only push to the PR's own branch.
5. **Dry-run flag**: if `--dry-run` is passed, print what would change and what would be posted, without writing files, committing, or calling the API.

## Disambiguation

- "Unresolved" means no reply acknowledging the fix — not the GitHub "resolved" toggle.
- This skill targets **both** inline review comments (`/pulls/comments`) and issue-level/conversation comments and review bodies (`/issues/comments`, `/pulls/reviews`).
- Issue-level comments are noisier — automated bot summaries, CI status notes, and pure discussion are common. Only treat a comment as actionable feedback if it's clearly requesting a change; when in doubt, skip and note it rather than guessing.
- If a comment requests a change that conflicts with another comment in the same PR, note both in the report and skip; do not guess at intent.
