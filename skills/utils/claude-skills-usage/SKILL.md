---
name: claude-skills-usage
description: "Generates a markdown report of Claude Code skill usage across all projects by parsing session logs in ~/.claude/projects. Use this skill whenever the user asks about skill usage stats, which skills they've used, how often a skill was invoked, skill usage by project, or wants a session report or activity summary. Also trigger it when the user asks things like \"what skills have I been using?\", \"show me my skill usage\", \"skill report for my-project\", or \"how many times did I use commit-commands\"."
---

# Claude Skills Usage

This skill parses Claude Code session logs and produces a nicely formatted markdown
report showing which skills were used, how often, and in what context — broken down
by project.

## When invoked

The user will say something like:

- "show me my skill usage report"
- "what skills have I been using in plant-care?"
- "skill usage for the last 30 days"
- "how often did I use commit-commands?"

## How to run the report

Run the bundled script. It reads `~/.claude/projects/**/*.jsonl`, finds every `Skill`
tool call in assistant messages, and groups results by project (derived from the `cwd`
of the session).

```bash
python <skill_dir>/scripts/analyze_skill_usage.py [OPTIONS]
```

Available options:

- `--project <name>` — filter to a single project (partial match, case-insensitive). Use this when the user mentions a specific project.
- `--days <N>` — only include sessions from the last N days
- `--projects-dir <path>` — override the default `~/.claude/projects` location

**Always use the `<skill_dir>` variable** — the skill directory path is provided in the
skill invocation context as "Base directory for this skill: `<path>`". Use that path
to locate the script, e.g.:

```bash
python /home/user/.claude/skills/claude-skills-usage/scripts/analyze_skill_usage.py
```

## What to do with the output

Always write the report to `/tmp/skill-usage-report.md` using the Write tool. Then
print the markdown output in the conversation as well.

After writing the file, tell the user:
> "Report saved to `/tmp/skill-usage-report.md`. This file is ephemeral — it will be
> lost on reboot. Copy it to a permanent location if you want to keep it."

If the user asks about a specific project, pass `--project <project-name>` to scope the
report.

If the user mentions a time range like "last week" or "past month", convert it to days
and pass `--days <N>`.

## Report structure

The script outputs:

1. **Summary table** — all projects with session counts, skill-session counts, and total
   skill calls at a glance
2. **Per-project sections** — one section per project that actually used skills, listing:
   - Each skill invoked
   - How many times it was called
   - Up to 3 example user prompts that triggered it

Projects with no skill usage still appear in the summary table but are omitted from
the detail sections to keep the report focused.
