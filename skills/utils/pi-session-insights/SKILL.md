---
name: pi-session-insights
description: Analyze pi session history to find errors, corrections, and patterns. Produces a markdown report with actionable suggestions to improve model accuracy via AGENTS.md or memory entries.
---

# Pi Session Insights

Analyze your pi session history and produce a markdown report with actionable insights.

## What it detects

- **User corrections** — times you corrected, reverted, or redirected the model
- **Bash errors** — failed shell commands with error categorization
- **Fetch/search errors** — failed web requests
- **Repeated tool calls** — model calling the same tool rapidly (struggling)
- **File churn** — files edited many times in quick succession
- **Context compactions** — sessions hitting context limits
- **High error rate sessions** — sessions with unusually high failure rates

## Usage

Run the analysis script and present the report to the user:

```bash
npx tsx <skill-dir>/scripts/analyze.ts --days 7
```

### Options

| Flag | Description | Default |
| --- | --- | --- |
| `--days N` | Analyze last N days | 7 |
| `--from YYYY-MM-DD` | Start date | 7 days ago |
| `--to YYYY-MM-DD` | End date | today |
| `--dir PATH` | Custom sessions directory | `~/.pi/agent/sessions` |

Examples:

```bash
# Last 30 days
npx tsx <skill-dir>/scripts/analyze.ts --days 30

# Specific date range
npx tsx <skill-dir>/scripts/analyze.ts --from 2026-04-01 --to 2026-05-01

# Last 3 days, current session (this is the one the user is in right now)
npx tsx <skill-dir>/scripts/analyze.ts --days 3
```

## After generating the report

1. **Present the report** to the user — they'll see the full markdown output
2. **Highlight the top suggestions** — focus on the "💡 Top Suggestions" section
3. **Offer to act** — ask if they want to:
   - Save the report to a file (e.g. `~/.pi/agent/insights-report.md`)
   - Add detected constraints to their AGENTS.md
   - Create memory entries from recurring patterns
   - Update AGENTS.md with specific rules that would prevent recurring errors

## Important notes

- `<skill-dir>` resolves to the directory containing this SKILL.md file
- The script is **read-only** — it only scans session files, never modifies them
- Subagent sessions under `~/.pi/agent/sessions/subagents/` are excluded automatically
- Sessions with zero user messages are skipped
