---
name: qbittorrent
description: "Add torrents to qBittorrent and manage downloads via its WebUI API. Use when the user wants to add a magnet link or .torrent URL to qBittorrent, check download progress or status, list current torrents, or pause/resume/remove a download. Designed as the download step after `prowlarr` search→grab: takes a magnet/URL (or piped `prowlarr grab N --json` output) and adds it. Also triggers on mentions of \"qBittorrent\", \"add this torrent\", \"download this\", \"what's downloading\", or \"seed ratio\"."
---

# qBittorrent

Add torrents (magnet URI or `.torrent` URL) to qBittorrent and manage them through the WebUI API. Built as the companion download step to the `prowlarr` skill: `prowlarr search` → `prowlarr grab N --json` → `qbittorrent add`.

## Configuration

Requires three environment variables in `<skill-dir>/.env` (copy from `<skill-dir>/.env.example`):

```
QBITTORRENT_URL=http://localhost:8080
QBITTORRENT_USERNAME=admin
QBITTORRENT_PASSWORD=your_password_here
```

The WebUI URL/port and credentials live in the qBittorrent config (container path `/config/qBittorrent/config/qBittorrent.conf`) or, for setups where sonarr/radarr already talk to qBittorrent, in their download-client config. The username is the WebUI login user; the password is the one set in the WebUI (stored as a PBKDF2 hash in the conf, so recover the plaintext from an *arr config, not the conf).

## Core workflow

```
1. (prowlarr search → grab N --json)    produce a magnet/URL
2. qbittorrent add ... --category <c>   add it (category required)
3. qbittorrent list                     confirm + watch progress
4. qbittorrent status <sel>             detail on one torrent
5. qbittorrent pause|resume|remove      manage as needed
```

`add` always requires a `--category` (this mirrors how sonarr/radarr assign `tv-sonarr`/`radarr`). A new category is auto-created if it does not exist.

## Add

```bash
# raw magnet / .torrent URL
./scripts/qbittorrent.sh add "magnet:?xt=urn:btih:..." --category linux

# pipe straight from prowlarr's grab
./scripts/prowlarr.sh grab 1 --json | ./scripts/qbittorrent.sh add --category linux

# add everything from a prowlarr search result set
./scripts/prowlarr.sh search "ubuntu 24.04" --category pc --json \
  | ./scripts/qbittorrent.sh add --category linux

# from a saved JSON file
./scripts/qbittorrent.sh add --json-file result.json --category linux
```

Options:

| Flag | Meaning |
|------|---------|
| `-C, --category <c>` | **required**. Auto-created if new. |
| `-p, --save-path <path>` | override the save location |
| `-t, --tags <a,b>` | comma-separated tags |
| `-n, --name <n>` | rename the torrent |
| `--json-file <f>` | read a prowlarr `grab`/`search` `--json` file |

**Input detection.** `add` takes a magnet/URL positional arg by default. If JSON is piped on stdin (or passed via `--json-file`), it reads the prowlarr shape — an object or array with `magnet_url` and/or `download_url` — preferring `magnet_url` and falling back to `download_url`. The prowlarr `title` is forwarded as the torrent name unless overridden by `--name`.

**Why it fetches `.torrent` URLs itself.** qBittorrent fetches `urls`-arg links server-side (from inside its container), so Prowlarr's `http://localhost:9696/...` proxied download links are unreachable to it. This skill therefore resolves `http(s)` URLs **host-side**: it follows redirects manually and, if the link redirects to a `magnet:` URI (common for TPB/LimeTorrents via Prowlarr), passes the magnet straight to qBittorrent; otherwise it downloads the `.torrent` and uploads the file. Magnet URIs given directly are passed through unchanged.

> qBittorrent's `add` returns `Ok.` when the torrent is *accepted* (queued), not when it finishes. Use `list`/`status` to watch progress.

## List

```bash
./scripts/qbittorrent.sh list                              # all
./scripts/qbittorrent.sh list --filter downloading         # active downloads
./scripts/qbittorrent.sh list --category linux             # by category
./scripts/qbittorrent.sh list --json                       # machine-readable
```

Default output (compact):
```
  [1]  73% downloading  2.3GB  ↓12.0MB/s     ubuntu-24.04.3-desktop-amd64.iso
```

The `[N]` indices stay valid until the next `list` — use them with `status`/`pause`/`resume`/`remove` as `#N`.

Filters: `all` `downloading` `seeding` `completed` `paused` `active` `inactive` `stalled`.

## Status

Detail card for one torrent (progress, ratio, ETA, seeds/leechers, category, tags, save path):

```bash
./scripts/qbittorrent.sh status 1        # by [N] from last list
./scripts/qbittorrent.sh status ubuntu   # by name substring
./scripts/qbittorrent.sh status <hash>   # by hash
./scripts/qbittorrent.sh status 1 --json
```

## Pause / Resume / Remove

```bash
./scripts/qbittorrent.sh pause 1            # stop downloading/seeding
./scripts/qbittorrent.sh resume ubuntu      # resume (name substring)
./scripts/qbittorrent.sh remove 1           # remove from client (keeps data)
./scripts/qbittorrent.sh remove 1 --delete-files   # also delete downloaded data
./scripts/qbittorrent.sh pause ubuntu --all         # if a name matches several
```

Selectors work across all manage commands: `#N` (last `list` index), a 40-hex hash, or a case-insensitive name substring. A substring matching multiple torrents errors unless `--all` is given (lists the matches so you can disambiguate). `remove --delete-files` is destructive — it deletes the downloaded files from disk.

> qBittorrent 5.x renamed the pause/resume API actions to **stop/start**; this skill maps the friendly `pause`/`resume` subcommands onto those endpoints.

## Workflow examples

**"Download this Ubuntu ISO I found"** (full prowlarr → qBittorrent chain)
```bash
./scripts/prowlarr.sh search "ubuntu 24.04" --category pc --json
./scripts/prowlarr.sh grab 1 --json | ./scripts/qbittorrent.sh add --category linux
./scripts/qbittorrent.sh list
```

**"Is my torrent done yet?"**
```bash
./scripts/qbittorrent.sh list --filter downloading    # empty = nothing active
./scripts/qbittorrent.sh status 1                     # detail on [1]
```

**"Stop seeding that one and remove it"**
```bash
./scripts/qbittorrent.sh list
./scripts/qbittorrent.sh remove 2 --delete-files
```

## Notes

- Use free-redistributable content (Linux ISOs, etc.) in examples and tests, not media titles.
- The `.env` with real credentials is gitignored (root `.gitignore`); `.env.example` holds placeholders only.
