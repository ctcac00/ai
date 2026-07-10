---
name: address-pr-feedback
description: Implements fixes for actionable, unaddressed GitHub PR feedback after first using pr-feedback-audit to find the pending comments. Use when asked to address PR feedback, work through review comments, fix open PR reviews, resolve PR comments, or follow up on requested PR changes.
model: sonnet
disable-model-invocation: true
---

# Address PR Feedback

Fix actionable PR feedback and reply to each addressed item. This skill depends on `pr-feedback-audit` for detection; keep feedback discovery rules there so gating and fixing workflows classify comments the same way.

## Quick start

```
/address-pr-feedback
```

Scope can be narrowed:

```
/address-pr-feedback --pr 42
/address-pr-feedback --author @me
```

## Workflow

### 1. Audit pending feedback

Run or follow `pr-feedback-audit` with the same filters:

```
/pr-feedback-audit
/pr-feedback-audit --pr 42
/pr-feedback-audit --author @me
```

If the audit reports `No unaddressed PR feedback found.` or `UNADDRESSED_FEEDBACK=false`, stop.

If multiple PRs have feedback, use the audit ranking: most unresolved actionable items first, then oldest `updatedAt`. Present a short summary of the selected PR and pending items before changing files.

### 2. Checkout the PR branch

```bash
gh pr checkout <pr_number>
```

Confirm the checked-out branch is the PR's own branch. Never apply feedback fixes directly on `main` or `master`.

### 3. Read each audited item

For each item from the audit report:

- Inline feedback: fetch the full comment body and diff context from the reported id or URL, then read the commented file.
- Issue-level feedback: read the comment body in full and infer affected files from the comment and PR diff.
- Review-body feedback: read the review body in full and infer affected files from the review text and PR diff.

Use `gh pr diff <pr_number> --name-only` when the affected file is not obvious.

Understand the requested change before editing. If two comments conflict, skip both, report the conflict, and do not guess.

### 4. Implement fixes

Address all non-conflicting audited items on the chosen PR:

- Make the minimal code, test, doc, or config change that satisfies the reviewer.
- Do not refactor beyond what the feedback asks for.
- If a comment is ambiguous but has a conservative reasonable interpretation, apply that interpretation.
- If a comment is impossible, contradictory, or too unclear, skip it and explain why in the report.

### 5. Verify

Run the narrowest relevant test, lint, or typecheck commands for the touched files. If no meaningful automated check exists, state that explicitly in the report.

### 6. Commit and push

Group related fixes into logical commits. Use descriptive messages referencing the PR:

```bash
git add <files>
git commit -m "address review feedback on PR #<n>: <short description>"
git push
```

### 7. Reply to each addressed item

Reply once per addressed item. Before posting, check the audit evidence and current comments to avoid duplicate replies.

Inline review thread: reply on the same thread.

```bash
gh api repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies \
  -X POST \
  -f body="Addressed in <sha> - <one-line description of what changed>."
```

Issue-level comment or review body: post a new issue comment referencing the commenter.

```bash
gh api repos/{owner}/{repo}/issues/{pull_number}/comments \
  -X POST \
  -f body="Re: @<commenter>'s feedback - addressed in <sha>: <one-line description of what changed>."
```

Use the shortest unambiguous SHA, usually 7 chars, of the commit that fixed the item.

### 8. Report

Print a summary table:

```
PR #42  inline       src/auth.ts:88    fixed    committed a3f9c12, replied
PR #42  issue        conversation      fixed    committed a3f9c12, replied
PR #42  review-body  review body       skipped  conflicting request, needs human clarification
```

Include verification commands and results.

## Safety rules

1. Never resolve or close a thread; only add a reply.
2. Never reply twice to the same item.
3. Never process draft PRs unless explicitly asked.
4. Never push to `main` or `master`; only push to the PR branch.
5. If `--dry-run` is passed, print what would change and what would be posted, without editing files, committing, pushing, or calling write APIs.
