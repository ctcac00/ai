#!/usr/bin/env bash

input=$(cat)
model=$(echo "$input" | jq -r '.model.display_name')
tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
cost=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')

cost_fmt=$(printf '%.2f' "$cost")

# Night Owl palette
DIM="\033[38;2;99;119;119m"      # comment gray #637777
GREEN="\033[38;2;173;219;103m"   # #addb67
YELLOW="\033[38;2;236;196;141m"  # #ecc48d
ORANGE_RED="\033[38;2;239;83;80m" # #ef5350
PURPLE="\033[38;2;199;146;234m"  # #c792ea
RST="\033[0m"

pct_precise=$(echo "$input" | jq -r '
    (.context_window.total_input_tokens // 0) as $t
    | (.context_window.context_window_size // 0) as $s
    | if $s > 0 then ($t / $s * 100) else 0 end
' | xargs printf '%.1f')

if [ "$tokens" -lt 1000 ]; then
    tokens_fmt="$tokens"
elif [ "$tokens" -lt 1000000 ]; then
    tokens_fmt=$(echo "$tokens" | awk '{printf "%.1fk", $1/1000}')
else
    tokens_fmt=$(echo "$tokens" | awk '{printf "%.1fM", $1/1000000}')
fi

if [ "$tokens" -ge 100000 ]; then pct_color="$ORANGE_RED"
elif [ "$tokens" -ge 50000 ]; then pct_color="$YELLOW"
else pct_color="$GREEN"; fi

out="${pct_color}${tokens_fmt}${RST} ${DIM}(${RST}${pct_color}${pct_precise}%${RST}${DIM})${RST}"
out="${out} ${DIM}·${RST} ${YELLOW}\$${cost_fmt}${RST}"

effort=$(echo "$input" | jq -r '.effort.level // empty')
if [ -n "$effort" ]; then
    out="${out} ${DIM}·${RST} ${PURPLE}${model} [${effort}]${RST}"
else
    out="${out} ${DIM}·${RST} ${PURPLE}${model}${RST}"
fi

printf "%b" "$out"
