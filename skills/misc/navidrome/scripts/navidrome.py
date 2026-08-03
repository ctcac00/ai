#!/usr/bin/env python3
"""Minimal Navidrome client for liking songs + managing playlists.

Navidrome exposes the Subsonic API, so this client speaks it: the standard
/rest/<endpoint> surface documented at subsonic.org, using token auth
(md5(password + salt)) and JSON responses. Because it's the Subsonic API,
this also works unchanged against other Subsonic-compatible servers
(Airsonic, Gonic, etc.).

CONFIGURATION
-------------
Environment variables — username and password are required; the URL is
optional and defaults to a local Navidrome instance:

    NAVIDROME_URL    Base URL (optional; defaults to http://localhost:4533)
    NAVIDROME_USER   Account username
    NAVIDROME_PASS   Account password (never sent in the clear; only its
                     salted+hashed token goes over the wire)

They can also be passed as explicit constructor args to Navidrome(...).

QUICK START
-----------
    from navidrome import Navidrome
    n = Navidrome()

    songs = n.search("radiohead", song_count=10)["song"]
    n.star(song_id=songs[0]["id"])

    n.create_playlist("Friday", song_ids=[song["id"] for song in songs])
"""

import hashlib
import json
import os
import random
import urllib.request
import urllib.parse


class NavidromeError(Exception):
    """Raised on a non-OK Navidrome response (or bad config)."""


class Navidrome:
    CLIENT = "navidrome-skill"
    API_VERSION = "1.16.1"  # Navidrome targets Subsonic API 1.16.1
    DEFAULT_URL = "http://localhost:4533"  # Navidrome's standard port

    def __init__(self, url=None, user=None, password=None):
        # URL is optional — defaults to a local Navidrome instance.
        self.base = (
            url or os.environ.get("NAVIDROME_URL") or self.DEFAULT_URL
        ).rstrip("/")
        self.user = user or os.environ.get("NAVIDROME_USER")
        self.password = password or os.environ.get("NAVIDROME_PASS")
        missing = [
            name for name, val in (
                ("NAVIDROME_USER", self.user),
                ("NAVIDROME_PASS", self.password),
            ) if not val
        ]
        if missing:
            raise NavidromeError(
                "Missing configuration. Set env var(s): " + ", ".join(missing)
            )

    # -- internals ---------------------------------------------------------

    def _auth(self):
        # Fresh salt per request -> a different token each time. Token auth
        # is the recommended scheme from Subsonic API 1.13.0 onward; the
        # plaintext password never appears in a URL.
        salt = "%016x" % random.getrandbits(64)
        token = hashlib.md5((self.password + salt).encode("utf-8")).hexdigest()
        return token, salt

    def _call(self, endpoint, **params):
        token, salt = self._auth()
        query = {
            "u": self.user,
            "t": token,
            "s": salt,
            "v": self.API_VERSION,
            "c": self.CLIENT,
            "f": "json",
        }
        query.update({k: v for k, v in params.items() if v is not None})
        # urlencode(doseq=True) turns songId=[a,b,c] into repeated keys, which
        # is exactly what Navidrome expects for multi-valued params.
        url = "{}/rest/{}?{}".format(
            self.base, endpoint, urllib.parse.urlencode(query, doseq=True)
        )
        req = urllib.request.Request(url, headers={"User-Agent": self.CLIENT})
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raise NavidromeError("{} -> HTTP {}".format(endpoint, e.code)) from e

        sub = body.get("subsonic-response", {})
        if sub.get("status") != "ok":
            err = sub.get("error", {}) or {}
            raise NavidromeError(
                "{} failed: code={} message={}".format(
                    endpoint, err.get("code"), err.get("message", "")
                )
            )
        # Drop the envelope; return the interesting payload.
        sub.pop("status", None)
        sub.pop("version", None)
        sub.pop("type", None)
        sub.pop("serverVersion", None)
        return sub

    # -- starring (like / love / favorite) --------------------------------

    def star(self, song_id=None, album_id=None, artist_id=None):
        """Star a song, album, or artist. Navidrome shows stars as hearts.

        Pass one of song_id / album_id / artist_id (or a list for several of
        the same kind). On Navidrome, "starred" is what its heart/loved UI
        reads from.
        """
        return self._call(
            "star",
            id=_as_list(song_id),
            albumId=_as_list(album_id),
            artistId=_as_list(artist_id),
        )

    def unstar(self, song_id=None, album_id=None, artist_id=None):
        """Remove a star. Same params as star()."""
        return self._call(
            "unstar",
            id=_as_list(song_id),
            albumId=_as_list(album_id),
            artistId=_as_list(artist_id),
        )

    def get_starred(self):
        """Everything the user has starred: {song, album, artist} lists."""
        return self._call("getStarred2").get("starred2", {})

    # -- playlists ---------------------------------------------------------

    def create_playlist(self, name=None, playlist_id=None, song_ids=None):
        """Create a new playlist, or rewrite an existing one's contents.

        With `name` -> creates a new playlist (optionally seeded with songs).
        With `playlist_id` -> replaces that playlist's songs with song_ids.
        Returns the playlist object (includes its id).
        """
        res = self._call(
            "createPlaylist",
            name=name,
            playlistId=playlist_id,
            songId=_as_list(song_ids),
        )
        return res.get("playlist", res)

    def update_playlist(self, playlist_id, name=None, comment=None,
                        public=None, song_ids_to_add=None,
                        song_indexes_to_remove=None):
        """Patch an existing playlist. Only the owner may call this.

        - song_ids_to_add: append these songs (keeps existing contents).
        - song_indexes_to_remove: 0-based positions to drop.
        """
        return self._call(
            "updatePlaylist",
            playlistId=playlist_id,
            name=name,
            comment=comment,
            public=public,
            songIdToAdd=_as_list(song_ids_to_add),
            songIndexToRemove=_as_list(song_indexes_to_remove),
        )

    def get_playlists(self):
        return self._call("getPlaylists").get("playlist", [])

    def get_playlist(self, playlist_id):
        """One playlist, including its track list under 'entry'."""
        return self._call("getPlaylist", id=playlist_id).get("playlist", {})

    # -- discovery ---------------------------------------------------------

    def search(self, query, song_count=20, album_count=0, artist_count=0):
        """search3: returns {song, album, artist} lists matching `query`.

        Counts default to songs-only; set the others if you need them.
        """
        return self._call(
            "search3",
            query=query,
            songCount=song_count,
            albumCount=album_count,
            artistCount=artist_count,
        ).get("searchResult3", {})


def _as_list(v):
    """None -> None (omit param). Single value / list -> list."""
    if v is None:
        return None
    return v if isinstance(v, (list, tuple)) else [v]
