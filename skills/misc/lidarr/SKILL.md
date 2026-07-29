---
name: lidarr
description: Search, add, and manage music artists and albums via Lidarr API. Use when the user asks about music availability, wants to add an artist to their library, search for artists/albums, trigger album searches, check missing albums, or view download queue. Also triggers on mentions of "lidarr", "add artist", "music library", "missing albums", or when the user wants to find or download music.
---

# Lidarr

Interact with your Lidarr instance to search for music, manage your artist library, trigger downloads, and check on missing albums or active downloads.

## Configuration

Requires two environment variables (set in `<skill-dir>/.env`, copied from `<skill-dir>/.env.example`):

```
LIDARR_URL=http://localhost:8686
LIDARR_API_KEY=your_api_key_here
```

## Search Artists

Search for artists by name (queries MusicBrainz):

```bash
./scripts/lidarr.sh search-artist "Radiohead"
```

Returns: artist name, MusicBrainz ID, foreignArtistId, number of albums, and status (whether already in library).

## Search Albums

Search for a specific album by name:

```bash
./scripts/lidarr.sh search-album "OK Computer"
```

Returns: album title, artist name, release date, and MusicBrainz ID.

## Add Artist

First search to find the artist's foreignArtistId (MusicBrainz ID), then add:

```bash
./scripts/lidarr.sh add-artist <foreignArtistId>
```

Optionally specify a root folder path and quality profile:

```bash
./scripts/lidarr.sh add-artist <foreignArtistId> --root-folder "/music/artists" --quality-profile "FLAC"
```

Returns: artist name, Lidarr internal ID, and monitored status.

## List Artists

List all artists in your library:

```bash
./scripts/lidarr.sh artists                    # All artists
./scripts/lidarr.sh artists --limit 20         # Limit results (default 20)
```

Returns: artist name, MusicBrainz ID, album count, monitored status, and path.

## List Albums

List albums for an artist (by Lidarr artist ID):

```bash
./scripts/lidarr.sh albums <artistId>
```

Returns: album title, release date, monitored status, and whether tracks are available.

## Trigger Search

### Search all missing albums for an artist:

```bash
./scripts/lidarr.sh search <artistId>
```

### Search for a specific album:

```bash
./scripts/lidarr.sh search <artistId> --album <albumId>
```

Returns: command ID and status confirmation.

## Missing Albums

Show albums that are monitored but not yet downloaded:

```bash
./scripts/lidarr.sh missing                    # Missing albums
./scripts/lidarr.sh missing --limit 20         # Limit results (default 20)
```

Returns: album title, artist name, release date, and how long it's been missing.

## Queue

Show active downloads:

```bash
./scripts/lidarr.sh queue                     # Active queue
./scripts/lidarr.sh queue --limit 20          # Limit results (default 20)
```

Returns: album title, artist name, download status, progress percentage, and time remaining.

## Workflow

1. **User asks about an artist/album** → run `search-artist` or `search-album` to find it
2. **User wants to add to library** → `search-artist` first to get the foreignArtistId, then `add-artist`
3. **User wants to check downloads** → run `queue` for active downloads, `missing` for what's still needed
4. **User wants to force a search** → `search` with artistId (optionally `--album` for specific album)
