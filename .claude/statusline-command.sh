#!/usr/bin/env bash

input=$(cat)
cwd=$(echo "$input" | jq -r '.workspace.current_dir')
model=$(echo "$input" | jq -r '.model.display_name')
pct=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')

cost_fmt=$(printf '%.2f' "$cost")

if [ "$pct" -ge 90 ]; then bar_color="\033[38;5;203m"
elif [ "$pct" -ge 70 ]; then bar_color="\033[38;5;214m"
else bar_color="\033[38;5;81m"; fi

filled=$((pct / 10)); empty=$((10 - filled))
bar=$(i=0; while [ $i -lt $filled ]; do printf '▓'; i=$((i+1)); done; i=0; while [ $i -lt $empty ]; do printf '░'; i=$((i+1)); done)

DIM="\033[38;5;59m"; RST="\033[0m"

branch=""
git_info=""

if git --no-optional-locks -C "$cwd" rev-parse --git-dir >/dev/null 2>&1; then
    branch=$(git --no-optional-locks -C "$cwd" branch --show-current 2>/dev/null || echo "detached")

    # Uncommitted changes: new files (+), modifications (!), untracked (?)
    diff_stat=$(git --no-optional-locks -C "$cwd" status --porcelain 2>/dev/null | awk '
        {
            x=substr($0,1,1); y=substr($0,2,1)
            if (x=="?") u++
            else { if (x=="A") a++; if (x=="M" || y=="M") m++ }
        }
        END {
            out=""
            if (a>0) out=out (out==""?"":\" ") "+" a
            if (m>0) out=out (out==""?"":\" ") "!" m
            if (u>0) out=out (out==""?"":\" ") "?" u
            if (out!="") print out
        }
    ')

    # Ahead/behind upstream: @{u}...HEAD → field1=behind(pull), field2=ahead(push)
    ahead_behind=""
    if git --no-optional-locks -C "$cwd" rev-parse --verify "@{u}" >/dev/null 2>&1; then
        read -r behind ahead <<EOF
$(git --no-optional-locks -C "$cwd" rev-list --left-right --count "@{u}...HEAD" 2>/dev/null)
EOF
        [ "${ahead:-0}" -gt 0 ] 2>/dev/null && ahead_behind="${ahead_behind}${ahead}↑"
        [ "${behind:-0}" -gt 0 ] 2>/dev/null && ahead_behind="${ahead_behind} ${behind}↓"
        ahead_behind="${ahead_behind# }"
    fi

    # Combine git status parts
    git_parts=""
    [ -n "$diff_stat" ] && git_parts="\033[38;5;214m${diff_stat}${RST}"
    if [ -n "$ahead_behind" ]; then
        [ -n "$git_parts" ] && git_parts="${git_parts} "
        git_parts="${git_parts}\033[38;5;81m${ahead_behind}${RST}"
    fi

    branch_color="\033[38;5;141m"
    git_info="${branch_color}${branch}${RST}"
    [ -n "$git_parts" ] && git_info="${git_info} ${git_parts}"
fi

display_cwd=$(basename "$cwd")
[ "$display_cwd" = "/" ] && display_cwd="/"

out="\033[38;5;75m\033[1m${display_cwd}\033[0m"
if [ -n "$branch" ]; then
    out="${out} ${DIM}·${RST} ${git_info}"
fi
out="${out} ${DIM}·${RST} ${bar_color}${bar} ${pct}%${RST}"
out="${out} ${DIM}·${RST} \033[38;5;220m\$${cost_fmt}${RST}"

effort=$(echo "$input" | jq -r '.effort.level // empty')
if [ -n "$effort" ]; then
    out="${out} ${DIM}·${RST} \033[38;5;183m${model} [${effort}]${RST}"
else
    out="${out} ${DIM}·${RST} \033[38;5;183m${model}${RST}"
fi

printf "%b" "$out"
