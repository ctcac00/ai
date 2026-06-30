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
# then /reload-plugins, invoke e.g. agentic-workflow:agent-loop
```

Validate:

```bash
claude plugin validate /path/to/agentic-workflow --strict
```

What the plugin owns: the `skills/` tree (all 8 skills). The `rtk` PreToolUse hook is installed separately via `rtk init -g`.

## 2. install.sh (per-harness settings)

Installs harness binaries, copies `.claude/`, `.codex/`, `.pi/`, `.omp/`, `.config/opencode/` to their home locations, installs the `agentic-workflow` plugin, langfuse, caveman, and runs `rtk init` per harness.

```bash
./install.sh              # all harnesses
./install.sh claude       # one: claude | codex | pi | omp | opencode
./install.sh --dry-run    # dry run, write nothing
./install.sh --no-rtk     # skip rtk install/init
./install.sh --no-langfuse
./install.sh --no-caveman
./install.sh --no-extra-skills
```

Also installs [find-skills](https://github.com/vercel-labs/skills) and [skill-creator](https://github.com/anthropics/skills) globally for all agents (`npx skills add ... --agent '*' -g -y`, no prompts — symlinked into `~/.agents/skills` and synced out to every harness skills.sh supports), and registers the `anthropics/skills` marketplace for claude-code (`claude plugin marketplace add anthropics/skills`, source only — no plugin installed from it).

- `.pi/agent/extensions/` (custom langfuse + leader-key + sub-usage + pi-context-probe TS extensions) copied verbatim, including build artifacts.
- Pre-flight warnings (non-fatal) for `node` and `jq`.
- `.pi/agent/settings.json` has a `pi-memory-md.memoryDir.repoUrl` placeholder (`<your-username>/memory`) — point it at your own memory repo before use.

### Skills I use (global)

- find-skills - skill.sh skills finder
- skill-creator - to create new skills
- mattpocock/skills - a collection of agentic workflow skills
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
| grill-me                         | `.agents/skills/grill-me`                         | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| grill-with-docs                  | `.agents/skills/grill-with-docs`                  | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| grilling                         | `.agents/skills/grilling`                         | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| handoff                          | `.agents/skills/handoff`                          | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| improve-codebase-architecture    | `.agents/skills/improve-codebase-architecture`    | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| prototype                        | `.agents/skills/prototype`                        | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| supabase                         | `.agents/skills/supabase`                         | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| supabase-postgres-best-practices | `.agents/skills/supabase-postgres-best-practices` | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| tdd                              | `.agents/skills/tdd`                              | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| to-issues                        | `.agents/skills/to-issues`                        | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| to-prd                           | `.agents/skills/to-prd`                           | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| triage                           | `.agents/skills/triage`                           | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-composition-patterns      | `.agents/skills/vercel-composition-patterns`      | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-react-best-practices      | `.agents/skills/vercel-react-best-practices`      | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-react-native-skills       | `.agents/skills/vercel-react-native-skills`       | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| vercel-react-view-transitions    | `.agents/skills/vercel-react-view-transitions`    | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| web-design-guidelines            | `.agents/skills/web-design-guidelines`            | Claude Code, Codex, Gemini CLI, OpenCode, Pi |
| agent-loop                       | `.claude/skills/agent-loop`                       | Claude Code                                  |
| agent-loop-stacking              | `.claude/skills/agent-loop-stacking`              | Claude Code                                  |
| cleanup-stale-branches           | `.claude/skills/cleanup-stale-branches`           | Claude Code                                  |
| pr-housekeeping                  | `.claude/skills/pr-housekeeping`                  | Claude Code                                  |
| validate-ui                      | `.claude/skills/validate-ui`                      | Claude Code                                  |

The third-party skills (in `.agents/skills/`) are installed via [skills.sh](https://skills.sh). Skills under `.claude/skills/` are custom skills I've written and committed to this repo — they don't need installing.

```bash
# Matt Pocock's collection (codebase-design, tdd, handoff, etc.)
npx skills add mattpocock/skills

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
