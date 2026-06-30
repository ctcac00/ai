---
name: jellyseerr
description: Search, request, and check status of movies and TV shows via Jellyseerr API. Use when the user asks about media availability, wants to request a movie/TV show, or check download request status.
---

# Jellyseerr

Interact with your Jellyseerr instance to search media, check request status, and submit new requests.

## Configuration

Requires two environment variables (set in `<skill-dir>/.env`, copied from `<skill-dir>/.env.example`):

```
JELLYSEERR_URL=https://your-jellyseerr.example.com
JELLYSEERR_API_KEY=your_api_key_here
```

## Search Media

Search for movies and TV shows by name:

```bash
./scripts/jellyseerr.sh search "The Matrix"
```

Returns: title, year, mediaType (movie/tv), TMDB ID, and availability status.

Status codes: 0=unknown, 1=pending, 2=processing, 3=partially available, 4=available, 5=blacklisted

## Request Status

### Get request counts (summary stats):

```bash
./scripts/jellyseerr.sh stats
```

Returns: total, movie, tv, pending, approved, declined, processing, available counts.

### List requests with optional filters:

```bash
./scripts/jellyseerr.sh requests                    # All requests
./scripts/jellyseerr.sh requests --status pending   # Pending only
./scripts/jellyseerr.sh requests --status approved  # Approved only
./scripts/jellyseerr.sh requests --status available # Available only
./scripts/jellyseerr.sh requests --type movie       # Movies only
./scripts/jellyseerr.sh requests --type tv          # TV shows only
./scripts/jellyseerr.sh requests --limit 20         # Limit results (default 10)
```

Returns: title, type, status, requested date, requested by.

## Request New Media

First search to get the TMDB ID, then request:

```bash
./scripts/jellyseerr.sh request movie 603            # Request movie by TMDB ID
./scripts/jellyseerr.sh request tv 1399              # Request TV show by TMDB ID (all seasons)
./scripts/jellyseerr.sh request tv 1399 --seasons 1,2,3  # Request specific seasons
```

Returns: request ID, status, and confirmation.

## Workflow

1. **User asks about media** → run `search` to find it and check availability
2. **User wants to check downloads** → run `stats` for overview, `requests` for details
3. **User wants to request something** → `search` first to get TMDB ID, then `request`
