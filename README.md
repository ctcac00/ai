# Harness Configuration

This repo holds my custom Claude Code skills + hooks (installable as a plugin) and per-harness settings files (deployed via `install.sh`).

Harnesses I use: claude-code, codex, opencode, pi, oh-my-pi.

## 1. Claude Code plugin (skills + hooks)

`install.sh` handles this automatically. To install manually:

```bash
claude plugin marketplace add ctcac00/ai
claude plugin install agentic-workflow
```

Dev/test without installing:

```bash
claude --plugin-dir /path/to/agentic-workflow
# then /reload-plugins, invoke e.g. agentic-workflow:fix-open-issue
```

Validate:

```bash
claude plugin validate /path/to/agentic-workflow --strict
```

What the plugin owns: the entire `skills/` tree. The `rtk` PreToolUse hook is installed separately via `rtk init -g`.

## 2. install.sh (per-harness settings)

Installs harness binaries, copies `.claude/`, `.codex/`, `.pi/`, `.omp/`, `.config/opencode/` to their home locations, installs the `agentic-workflow` Claude plugin and pi package, langfuse, caveman, and runs `rtk init` per harness.

```bash
./install.sh              # all harnesses
./install.sh claude       # one: claude | codex | pi | omp | opencode
./install.sh --dry-run    # dry run, write nothing
./install.sh --no-self-claude  # skip agentic-workflow claude plugin install
./install.sh --no-self-pi      # skip agentic-workflow pi package install
./install.sh --no-rtk     # skip rtk install/init
./install.sh --no-langfuse
./install.sh --no-caveman
./install.sh --no-extra-skills
```

Also installs [find-skills](https://github.com/vercel-labs/skills) and [skill-creator](https://github.com/anthropics/skills) globally (`npx skills add ... -g -y`, no prompts — skills.sh's own default agent fan-out), and registers the `anthropics/skills` marketplace for claude-code (`claude plugin marketplace add anthropics/skills`, source only — no plugin installed from it).

- Custom pi extensions live at top-level **`extensions/`** (langfuse, leader-key, pi-context-probe, sub-usage, plus shared TS extensions such as todos, prompt-editor, which-key, session-breakdown, tool-manager, rtk, file-backup, files, night-owl-footer). They ship via the **pi-package** model — `package.json` declares `pi.extensions`/`pi.skills`/`pi.themes` and `pi install git:github.com/ctcac00/ai` installs them (build artifacts included), rather than being rsynced from `.pi/agent/extensions/`.
- Pre-flight warnings (non-fatal) for `node` and `jq`.
- `.pi/agent/settings.json` has a `pi-memory-md.memoryDir.repoUrl` placeholder (`<your-username>/memory`) — point it at your own memory repo before use.

### Skills I use (global)

- find-skills - skill.sh skills finder
- skill-creator - to create new skills
- caveman - for terse communication with LLMs

## 3. External dependencies

Not vendored — assumed present:

- **langfuse** — tracing. Install per harness ([docs](https://langfuse.com/integrations/developer-tools/claude-code)):
  - **claude-code**: `claude plugin marketplace add langfuse/Claude-Observability-Plugin && claude plugin install langfuse/Claude-Observability-Plugin`
  - **codex** (Node 22+, Codex 0.128+): `codex plugin marketplace add langfuse/codex-observability-plugin`, then in `~/.codex/config.toml`: `[features] plugin_hooks = true` + `[plugins."tracing@codex-observability-plugin"] enabled = true`
  - **opencode**: `{ "experimental": { "openTelemetry": true }, "plugin": ["@langfuse/opencode-observability-plugin@latest"] }`
  - **pi / oh-my-pi**: `pi extension add pi-langfuse`
- **rtk** — [rust-token-killer](https://github.com/rtk-ai/rtk); called by the PreToolUse hook.
- **caveman** — [terse-communication skill](https://github.com/JuliusBrussee/caveman).

Langfuse reads credentials from env vars — set in your shell profile:

```bash
export LANGFUSE_PUBLIC_KEY="pk-lf-..."
export LANGFUSE_SECRET_KEY="sk-lf-..."
export LANGFUSE_BASE_URL="https://cloud.langfuse.com" # EU; us./jp./hipaa. for other regions
export TRACE_TO_LANGFUSE="true"   # codex opt-in
```

## 4. Project-level config

At a project level I use a variety of additional plugins, skills, and MCP servers, configured per-repo rather than globally. Example below is from a React Native mobile app.

### Skills

| Skill                            | Path                                              | Agents                                       |
| --------------------------------- | ------------------------------------------------- | --------------------------------------------- |
| codebase-design                  | `.agents/skills/codebase-design`                  | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| diagnosing-bugs                  | `.agents/skills/diagnosing-bugs`                  | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| domain-modeling                  | `.agents/skills/domain-modeling`                  | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| handoff                          | `.agents/skills/handoff`                          | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| implement                        | `.agents/skills/implement`                        | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| improve-codebase-architecture    | `.agents/skills/improve-codebase-architecture`    | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| interview                        | `.agents/skills/interview`                        | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| supabase                         | `.agents/skills/supabase`                         | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| supabase-postgres-best-practices | `.agents/skills/supabase-postgres-best-practices` | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| to-issues                        | `.agents/skills/to-issues`                        | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| to-prd                           | `.agents/skills/to-prd`                           | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| triage                           | `.agents/skills/triage`                           | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-composition-patterns      | `.agents/skills/vercel-composition-patterns`      | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-react-best-practices      | `.agents/skills/vercel-react-best-practices`      | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-react-native-skills       | `.agents/skills/vercel-react-native-skills`       | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-react-view-transitions    | `.agents/skills/vercel-react-view-transitions`    | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| web-design-guidelines            | `.agents/skills/web-design-guidelines`            | Claude Code, Codex, Gemini CLI, OpenCode, Pi |

The third-party skills (in `.agents/skills/`) are installed via [skills.sh](https://skills.sh). My own custom skills (`cleanup-stale-branches`, `validate-ui`, `fix-open-issue`, the PR-feedback skills, etc.) are **not** per-project — they ship globally from the `agentic-workflow` plugin/pi-package `skills/` tree (see §1), so they don't appear in a project's `.claude/skills/`.

The skills originally from Matt Pocock's `mattpocock/skills` collection (`codebase-design`, `handoff`, `triage`, `to-issues`, `to-prd`, etc.) are no longer installed separately — customised versions are vendored in this repo's `skills/engineering/` tree and ship with the `agentic-workflow` plugin. Some were renamed or merged along the way: `tdd` → `implement`; `grill-me`, `grill-with-docs`, and `grilling` merged into `interview`. `prototype` was dropped entirely, with no replacement. Credit to Matt Pocock for the originals.

The tree has since grown beyond those originals. `agent-loop` and `agent-loop-stacking` were replaced by **`fix-open-issue`**. Additional custom skills now ship here: `address-pr-feedback` and `pr-feedback-audit` (PR-review workflow), `okf` (plus `validate` and `visualize`) for Open-Knowledge-Format bundles, `update-changelog`, `cleanup-stale-branches`, and `validate-ui`.

```bash
# Vercel's skills (react, composition patterns, view transitions)
npx skills add vercel-labs/agent-skills

# Supabase skills
npx skills add supabase/agent-skills
```

### Claude Code plugins

```json
{
  "enabledPlugins": {
    "revenuecat@claude-plugins-official": true,
    "expo@expo-plugins": true,
    "cloudflare@cloudflare": true,
    "RevenueCat@RevenueCat": true,
    "vercel@claude-plugins-official": true,
    "supabase@claude-plugins-official": true,
    "typescript-lsp@claude-plugins-official": true
  },
  "extraKnownMarketplaces": {
    "cloudflare": {
      "source": {
        "source": "github",
        "repo": "cloudflare/skills"
      }
    },
    "expo-plugins": {
      "source": {
        "source": "github",
        "repo": "expo/skills"
      }
    },
    "RevenueCat": {
      "source": {
        "source": "github",
        "repo": "RevenueCat/ai-toolkit"
      }
    }
  }
}
```

### MCP servers

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--browser",
        "chromium",
        "--output-dir",
        "./playwright-screenshots"
      ]
    },
    "supabase": {
      "type": "http",
      "url": "https://mcp.supabase.com/mcp?project_ref=<PROJECT_REF>"
    },
    "Sentry": {
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp/<ORG>/<PROJECT>"
    }
  }
}
```
