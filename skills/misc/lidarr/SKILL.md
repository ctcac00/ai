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

Optionally specify a root folder path, quality profile, and monitoring mode:

```bash
./scripts/lidarr.sh add-artist <foreignArtistId> --root-folder "/music/artists" --quality-profile "FLAC"
```

Control which albums get monitored on add:

```bash
./scripts/lidarr.sh add-artist <foreignArtistId> --monitor none   # Add artist, monitor nothing
./scripts/lidarr.sh add-artist <foreignArtistId> --monitor latest  # Monitor only latest album
./scripts/lidarr.sh add-artist <foreignArtistId> --monitor all     # Monitor all albums (default)
```

Valid `--monitor` values: `all`, `none`, `missing`, `latest`, `first`, `latestAndFirst`, `last`.

Returns: artist name, Lidarr internal ID, and monitored status.

## Add Album (for singles / releases not in artist's list)

Some albums (especially singles) don't appear in the artist's album list after adding the artist. Use this to add them directly:

```bash
./scripts/lidarr.sh add-album <foreignAlbumId> --artist-id <lidarrArtistId>
./scripts/lidarr.sh add-album <foreignAlbumId> --artist-id <lidarrArtistId> --unmonitor
```

Requires the MusicBrainz album ID (from `search-album`) and the Lidarr artist ID (from `artists` or `add-artist` output).

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

Returns: album Lidarr ID, title, release date, album type, monitored status, track availability, and MusicBrainz album ID.

## Monitor/Unmonitor an Album

Toggle monitoring on a specific album without affecting other albums:

```bash
./scripts/lidarr.sh monitor-album --album <albumId> --monitor     # Monitor
./scripts/lidarr.sh monitor-album --album <albumId> --unmonitor   # Unmonitor
./scripts/lidarr.sh monitor-album --album <albumId> --monitor --search  # Monitor + trigger search
```

**Always verifies with GET after PUT** — Lidarr PUT responses may report success when the change didn't persist. If verification fails, a WARNING is printed.

## Unmonitor Other Albums

Unmonitor all albums for an artist except specified ones (cleanup after selective monitoring):

```bash
./scripts/lidarr.sh unmonitor-others <artistId> --keep <albumId1,albumId2,...>
```

## Trigger Search

### Search all missing albums for an artist:

```bash
./scripts/lidarr.sh search <artistId>
```

### Search for a specific album:

```bash
./scripts/lidarr.sh search <artistId> --album <albumId>
```

### Search specific albums (batch):

```bash
./scripts/lidarr.sh search-albums <artistId> --albums <albumId1,albumId2,...>
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
4. **User wants to force a search** → run `search` with artistId (optionally `--album` for specific album)

### Selective Album Monitoring (add only specific albums)

When processing liked songs or specific albums — avoid downloading the artist's entire catalog:

1. Add artist with `monitor: none`: `lidarr.sh add-artist <foreignArtistId> --monitor none`
2. List albums to find the target album ID: `lidarr.sh albums <artistId>`
3. If target album is missing (singles often are): `lidarr.sh add-album <foreignAlbumId> --artist-id <artistId>`
4. Monitor only the target album: `lidarr.sh monitor-album --album <albumId> --monitor`
5. Unmonitor all other albums if artist already existed: `lidarr.sh unmonitor-others <artistId> --keep <albumId>`
6. Trigger search: `lidarr.sh monitor-album --album <albumId> --monitor --search` (or `search <artistId> --album <albumId>`)

**Important:** Always match albums by `foreignAlbumId` (MusicBrainz ID), never by title — Spotify and Lidarr use different album names (e.g., "Wellerman - The Album" vs "Wellerman: The Album").

## Troubleshooting / Lessons Learned

- **PUT responses lie:** Lidarr may return `monitored: true` in a PUT response but the change doesn't persist. Always verify with a subsequent GET. `monitor-album` does this automatically.
- **Spotify vs Lidarr name mismatches:** Never match by album title string. Use `foreignAlbumId` (MusicBrainz ID). Common mismatches include punctuation differences (dash vs colon), deluxe edition naming, etc.
- **Singles may not appear in artist album list:** After adding an artist with `--monitor none`, some albums (especially singles) won't be in `albums <artistId>`. Use `add-album` to add them directly by MusicBrainz ID.
- **Monitoring ≠ Downloading:** Setting `monitored: true` does NOT trigger Lidarr to search. Use `--search` flag or a separate `search` command.
- **Existing artists may have all albums monitored:** If an artist was already in your library, all their albums may be monitored. Use `unmonitor-others` to clean up non-target albums.
- **Album IDs can become stale:** If an album was deleted or re-created, its ID changes. Always verify the album exists before operating on it.
- **HTTP 503 / 400 errors:** Lidarr's metadata API (MusicBrainz lookups) can return 503 transiently. Strip `id`, `statistics`, `images` from lookup results before POSTing to avoid 400 errors.
