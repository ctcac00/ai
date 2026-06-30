#!/usr/bin/env bash
# Find local branches that have been merged into the default branch — including
# squash-merged PRs that `git branch --merged` cannot detect.
#
# Output: tab-separated lines, one per stale branch:
#   <branch>\t<reason>\t<worktree_path_or_->
# where reason is one of: ancestor-merged | squash-merged | gone-upstream
#
# Nothing is deleted. This is detection only.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# Resolve the default branch (main/master/...). Prefer origin/HEAD, fall back to main.
default_branch="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || true)"
[ -z "$default_branch" ] && default_branch="main"

current_branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")"

# Refresh remote state and prune deleted remote-tracking refs so "gone" detection is accurate.
git fetch --prune origin >/dev/null 2>&1 || true

# Map branch -> worktree path (for branches checked out in a worktree).
declare -A worktree_of
wt_path=""
while IFS= read -r line; do
  case "$line" in
    "worktree "*) wt_path="${line#worktree }" ;;
    "branch refs/heads/"*) worktree_of["${line#branch refs/heads/}"]="$wt_path" ;;
  esac
done < <(git worktree list --porcelain)

# Branches whose tip is an ancestor of the default branch (regular/rebase merges).
declare -A ancestor_merged
while IFS= read -r b; do
  b="${b#"${b%%[![:space:]]*}"}"   # ltrim
  [ -z "$b" ] && continue
  ancestor_merged["$b"]=1
done < <(git branch --merged "origin/$default_branch" --format='%(refname:short)')

# Pull the set of merged-PR head branch names from GitHub, if gh is available and authed.
# This is what catches squash merges: the branch name lived on the PR even though its
# commits were squashed into a single new commit on the default branch.
declare -A pr_merged
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  while IFS=$'\t' read -r head cross oid; do
    [ -z "$head" ] && continue
    [ "$cross" = "true" ] && continue   # fork PR — name alone isn't trustworthy
    pr_merged["$head"]="$oid"
  done < <(gh pr list --state merged --limit 500 \
             --json headRefName,isCrossRepository,headRefOid \
             --jq '.[] | [.headRefName, .isCrossRepository, .headRefOid] | @tsv' 2>/dev/null || true)
fi

# Walk every local branch and classify it.
while IFS= read -r branch; do
  # Never propose the default branch or the branch currently checked out in THIS tree.
  [ "$branch" = "$default_branch" ] && continue
  [ "$branch" = "$current_branch" ] && continue

  wt="${worktree_of[$branch]:--}"
  reason=""

  if [ "${ancestor_merged[$branch]:-}" = "1" ]; then
    reason="ancestor-merged"
  elif [ -n "${pr_merged[$branch]:-}" ] && \
       [ "$(git rev-parse --quiet --verify "refs/heads/$branch" 2>/dev/null)" = "${pr_merged[$branch]}" ]; then
    reason="squash-merged"
  else
    # Upstream existed and is now gone (remote branch deleted after merge).
    upstream="$(git for-each-ref --format='%(upstream:track)' "refs/heads/$branch")"
    [ "$upstream" = "[gone]" ] && reason="gone-upstream"
  fi

  [ -n "$reason" ] && printf '%s\t%s\t%s\n' "$branch" "$reason" "$wt"
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)
