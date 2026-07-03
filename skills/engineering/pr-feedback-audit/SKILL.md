---
name: pr-feedback-audit
description: Finds open GitHub PRs with actionable, unaddressed feedback without modifying code. Use this whenever a workflow needs to detect unresolved PR review comments, PR conversation comments, or review-body feedback before deciding whether to fix comments, block stacked work, or report pending PR feedback.
model: sonnet
---

# PR Feedback Audit

Audit open PRs for actionable, unaddressed feedback. This skill is read-only: do not checkout branches, edit files, commit, push, reply, resolve threads, or close anything.

## Quick start

```
/pr-feedback-audit
```

Scope can be narrowed:

```
/pr-feedback-audit --pr 42
/pr-feedback-audit --author @me
```

## Interface

Given a repo and optional filters, return a structured list of unresolved actionable feedback:

```
PR #42  inline       src/auth.ts:88    reviewer    unresolved  simplify null check
PR #42  issue        (conversation)    reviewer    unresolved  update docs
PR #42  review-body  (review body)     reviewer    unresolved  add tests
```

Each item must include:

- PR number and title
- source: `inline`, `issue`, or `review-body`
- commenter login
- comment/review id or URL
- path and line when available
- short requested action
- evidence used to decide it is unaddressed

If no unresolved actionable feedback exists, print `No unaddressed PR feedback found.`

## Workflow

### 1. Enumerate target PRs

```bash
gh pr list --state open --json number,title,author,isDraft,updatedAt \
  --jq '[.[] | select(.isDraft == false)]'
```

Skip draft PRs unless explicitly asked. If `--pr N` was given, audit only that PR. If `--author LOGIN` was given, filter by author.

### 2. Fetch all feedback surfaces

Check all three surfaces. GitHub splits feedback across separate endpoints, so missing one causes false negatives.

**Inline review comments** anchored to a diff line:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments \
  --paginate --jq '[.[] | select(.in_reply_to_id == null)]'
```

For each top-level inline comment, fetch replies:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments \
  --paginate --jq '[.[] | select(.in_reply_to_id == <comment_id>)]'
```

**Issue-level comments** from the PR conversation:

```bash
gh api repos/{owner}/{repo}/issues/{pr}/comments \
  --paginate --jq '[.[] | select(.user.type == "User" or .user.type == "Bot")]'
```

**Review bodies** without inline anchors:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/reviews \
  --paginate --jq '[.[] | select(.body != "" and (.state == "CHANGES_REQUESTED" or .state == "COMMENTED"))]'
```

### 3. Classify actionable feedback

Treat a comment as actionable only when it requests or clearly implies a code, test, doc, config, or behavior change.

Skip:

- praise or approval
- pure discussion with no requested change
- automated CI summaries
- generated coverage/build reports
- stale bot comments superseded by newer comments
- comments already acknowledged as fixed

When a comment is ambiguous, include it only if the requested change is reasonably clear. Otherwise omit it and mention ambiguity in a short note after the report.

### 4. Decide whether feedback is unaddressed

Use acknowledgement evidence, not GitHub's resolved-thread toggle.

An inline thread is addressed when a later reply in that thread contains one of:

- `addressed`
- `fixed`
- `done`
- `resolved`
- a commit SHA of 7 or more hex chars

An issue-level comment is addressed when a later issue-level comment from the PR author or current user acknowledges it with the same terms or a commit SHA.

A review body is addressed when a later issue-level comment mentions the reviewer login or review concern and acknowledges it with the same terms or a commit SHA. The acknowledgement must be posted after the review's `submitted_at`.

Useful review-body check:

```bash
gh api repos/{owner}/{repo}/issues/{pr}/comments \
  --paginate --jq '[.[] | select(.body | test("@<reviewer_login>|addressed|fixed|done|resolved|[0-9a-f]{7,}"; "i"))]'
```

### 5. Rank PRs

If auditing multiple PRs, sort PRs by:

1. most unresolved actionable items
2. oldest `updatedAt`

This lets fixing workflows pick the highest-leverage PR without reimplementing ranking.

## Report format

Print a compact table first:

```
PR     source       location          commenter   id/url        requested action
#42    inline       src/auth.ts:88    reviewer    123456        simplify null check
#42    issue        conversation      reviewer    789012        update docs
#42    review-body  review body       reviewer    345678        add tests
```

Then print evidence notes:

```
#42 inline 123456: no later reply in thread acknowledged a fix.
#42 issue 789012: no later author/current-user comment acknowledged a fix.
#42 review 345678: no later issue comment after 2026-07-03T10:15:00Z acknowledged @reviewer.
```

For `--pr N`, exit the report with one of:

```
UNADDRESSED_FEEDBACK=true
UNADDRESSED_FEEDBACK=false
```

Caller skills should use that final line as the gate condition.

## Safety rules

1. Stay read-only.
2. Do not checkout PR branches.
3. Do not edit files.
4. Do not post comments or replies.
5. Do not mark review threads resolved.
6. Do not treat draft PRs as targets unless explicitly requested.
