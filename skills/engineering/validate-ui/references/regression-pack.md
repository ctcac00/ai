# UI Regression Pack

Full release-gate suite: Playwright (web) + Maestro (Android). Not wired into CI — see #290. Run before every release.

## Web (Playwright)

```bash
cd website && npm run e2e
```

## Android (Maestro)

### Prerequisites

- **JAVA_HOME must point to temurin-17**, not whatever's default in the shell. The project pins Java via asdf (`app/.tool-versions` → `java temurin-17.0.11+9`), but a global `JAVA_HOME` (e.g. `java-21-openjdk`) can shadow it and break both Gradle and Maestro's instrumentation driver.
  ```bash
  export JAVA_HOME="$(asdf where java)"
  ```
- **Release build required, not the dev client.** `expo run:android` builds the dev client (includes `expo-dev-launcher`). Maestro flows use `launchApp: { clearState: true }`, and on every launch the dev-launcher shows its server picker instead of opening the app — it never auto-opens the last server. Flows will fail at the first assertion. Build and install the release variant instead:
  ```bash
  cd app && npm run build:android:release-maestro
  ```
  This script sets `JAVA_HOME` via asdf, disables Sentry's sourcemap auto-upload (`SENTRY_DISABLE_AUTO_UPLOAD=true` — local shells don't have `SENTRY_AUTH_TOKEN`, so the upload step fails without this), scopes the native build to `x86_64` only (building all ABIs concurrently can segfault clang under memory pressure), and installs the resulting APK.
- **One-time test-account onboarding bootstrap.** The pack's normal exclude tags assume the shared test account is already onboarded (`requires-unonboarded-session` is excluded from normal runs). If sign-in succeeds but lands on the welcome journey instead of "Today", the account needs onboarding once — it's server-side and persists after:
  ```bash
  # sign in first so the onboarding stack is showing, then:
  maestro test app/.maestro/auth/onboarding-flow.yaml -e TEST_EMAIL="$TEST_EMAIL" -e TEST_PASSWORD="$TEST_PASSWORD"
  ```

### Running the pack

```bash
set -a; . ./app/.env; set +a
maestro test -e TEST_EMAIL="$TEST_EMAIL" -e TEST_PASSWORD="$TEST_PASSWORD" ./app/.maestro
```

(or `npm run e2e:android` from `app/` for flows that don't need the test account)

Kill any stale `maestro` server before running — a leftover server from a prior run can leave `${TEST_EMAIL}` unresolved (`undefined`) even when the env vars are set correctly this time.

Flows sign in with the shared test account and clean up what they create (delete added plants/spaces) where practical. `app/.maestro/paywall-settings/delete-account.yaml` is destructive and excluded from normal runs — only run it manually against a disposable account. Android only for v1; iOS Maestro coverage is a follow-up.

### Known hazard: emulator userdata corruption after a hypervisor change

**Symptom:** every 3rd-party app launch fails — `am start -n`, `monkey`, scheme intents, `cmd package resolve-activity` all report "Activity class does not exist" / "No activity found" — even though `dumpsys package` lists the components correctly. System apps (Settings) still launch fine.

**Cause:** if the emulator log shows `"The emulator is starting from scratch. Reason: host hypervisor has changed"`, the persisted userdata became inconsistent with the current virtualization. `adb reboot` does not fix it.

**Fix:** wipe emulator data (this removes installed apps — Maestro's companion app and the release APK will need reinstalling). Derive the AVD name dynamically — it varies by machine:
```bash
AVD=$(emulator -list-avds | head -1)  # or name it explicitly if multiple AVDs exist
emulator -avd "$AVD" -wipe-data
```
