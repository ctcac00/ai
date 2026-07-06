---
name: validate-ui
description: Validate a code change or PR by testing UI behavior — Playwright for web-testable features, Maestro/Android emulator (Linux) or iOS simulator (macOS) for native features. Use when asked to validate, verify, or QA a change; confirm a fix works in the app; test a native feature before shipping; or run the full UI regression pack before a release.
---

# validate-ui

Validate a code change by observing real app behavior, not just running tests.

## Args

- No arg → targeted validation of the current diff/PR (this doc).
- `regression-pack` → full release-gate suite (Playwright web + Maestro Android). See `references/regression-pack.md` and stop reading here.

## Decision Tree

1. **Determine what changed** — read the diff/PR description.
2. **Choose validation path:**
   - Web UI or Expo web target → Playwright
   - Native feature (notifications, camera, deep links, badges, etc.) → Maestro flow, or emulator/simulator if no flow fits
   - Both → do both

## Path A: Playwright (web-testable)

Use Playwright MCP tools (`mcp__playwright__*`) to navigate, interact, and take screenshots.

Bias toward action: navigate to the relevant screen, exercise the changed flow, capture a screenshot as evidence.

## Path B: Native — prefer Maestro over manual driving

Maestro flows are deterministic and don't need screenshot-by-screenshot LLM interpretation — prefer them over manually driving the emulator whenever a flow covers the changed area.

1. Check `app/.maestro/**/*.yaml` for an existing flow covering the change.
2. **Flow exists:** run it — `maestro test app/.maestro/<path>.yaml` (see `references/regression-pack.md` for env var setup and release-build prereqs if the flow needs the signed-in test account).
3. **No flow exists:** author a minimal one-off flow for this validation, run it, and **flag in the final verdict** that no flow existed and one was created ad hoc — recommend the PR author commit a proper version of it.
4. **Visual-only check** (layout/pixel issues Maestro assertions can't express) → fall back to manual emulator/simulator + screenshot:
   - Linux → Android: see `references/android.md`.
   - macOS → iOS:
     1. `cd app && npx expo run:ios`
     2. Simulator launches automatically
     3. `xcrun simctl io booted screenshot /tmp/screen.png` for screenshot evidence

**Tapping UI elements manually** (fallback path only): always use UIAutomator for device-space coordinates — never estimate from screenshot pixels.
```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/ui.xml
grep -o 'text="[^"]*" .*bounds="[^"]*"' /tmp/ui.xml  # find element by text
# bounds="[x1,y1][x2,y2]" → tap center: adb shell input tap $((x1+x2)/2) $((y1+y2)/2)
```

## Output

Always provide evidence (Maestro pass/fail output, or screenshot for manual/Playwright paths) and a short verdict: what was tested, what was observed, pass/fail. If a one-off Maestro flow was created, call that out explicitly.
