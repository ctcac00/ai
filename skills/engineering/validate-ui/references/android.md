# Android Emulator Reference

API 33 (Android 13) | x86_64 | Device: Pixel 3a. AVD name varies by machine — always derive dynamically (see Build and run).

## Prerequisites

- KVM enabled and user in `kvm` group (`groups $USER | grep kvm`)
- Java 21: `sudo apt install -y openjdk-21-jdk`
- Android SDK at `~/Android/Sdk` (see First-time Setup if missing)
- `~/.zshrc` exports `ANDROID_HOME`, `JAVA_HOME`, `PATH`

## First-time Setup

```bash
# 1. Download cmdline-tools
mkdir -p ~/Android/Sdk/cmdline-tools
curl -L -o /tmp/cmdline-tools.zip \
  "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
cd ~/Android/Sdk/cmdline-tools && unzip -q /tmp/cmdline-tools.zip
mv cmdline-tools latest && rm /tmp/cmdline-tools.zip

# 2. Install SDK components (~2.5GB)
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-33" "build-tools;33.0.2" \
  "system-images;android-33;google_apis;x86_64" "emulator"

# 3. Create AVD
echo "no" | avdmanager create avd \
  -n verdant_test \
  -k "system-images;android-33;google_apis;x86_64" \
  -d pixel_3a
```

## Check if already running

```bash
adb devices
# emulator-5554   device  → already up, skip to Build and run
```

## Pre-flight (low-memory machines)

```bash
# One-time only — increase inotify watches (tsserver eats ~36k of the 57k default)
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p

# Kill tsserver to free watches for Metro (restarts automatically)
pkill -f tsserver || true

# Free page cache before Gradle
sync && echo 3 | sudo tee /proc/sys/vm/drop_caches
```

## Start emulator

```bash
AVD=$(emulator -list-avds | head -1)  # or name it explicitly if multiple AVDs exist
nohup sg kvm -c "emulator -avd $AVD -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -cores 2" \
  > /tmp/emulator.log 2>&1 &

# Wait for boot (~50s)
adb wait-for-device && \
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 3; done && \
  echo "Ready"
```

`sg kvm` is required — Claude Code sessions don't inherit the kvm group.

## Verify

```bash
adb devices                              # emulator-5554  device
adb shell getprop ro.build.version.sdk  # 33
```

## Env files (worktrees)

`.env` is gitignored and absent from new worktrees. Copy before starting Metro:

```bash
cp "$(git worktree list | grep '\[main\]' | awk '{print $1}')/app/".env* ./app/
```

## Build and run

```bash
# Derive serial and AVD name dynamically — both can vary across machines/sessions
SERIAL=$(adb devices | awk '/emulator-[0-9]+[[:space:]]+device/{print $1; exit}')
AVD=$(adb -s "$SERIAL" emu avd name | head -1 | tr -d '\r')
cd app && npx expo run:android --device "$AVD"
```

`--device` takes the **AVD name**, not the ADB serial. Using the serial produces "Could not find device with name: emulator-XXXX" even when the emulator is attached. Always derive both values dynamically — never hardcode either.

First build: 15–20 min (memory constrained) or ~5 min (ample RAM). Subsequent builds are fast.

Keep the emulator alive during builds — OOM can kill it. Check `adb devices` after build completes.

## Package name

`com.lusoquantum.verdant`  — used in `adb shell appops`, `pm clear`, deep links, etc.

## Tapping UI elements

Never estimate tap coordinates from screenshot pixels — the displayed image is smaller than the device. Use UIAutomator to get exact device-space bounds:

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml /tmp/ui.xml
grep -oP 'text="\K[^"]+(?="[^>]*bounds="\[\d+,\d+\]\[\d+,\d+\]")' /tmp/ui.xml  # find text near bounds
# Or simpler — search raw XML:
grep -o 'text="Sign in"[^>]*bounds="[^"]*"' /tmp/ui.xml
# bounds="[x1,y1][x2,y2]" → tap center:
adb shell input tap $((( x1 + x2 ) / 2)) $((( y1 + y2 ) / 2))
```

## Screenshot

```bash
adb shell screencap /sdcard/screen.png && adb pull /sdcard/screen.png /tmp/screen.png
```

## Stop

```bash
adb emu kill
```

## RAM usage notes

- Emulator idle: ~700MB
- Emulator with app: ~1.2GB
- Gradle build spike: ~1.5GB (releases after build)
- Full live footprint (emulator + Gradle daemon + Metro): ~4–5GB
- On memory-constrained machines this pushes into swap — always free caches first

## Troubleshooting

**Overlay permission intercepting first launch** — on first launch the app may redirect to Android "Display over other apps" settings instead of opening. Grant it ahead of time:
```bash
adb shell appops set com.lusoquantum.verdant SYSTEM_ALERT_WINDOW allow
```

**Dev client can't connect to Metro / app stuck on connection screen** — the installed build is a dev launcher that requires Metro to serve the JS bundle. If `expo run:android` launched Metro but the app can't connect, try the deep link:
```bash
# Ensure Metro is running on port 8081, then:
adb shell am start -a android.intent.action.VIEW \
  -d "exp+verdant://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081" \
  com.lusoquantum.verdant
```
`10.0.2.2` is the emulator's alias for the host's `localhost`.

**Crash state loop / "last time you opened this app it crashed"** — as a last resort, clear app data to reset state. Warning: this also resets onboarding (3 extra Continue taps) and logs you out:
```bash
adb shell pm clear com.lusoquantum.verdant
```

**`ClassNotFoundException: expo.modules.kotlin.types.AnyTypeCache`** — verify `@expo/dom-webview` is excluded in `app/package.json` under `expo.autolinking.exclude`, then:
```bash
SERIAL=$(adb devices | awk '/emulator-[0-9]+[[:space:]]+device/{print $1; exit}')
AVD=$(adb -s "$SERIAL" emu avd name | head -1 | tr -d '\r')
cd android && ./gradlew clean && cd ..
npx expo run:android --device "$AVD" --rerun-tasks
```
If it persists, delete `android/` and re-prebuild:
```bash
npx expo prebuild --platform android --clean && npx expo run:android --device "$AVD"
```

**`supabaseUrl is required`** — Metro running from worktree missing `.env`. Copy env files and restart Metro.

**Emulator died during build (OOM)** — restart emulator and install APK manually:
```bash
adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk
```
