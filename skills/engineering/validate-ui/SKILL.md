---
name: validate-ui
description: Validate a code change or PR by testing UI behavior — Playwright for web-testable features, Android emulator (Linux) or iOS simulator (macOS) for native features. Use when asked to validate, verify, or QA a change; confirm a fix works in the app; or test a native feature before shipping.
---

# validate-ui

Validate a code change by observing real app behavior, not just running tests.

## Decision Tree

1. **Determine what changed** — read the diff/PR description.
2. **Choose validation path:**
   - Web UI or Expo web target → Playwright
   - Native feature (notifications, camera, deep links, badges, etc.) → emulator/simulator
   - Both → do both

## Path A: Playwright (web-testable)

Use Playwright MCP tools (`mcp__playwright__*`) to navigate, interact, and take screenshots.

Bias toward action: navigate to the relevant screen, exercise the changed flow, capture a screenshot as evidence.

## Path B: Native — detect platform first

```bash
uname  # Linux → Android emulator; Darwin → iOS simulator
```

**Linux → Android:** See `references/android.md` for full commands.

Summary:
1. Check if emulator already running: `adb devices`
2. If not running, start it (see android.md)
3. Copy `.env` if in a worktree: `cp $(git rev-parse --show-toplevel)/../main/app/.env* ./app/` (replace `main` with the actual main worktree name if different)
4. Build and run:
   ```bash
   SERIAL=$(adb devices | awk '/emulator-[0-9]+[[:space:]]+device/{print $1; exit}')
   AVD=$(adb -s "$SERIAL" emu avd name | head -1 | tr -d '\r')
   cd app && npx expo run:android --device "$AVD"
   ```
5. Capture screenshot: `adb shell screencap /sdcard/screen.png && adb pull /sdcard/screen.png /tmp/screen.png`
6. Show screenshot to user with SendUserFile

**Tapping UI elements:** Always use UIAutomator for device-space coordinates — never estimate from screenshot pixels.
```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/ui.xml
grep -o 'text="[^"]*" .*bounds="[^"]*"' /tmp/ui.xml  # find element by text
# bounds="[x1,y1][x2,y2]" → tap center: adb shell input tap $((x1+x2)/2) $((y1+y2)/2)
```

**macOS → iOS:**
1. `cd app && npx expo run:ios`
2. Simulator launches automatically
3. Use `xcrun simctl io booted screenshot /tmp/screen.png` for screenshot evidence

## Output

Always provide visual evidence (screenshot) and a short verdict: what was tested, what was observed, pass/fail.
