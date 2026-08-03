---
name: navidrome
description: "Automate a Navidrome music server from Python — like/love/star songs, build and edit playlists, search for tracks. Navidrome speaks the Subsonic API, so this also works against any Subsonic-compatible server (Airsonic, Gonic, etc.). Use this whenever the user wants to programmatically control their Navidrome library: favoriting or starring songs, creating or adding to playlists, 'make me a playlist from…', batch-liking an artist's tracks, syncing a playlist from a list of songs, or any scripting against Navidrome. Trigger even when they say 'music server', 'Navidrome', 'star these tracks', 'auto-like', 'playlist from a search', or 'build a playlist' and a Navidrome (or Subsonic) server is in play — don't wait for them to say 'Subsonic API'."
---

# Navidrome: likes & playlists from Python

This skill helps you write Python that drives a **Navidrome** music server to
**like songs** and **manage playlists**. Navidrome exposes the Subsonic API,
which is what this skill speaks — so everything here also works unchanged
against any other Subsonic-compatible server (Airsonic, Gonic, etc.). The
skill bundles a ready-made client so you never hand-write auth or endpoint
plumbing.

## The bundled client

`scripts/navidrome.py` is a complete, dependency-free client (stdlib only)
covering the focused surface: star/unstar, get starred, create/update/get
playlists, and search. **Reuse it instead of reinventing it.** The reason:
auth (salted md5 token, JSON envelope handling, repeated query params for
multi-song operations) is fiddly and easy to get subtly wrong. Doing it once
here means every script is correct and short.

When you write a script for the user:

1. Copy `scripts/navidrome.py` next to their script (or into their project).
2. `from navidrome import Navidrome` and go.

Don't paste the client's source inline into the conversation — just tell the
user it's copied alongside their script and show them the short driver code.

## Configuration

The client needs a username and password; the URL is optional:

| var             | meaning                                  |
|-----------------|------------------------------------------|
| `NAVIDROME_URL` | Base URL (optional; defaults to `http://localhost:4533`, Navidrome's standard port). Set it only if your server runs elsewhere — different host, reverse-proxied domain, or HTTPS. |
| `NAVIDROME_USER`| Username                                 |
| `NAVIDROME_PASS`| Password (only its hashed token is sent) |

Have the user export these, or pass them to `Navidrome(url=, user=, password=)`
directly. If `NAVIDROME_USER`/`NAVIDROME_PASS` are missing the client raises
`NavidromeError` naming exactly which — surface that to the user rather than
guessing defaults. The URL usually doesn't need setting for a local server.

> Security note worth telling the user: token auth means the plaintext
> password is never put in a URL. The client derives `md5(password + salt)`
> with a fresh random salt per request. That's the Subsonic-recommended scheme
> from API 1.13.0 onward.

## The operations you'll use

Everything below is a method on the `Navidrome` client. All return parsed JSON
dicts/lists; IDs are **strings** (Navidrome uses hex/UUID — never cast to int).

### Like / star a song (or album, or artist)

```python
n = Navidrome()
n.star(song_id="abc123")          # one song
n.star(song_id=["a", "b", "c"])   # several at once
n.star(album_id="alb9")           # star a whole album
n.unstar(song_id="abc123")        # remove the star
```

On Navidrome, "starred" *is* the heart/loved state the UI shows. Starring an
album or artist does not automatically star its individual songs — that's a
separate call per song if the user wants it.

### Create / edit a playlist

```python
# new playlist, optionally seeded with songs
pl = n.create_playlist("Friday", song_ids=["a", "b", "c"])
pl_id = pl["id"]

# append songs without clobbering the rest
n.update_playlist(pl_id, song_ids_to_add=["d", "e"])

# rewrite the whole track list (createPlaylist with playlistId replaces)
n.create_playlist(playlist_id=pl_id, song_ids=["x", "y"])
```

Two ways to change a playlist, and they mean different things:

- `create_playlist(playlist_id=..., song_ids=...)` **replaces** the contents.
- `update_playlist(playlist_id=..., song_ids_to_add=...)` **appends** (use
  `song_indexes_to_remove` to drop tracks by 0-based position).

Pick based on what the user asked: "add these to my playlist" → update; "make
this playlist exactly these songs" → create with playlistId. Only the playlist
owner can update — if a call fails with a permission error, that's why.

### Find songs to act on

```python
res = n.search("radiohead", song_count=20)   # {song, album, artist} lists
songs = res.get("song", [])
ids = [song["id"] for song in songs]

n.get_starred()          # everything you've already liked
n.get_playlists()        # list of {id, name, songCount, ...}
n.get_playlist(pl_id)    # one playlist incl. its "entry" track list
```

`search` takes a free-text query (title, artist, album all match). The result
shape is `{song: [...], album: [...], artist: [...]}`; each may be empty, so
use `.get("song", [])` and tell the user plainly if nothing matched rather than
crashing on a missing key.

## Common recipes

These come up constantly — recognize the shape and reach for the matching
approach.

**Like every track by an artist.** Search the artist, star the resulting songs.
Remind the user this stars the *songs* the search returned, not the artist
entity (which would be `star(artist_id=...)`).

```python
songs = n.search("Fleet Foxes", song_count=200)["song"]
n.star(song_id=[x["id"] for x in songs])
```

**Build a playlist from a search.** Search → grab ids → create_playlist.

```python
ids = [x["id"] for x in n.search("electronic", song_count=50)["song"]]
n.create_playlist("Electronic", song_ids=ids)
```

**Make a playlist from an explicit list (CSV, file, args).** Parse the ids,
hand them to `create_playlist`. Validate they look like Navidrome ids
(non-empty strings) and warn on anything that doesn't.

**Add a few songs to an existing playlist by name.** Look up the id via
`get_playlists()`, then `update_playlist(..., song_ids_to_add=...)`.

**Unlike / clean up.** `get_starred()` → filter → `unstar(...)`.

## Gotchas worth stating to the user

- **IDs are strings**, often hex/UUID on Navidrome. Never `int(id)`.
- **`.view` suffix** (e.g. `star.view`) is optional; the client omits it.
- **JSON vs XML**: `f=json` is set for you. Raw curl users should add it.
- **Owner-only updates**: `updatePlaylist` only works for the playlist owner.
- **Starred ≠ scrobbled**: starring is the "like"; play-counting/scrobbling is
  a different endpoint (`scrobble`), out of this skill's scope — say so if asked.

## Out of scope

This skill is deliberately focused on liking + playlists. For streaming URLs,
lyrics, scrobbling, podcasts, or radio — the user needs broader Subsonic
endpoints. Tell them that's outside what this skill covers and point them at
the Subsonic API docs (subsonic.org/pages/api.jsp) rather than improvising.
