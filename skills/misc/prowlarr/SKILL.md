---
name: prowlarr
description: Search torrents across all configured Prowlarr indexers and retrieve magnet/torrent links for releases. Use when the user wants to find a torrent, search for a movie/TV/show/album/book/software release to download, get magnet links, or locate the best-seeded release of something. Also triggers when the user mentions "prowlarr", "indexers", "seeders", "find a torrent for X", "search for X to download", or wants to grab a torrent by quality/size. This skill returns structured results (including JSON) specifically designed to feed a download client like qBittorrent in a follow-up step.
---

# Prowlarr

Search across all torrent indexers configured in your Prowlarr instance, then retrieve the magnet or direct .torrent URL for a chosen release. Built to hand off cleanly to a download client (e.g. qBittorrent) as the next step.

## Configuration

Requires two environment variables in `<skill-dir>/.env` (copy from `<skill-dir>/.env.example`):

```
PROWLARR_URL=http://localhost:9696
PROWLARR_API_KEY=your_api_key_here
```

The API key lives in Prowlarr under **Settings → General → API Key**, or in the container at `/config/config.xml`.

## Core workflow

`search` runs the query, caches the results, and prints them with stable index numbers (`[1]`, `[2]`, …). `grab <N>` reads that cache and returns the link for result `N`. The numbers only stay valid until the next `search` — grab right after searching.

```
1. search "the thing" [filters]   →  ranked list with [N] indices
2. grab 3                          →  magnet/download URL for result [3]
3. (hand the URL to qBittorrent / your download client)
```

## Search

```bash
./scripts/prowlarr.sh search "ubuntu 24.04" --category pc --limit 10
./scripts/prowlarr.sh search "debian 12 iso" --json
./scripts/prowlarr.sh search "linux mint" --indexer "The Pirate Bay" --detail
```

Options:

| Flag | Meaning |
|------|---------|
| `-c, --category <name\|id>` | `movies` `tv` `audio` `books` `pc` `console` `xxx` `other`, or a numeric Prowlarr category id (2000=Movies, 5000=TV, 3000=Audio, 7000=Books, 4000=PC, 1000=Console, 6000=XXX) |
| `-i, --indexer <name\|id>` | restrict to one indexer (by display name or id) |
| `-l, --limit <N>` | max results, default 15 |
| `-f, --format <fmt>` | `compact` (default), `detail`, `json` |
| `-d, --detail` | shortcut for `--format detail` |
| `--json` | shortcut for `--format json` |

Results are deduped by info-hash (same release across indexers collapses to the best-seeded copy) and sorted by seeders descending — the best download candidates surface to the top.

### Output formats

- **compact** (default) — one scannable line per result. Use this when browsing with the user.
  ```
  [1] S:53   5.8GB   1y   The Pirate Bay  ubuntu-24.04.1-desktop-amd64.iso
  ```
- **detail** — full release card (seeders, leechers, size, age, indexer, protocol, categories, info-hash). Use when the user is weighing tradeoffs.
- **json** — a slim, flat array of release objects. **Use this when piping to a download client or another skill** — it carries everything needed to pick a release and download it: `index`, `title`, `size`, `size_human`, `seeders`, `leechers`, `age_days`, `age_human`, `indexer`, `protocol`, `category_ids`, `category_names`, `info_hash`, `magnet_url`, `download_url`, `info_url`, `publish_date`.

## Grab

Returns the link for a cached search result. `<N>` is the `[N]` index from the last `search`.

```bash
./scripts/prowlarr.sh grab 3              # magnet URL (default)
./scripts/prowlarr.sh grab 3 --json       # full release object with magnet + download URL
./scripts/prowlarr.sh grab 3 --torrent    # direct .torrent file URL instead
```

> **Note on "magnet" vs download URLs:** some indexers return a true `magnet:` URI; others only expose a `.torrent` file proxied through Prowlarr (an `http://.../download?...` link). `grab`'s default prefers `magnetUrl` and falls back to `downloadUrl`. The JSON output exposes both fields verbatim, so a download client can pick whichever it supports. qBittorrent accepts both magnet and .torrent URLs.

## Choosing a release

When the user asks for "the best" or "a good" release and doesn't specify, weigh these signals (already present in the output):

1. **Seeders** — more = faster, more reliable download. Avoid results with 0 seeders.
2. **Size** — match the user's quality/storage preference. Typical ranges vary by media type (a feature film is several GB; an OS ISO is 2-8GB; a music album is tens to hundreds of MB). Flag anything obviously wrong for the claimed content (e.g. a full-length “1080p” film release under 700MB is usually fake or a sample).
3. **Age** — fresher usually means better encoding/availability for current releases, but well-seeded older releases are fine.
4. **Indexer health** — some indexers flap (intermittent failures). A result from a consistently-up indexer is more dependable. If a search returns suspiciously few results, the instance may have down indexers — worth checking.

Confirm the choice with the user before grabbing if it's ambiguous which release they want (multiple quality options, remux vs encode, etc.).

## Workflow examples

**"Find me an Ubuntu 24.04 ISO"**
```bash
./scripts/prowlarr.sh search "ubuntu 24.04" --category pc --limit 10
# pick the best-seeded desktop amd64 ISO, e.g. [1]
./scripts/prowlarr.sh grab 1 --json
```

**"Search for the latest Debian, I'll download it"** (intending a handoff to qBittorrent)
```bash
./scripts/prowlarr.sh search "debian 12.0 amd64" --category pc --json   # structured output for the next step
./scripts/prowlarr.sh grab 1 --json                                      # chosen release as JSON
```

**"Is there a well-seeded Linux Mint torrent?"**
```bash
./scripts/prowlarr.sh search "linux mint 21" --limit 5
```
