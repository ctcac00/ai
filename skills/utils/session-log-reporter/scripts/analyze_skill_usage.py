#!/usr/bin/env python3
"""
Parses ~/.claude/projects JSONL session files to report Skill tool usage.
Outputs a markdown report grouped by project.

Usage:
    python analyze_skill_usage.py [--project <name>] [--days <N>]
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--project", help="Filter to a single project name (partial match, case-insensitive)")
    p.add_argument("--days", type=int, help="Only include sessions from the last N days")
    p.add_argument("--projects-dir", default=os.path.expanduser("~/.claude/projects"),
                   help="Path to Claude projects directory")
    return p.parse_args()


def iter_jsonl(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    continue


def project_name_from_cwd(cwd):
    if not cwd:
        return "unknown"
    return Path(cwd).name


def cutoff_dt(days):
    if days is None:
        return None
    return datetime.now(timezone.utc) - timedelta(days=days)


def parse_ts(ts_str):
    if not ts_str:
        return None
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except ValueError:
        return None


def extract_text_from_content(content):
    """Return plain text from a message content field (str or list of blocks)."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                return part["text"].strip()
    return ""


def find_direct_skill_invocations(entries):
    """
    Scan user messages for slash-command skill invocations.
    A slash command is a skill (not a builtin) when the immediately following
    user entry contains 'Base directory for this skill:'.
    Yields (skill_name, example_prompt) tuples.
    """
    for i, entry in enumerate(entries):
        if entry.get("type") != "user":
            continue
        content = entry.get("message", {}).get("content", "")
        text = extract_text_from_content(content)
        m = re.search(r"<command-name>(/[^<]+)</command-name>", text)
        if not m:
            continue
        cmd = m.group(1).strip()
        skill_name = cmd.lstrip("/")

        # Check if the next user entry injects skill context
        is_skill = False
        for j in range(i + 1, min(i + 4, len(entries))):
            nxt = entries[j]
            if nxt.get("type") != "user":
                continue
            nxt_text = extract_text_from_content(nxt.get("message", {}).get("content", ""))
            if "Base directory for this skill:" in nxt_text:
                is_skill = True
            break

        if not is_skill:
            continue

        args_m = re.search(r"<command-args>([^<]*)</command-args>", text)
        args = args_m.group(1).strip() if args_m else ""
        example = args[:120] if args else cmd

        yield skill_name, example


def analyze(projects_dir, project_filter=None, days=None):
    """
    Returns a dict keyed by project name:
      {
        "plant-care": {
          "sessions": 12,
          "skill_sessions": 3,
          "skills": {
            "commit-commands:commit": {
              "count": 5,
              "user_invoked": 2,
              "claude_activated": 3,
              "examples": ["commit this", "ok commit it", ...]
            }
          }
        }
      }
    """
    cutoff = cutoff_dt(days)
    results = defaultdict(lambda: {
        "sessions": 0,
        "skill_sessions": 0,
        "skills": defaultdict(lambda: {"count": 0, "user_invoked": 0, "claude_activated": 0, "examples": []})
    })

    projects_path = Path(projects_dir)
    if not projects_path.exists():
        print(f"ERROR: Projects directory not found: {projects_dir}", file=sys.stderr)
        sys.exit(1)

    for jsonl_file in sorted(projects_path.rglob("*.jsonl")):
        entries = list(iter_jsonl(jsonl_file))
        if not entries:
            continue

        # Get session cwd (from first user entry with cwd set)
        cwd = None
        session_ts = None
        for e in entries:
            if e.get("cwd") and not cwd:
                cwd = e["cwd"]
            if e.get("timestamp") and not session_ts:
                session_ts = parse_ts(e["timestamp"])
            if cwd and session_ts:
                break

        # Apply date filter
        if cutoff and session_ts and session_ts < cutoff:
            continue

        proj = project_name_from_cwd(cwd)

        # Apply project filter
        if project_filter and project_filter.lower() not in proj.lower():
            continue

        results[proj]["sessions"] += 1

        # Find all Skill tool calls (assistant-invoked) and direct slash invocations
        skill_calls_found = False

        for i, entry in enumerate(entries):
            if entry.get("type") != "assistant":
                continue
            content = entry.get("message", {}).get("content", [])
            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "tool_use" and item.get("name") == "Skill":
                    skill_name = item.get("input", {}).get("skill", "unknown")
                    skill_calls_found = True

                    # Find the closest preceding user text message
                    user_prompt = ""
                    for j in range(i - 1, max(i - 10, -1), -1):
                        prev = entries[j]
                        if prev.get("type") == "user":
                            msg = prev.get("message", {})
                            c = msg.get("content", "")
                            if isinstance(c, str):
                                user_prompt = c.strip()
                            elif isinstance(c, list):
                                for part in c:
                                    if isinstance(part, dict) and part.get("type") == "text":
                                        txt = part["text"].strip()
                                        if not txt.startswith("Base directory for this skill:") and \
                                           not txt.startswith("## Context"):
                                            user_prompt = txt
                                            break
                            if user_prompt:
                                break

                    skill_data = results[proj]["skills"][skill_name]
                    skill_data["count"] += 1
                    skill_data["claude_activated"] += 1
                    if user_prompt and user_prompt not in skill_data["examples"]:
                        if len(skill_data["examples"]) < 3:
                            skill_data["examples"].append(user_prompt[:120])

        # Direct slash-command skill invocations (user typed /skill-name)
        for skill_name, example in find_direct_skill_invocations(entries):
            skill_calls_found = True
            skill_data = results[proj]["skills"][skill_name]
            skill_data["count"] += 1
            skill_data["user_invoked"] += 1
            if example and example not in skill_data["examples"]:
                if len(skill_data["examples"]) < 3:
                    skill_data["examples"].append(example)

        if skill_calls_found:
            results[proj]["skill_sessions"] += 1

    return results


def render_markdown(results, project_filter=None, days=None):
    lines = []
    title = "# Skill Usage Report"
    if project_filter:
        title += f" — {project_filter}"
    lines.append(title)
    lines.append("")

    # Subtitle
    subtitle_parts = []
    if days:
        subtitle_parts.append(f"Last {days} days")
    else:
        subtitle_parts.append("All time")
    lines.append(f"*{' · '.join(subtitle_parts)}*")
    lines.append("")

    if not results:
        lines.append("No skill usage found.")
        return "\n".join(lines)

    # Sort projects: those with skill usage first, then by name
    sorted_projects = sorted(
        results.items(),
        key=lambda kv: (-kv[1]["skill_sessions"], kv[0])
    )

    # Summary table
    lines.append("## Summary")
    lines.append("")
    lines.append("| Project | Sessions | Sessions with Skills | Total | User-invoked | Claude-activated |")
    lines.append("|---------|----------|---------------------|-------|--------------|-----------------|")
    for proj, data in sorted_projects:
        total_calls = sum(s["count"] for s in data["skills"].values())
        user_total = sum(s["user_invoked"] for s in data["skills"].values())
        claude_total = sum(s["claude_activated"] for s in data["skills"].values())
        lines.append(f"| {proj} | {data['sessions']} | {data['skill_sessions']} | {total_calls} | {user_total} | {claude_total} |")
    lines.append("")

    # Per-project detail sections
    for proj, data in sorted_projects:
        if not data["skills"]:
            continue

        lines.append(f"## {proj}")
        lines.append("")

        total_calls = sum(s["count"] for s in data["skills"].values())
        lines.append(f"**{total_calls} skill call{'s' if total_calls != 1 else ''}** across "
                     f"**{data['skill_sessions']} session{'s' if data['skill_sessions'] != 1 else ''}**")
        lines.append("")

        # Sort skills by usage count descending
        sorted_skills = sorted(data["skills"].items(), key=lambda kv: -kv[1]["count"])

        for skill_name, skill_data in sorted_skills:
            count = skill_data["count"]
            user_invoked = skill_data["user_invoked"]
            claude_activated = skill_data["claude_activated"]
            examples = skill_data["examples"]
            lines.append(f"### `{skill_name}`")
            count_str = f"Used **{count}** time{'s' if count != 1 else ''}"
            if user_invoked and claude_activated:
                count_str += f" — {user_invoked} user-invoked, {claude_activated} claude-activated"
            elif user_invoked:
                count_str += " — user-invoked"
            elif claude_activated:
                count_str += " — claude-activated"
            lines.append(count_str)
            if examples:
                lines.append("")
                lines.append("Example prompts that triggered it:")
                for ex in examples:
                    lines.append(f'- *"{ex}"*')
            lines.append("")

    return "\n".join(lines)


def main():
    args = parse_args()
    results = analyze(args.projects_dir, project_filter=args.project, days=args.days)
    report = render_markdown(results, project_filter=args.project, days=args.days)
    print(report)


if __name__ == "__main__":
    main()
