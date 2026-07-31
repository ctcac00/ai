#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Load .env
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${LIDARR_URL:-}" || -z "${LIDARR_API_KEY:-}" ]]; then
  echo "Error: LIDARR_URL and LIDARR_API_KEY must be set in $ENV_FILE"
  exit 1
fi

API_BASE="${LIDARR_URL}/api/v1"
API_KEY="$LIDARR_API_KEY"

api_get() {
  local endpoint="$1"
  curl -s -f -H "X-Api-Key: $API_KEY" "${API_BASE}${endpoint}"
}

api_post() {
  local endpoint="$1"
  local body="$2"
  curl -s -f -X POST \
    -H "X-Api-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${API_BASE}${endpoint}"
}

api_delete() {
  local endpoint="$1"
  curl -s -f -X DELETE -H "X-Api-Key: $API_KEY" "${API_BASE}${endpoint}"
}

api_put() {
  local endpoint="$1"
  local body="$2"
  curl -s -f -X PUT \
    -H "X-Api-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${API_BASE}${endpoint}"
}

url_encode() {
  python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1" 2>/dev/null || echo "$1" | sed 's/ /%20/g'
}

cmd_search_artist() {
  local query="$1"
  local encoded
  encoded=$(url_encode "$query")
  local response
  response=$(api_get "/artist/lookup?term=${encoded}")

  echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('No artists found.')
    sys.exit(0)
for a in data[:15]:
    name = a.get('artistName', 'Unknown')
    mbid = a.get('foreignArtistId', '?')
    albums = a.get('albumCount', '?')
    status = 'in library' if a.get('id') else 'not in library'
    print(f'  {name} - MB:{mbid} - {albums} albums [{status}]')
" 2>/dev/null || echo "Error parsing response"
}

cmd_search_album() {
  local query="$1"
  local encoded
  encoded=$(url_encode "$query")
  local response
  response=$(api_get "/album/lookup?term=${encoded}")

  echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('No albums found.')
    sys.exit(0)
for alb in data[:15]:
    title = alb.get('title', 'Unknown')
    artist = alb.get('artist', {}).get('artistName', '?') if alb.get('artist') else '?'
    date = alb.get('releaseDate', '')[:10]
    mbid = alb.get('foreignAlbumId', '?')
    print(f'  {artist} - {title} ({date}) - MB:{mbid}')
" 2>/dev/null || echo "Error parsing response"
}

cmd_add_artist() {
  local foreign_id="$1"
  local root_folder=""
  local quality_profile=""
  local monitor="all"
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --root-folder) root_folder="$2"; shift 2 ;;
      --quality-profile) quality_profile="$2"; shift 2 ;;
      --monitor) monitor="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  case "$monitor" in
    all|none|missing|latest|first|latestAndFirst|last) ;;
    *) echo "Error: --monitor must be one of: all, none, missing, latest, first, latestAndFirst, last"; return 1 ;;
  esac

  # Lookup the artist to get full details for the add payload
  local encoded
  encoded=$(url_encode "lidarr:${foreign_id}")
  local lookup
  lookup=$(api_get "/artist/lookup?term=${encoded}")

  # Build the add payload from lookup result
  local body
  body=$(echo "$lookup" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('Error: Artist not found')
    sys.exit(1)
artist = data[0]

# Determine root folder
root = '${root_folder}'
if not root:
    # Fetch root folders to pick the first one
    import urllib.request
    req = urllib.request.Request('${API_BASE}/rootfolder', headers={'X-Api-Key': '${API_KEY}'})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            folders = json.loads(resp.read())
            if folders:
                root = folders[0].get('path', '')
    except:
        pass

# Determine quality profile
qp = '${quality_profile}'
if not qp:
    import urllib.request
    req = urllib.request.Request('${API_BASE}/qualityprofile', headers={'X-Api-Key': '${API_KEY}'})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            profiles = json.loads(resp.read())
            if profiles:
                qp = profiles[0].get('name', '')
    except:
        pass

artist['monitored'] = True
artist['rootFolderPath'] = root
artist['qualityProfileId'] = 1
artist['metadataProfileId'] = 1
artist['addOptions'] = {
    'monitor': '${monitor}',
    'searchForMissingAlbums': False
}

# Remove fields that cause issues on POST
for key in ['id', 'statistics', 'images']:
    artist.pop(key, None)

print(json.dumps(artist))
" 2>&1)

  if [[ "$body" == Error:* ]]; then
    echo "$body"
    return 1
  fi

  local response
  response=$(api_post "/artist" "$body")

  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
name = d.get('artistName', '?')
lid = d.get('id', '?')
mon = 'monitored' if d.get('monitored') else 'unmonitored'
print(f'Added: {name} (Lidarr ID:{lid}) - {mon}')
" 2>/dev/null || echo "Artist added. Response: $response"
}

cmd_artists() {
  local limit=20

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local response
  response=$(api_get "/artist")

  echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
limit = ${limit}
for a in data[:limit]:
    name = a.get('artistName', 'Unknown')
    mbid = a.get('foreignArtistId', '?')
    alb_count = a.get('statistics', {}).get('albumCount', 0)
    avail = a.get('statistics', {}).get('percentOfTracks', 0)
    mon = 'M' if a.get('monitored') else ' '
    print(f'  [{mon}] {name} - MB:{mbid} - {alb_count} albums ({avail}% tracks)')
" 2>/dev/null || echo "Error parsing response"
}

cmd_albums() {
  local artist_id="$1"

  local response
  response=$(api_get "/album?artistId=${artist_id}&includeAllArtistAlbums=true")

  echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('No albums found for this artist.')
    sys.exit(0)
for alb in data:
    title = alb.get('title', 'Unknown')
    alb_id = alb.get('id', '?')
    foreign = alb.get('foreignAlbumId', '?')
    alb_type = alb.get('albumType', '?')
    date = alb.get('releaseDate', '')[:10]
    mon = 'M' if alb.get('monitored') else ' '
    stats = alb.get('statistics', {})
    total = stats.get('totalTrackCount', 0)
    avail = stats.get('trackCount', 0)
    pct = int(avail * 100 / total) if total > 0 else 0
    status = f'{avail}/{total} tracks' if pct < 100 else 'complete'
    print(f'  [{mon}] {alb_id} {title} ({date}) [{alb_type}] - {status} (MB:{foreign})')
" 2>/dev/null || echo "Error parsing response"
}

cmd_search() {
  local artist_id="$1"
  local album_id=""
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --album) album_id="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local body
  if [[ -n "$album_id" ]]; then
    body='{"name":"AlbumSearch","albumIds":['"$album_id"']}'
  else
    body='{"name":"ArtistSearch","artistIds":['"$artist_id"']}'
  fi

  local response
  response=$(api_post "/command" "$body")

  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
name = d.get('name', '?')
status = d.get('status', '?')
cid = d.get('id', '?')
print(f'Command: {name} (ID:{cid}) - Status: {status}')
" 2>/dev/null || echo "Search triggered. Response: $response"
}

cmd_missing() {
  local limit=20

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local response
  response=$(api_get "/wanted/missing?pageSize=${limit}")

  echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('records', data) if isinstance(data, dict) else data
if not results:
    print('No missing albums.')
    sys.exit(0)
for r in results:
    title = r.get('title', 'Unknown')
    artist = r.get('artist', {}).get('artistName', '?') if r.get('artist') else '?'
    date = r.get('releaseDate', '')[:10]
    print(f'  {artist} - {title} ({date})')
" 2>/dev/null || echo "Error parsing response"
}

cmd_queue() {
  local limit=20

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local response
  response=$(api_get "/queue?pageSize=${limit}")

  echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
records = data.get('records', data) if isinstance(data, dict) else data
if not records:
    print('Queue is empty.')
    sys.exit(0)
for r in records:
    album = r.get('album', {})
    title = album.get('title', '?') if album else '?'
    artist = album.get('artist', {}).get('artistName', '?') if album and album.get('artist') else '?'
    status = r.get('status', '?')
    size = r.get('size', 0)
    sizeleft = r.get('sizeleft', 0)
    pct = int((1 - sizeleft / size) * 100) if size > 0 else 0
    timeleft = r.get('timeleft', '')
    print(f'  {artist} - {title} [{status}] {pct}% {timeleft}')
" 2>/dev/null || echo "Error parsing response"
}

cmd_monitor_album() {
  local album_id=""
  local monitored=true
  local do_search=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --album) album_id="$2"; shift 2 ;;
      --monitor) monitored=true; shift ;;
      --unmonitor) monitored=false; shift ;;
      --search) do_search=true; shift ;;
      *) shift ;;
    esac
  done

  if [[ -z "$album_id" ]]; then
    echo "Usage: lidarr.sh monitor-album --album <albumId> [--monitor|--unmonitor] [--search]"
    return 1
  fi

  local response
  response=$(api_get "/album/${album_id}")
  local py_mon
  [[ "$monitored" == "true" ]] && py_mon=True || py_mon=False

  local body
  body=$(echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d:
    print('Error: Album not found')
    sys.exit(1)
d['monitored'] = ${py_mon}
for key in ['id', 'statistics', 'images']:
    d.pop(key, None)
print(json.dumps(d))
" 2>&1)

  if [[ "$body" == Error:* ]]; then
    echo "$body"
    return 1
  fi

  local result
  result=$(api_put "/album/${album_id}" "$body")

  # Verify with GET — PUT responses lie (lesson: always re-read)
  local verify
  verify=$(api_get "/album/${album_id}")
  local verified
  verified=$(echo "$verify" | python3 -c "
import sys, json
d = json.load(sys.stdin)
title = d.get('title', '?')
actual = d.get('monitored', False)
expected = ${py_mon}
if actual != expected:
    print(f'WARNING: Album {title} is still {\"monitored\" if actual else \"unmonitored\"} (expected {\"monitored\" if expected else \"unmonitored\"})')
    sys.exit(1)
print(f'Album {title} is now {\"monitored\" if actual else \"unmonitored\"} (verified)')
" 2>&1)

  echo "$verified"

  # Optionally trigger search for this album
  if [[ "$do_search" == "true" ]]; then
    cmd_search 0 --album "$album_id"
  fi
}

cmd_search_albums() {
  local artist_id="$1"
  local album_ids=""
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --albums) album_ids="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ -z "$album_ids" ]]; then
    echo "Usage: lidarr.sh search-albums <artistId> --albums <albumId1,albumId2,...>"
    return 1
  fi

  local body
  body='{"name":"AlbumSearch","albumIds":['"$album_ids"']}'

  local response
  response=$(api_post "/command" "$body")

  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
name = d.get('name', '?')
status = d.get('status', '?')
cid = d.get('id', '?')
print(f'Command: {name} (ID:{cid}) - Status: {status}')
" 2>/dev/null || echo "Search triggered. Response: $response"
}

cmd_add_album() {
  local foreign_album_id="$1"
  local artist_lidarr_id=""
  local monitored=true
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --artist-id) artist_lidarr_id="$2"; shift 2 ;;
      --unmonitor) monitored=false; shift ;;
      *) shift ;;
    esac
  done

  if [[ -z "$foreign_album_id" ]]; then
    echo "Usage: lidarr.sh add-album <foreignAlbumId> --artist-id <lidarrArtistId> [--unmonitor]"
    return 1
  fi

  # Lookup the album to get full details
  local encoded
  encoded=$(url_encode "lidarr:${foreign_album_id}")
  local lookup
  lookup=$(api_get "/album/lookup?term=${encoded}")

  local py_mon
  [[ "$monitored" == "true" ]] && py_mon=True || py_mon=False

  local body
  body=$(echo "$lookup" | python3 -c "
import sys, json
data = json.load(sys.stdin)
if not data:
    print('Error: Album not found in lookup')
    sys.exit(1)
alb = data[0]
# Set the artist to the library artist (by Lidarr ID)
if '${artist_lidarr_id}':
    if alb.get('artist'):
        alb['artist']['id'] = int('${artist_lidarr_id}')
        alb['artist']['artistName'] = alb['artist'].get('artistName', '?')
alb['monitored'] = ${py_mon}
alb['addOptions'] = {'searchForMissingAlbums': False}
for key in ['id', 'statistics', 'images']:
    alb.pop(key, None)
print(json.dumps(alb))
" 2>&1)

  if [[ "$body" == Error:* ]]; then
    echo "$body"
    return 1
  fi

  local response
  response=$(api_post "/album" "$body")

  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
title = d.get('title', '?')
alb_id = d.get('id', '?')
artist = d.get('artist', {}).get('artistName', '?') if d.get('artist') else '?'
mon = 'monitored' if d.get('monitored') else 'unmonitored'
print(f'Added album: {artist} - {title} (ID:{alb_id}) - {mon}')
" 2>/dev/null || echo "Album added. Response: $response"
}

cmd_unmonitor_others() {
  local artist_id="$1"
  local keep_album_ids=""
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep) keep_album_ids="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  if [[ -z "$keep_album_ids" ]]; then
    echo "Usage: lidarr.sh unmonitor-others <artistId> --keep <albumId1,albumId2,...>"
    return 1
  fi

  python3 -c "
import json, urllib.request

api = '${API_BASE}'
key = '${API_KEY}'
h = {'X-Api-Key': key}

keep = set(int(x) for x in '${keep_album_ids}'.split(',') if x.strip())
resp = urllib.request.Request(f'{api}/album?artistId=${artist_id}&includeAllArtistAlbums=true', headers=h)
albums = json.loads(urllib.request.urlopen(resp).read())

changed = 0
for alb in albums:
    aid = alb.get('id')
    if aid in keep:
        continue
    if alb.get('monitored'):
        alb['monitored'] = False
        for k in ['id', 'statistics', 'images']:
            alb.pop(k, None)
        req = urllib.request.Request(f'{api}/album/{aid}', data=json.dumps(alb).encode(), headers={**h, 'Content-Type': 'application/json'}, method='PUT')
        urllib.request.urlopen(req)
        changed += 1

if changed:
    print(f'Unmonitored {changed} non-target album(s)')
else:
    print('No changes needed')
" 2>&1
}

# Main
cmd="${1:-}"
if [[ $# -gt 0 ]]; then
  shift
fi

case "$cmd" in
  search-artist)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh search-artist \"query\"" && exit 1
    cmd_search_artist "$*"
    ;;
  search-album)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh search-album \"query\"" && exit 1
    cmd_search_album "$*"
    ;;
  add-artist)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh add-artist <foreignArtistId> [--root-folder PATH] [--quality-profile NAME] [--monitor all|none|missing|latest|first|latestAndFirst|last]" && exit 1
    cmd_add_artist "$@"
    ;;
  monitor-album)
    cmd_monitor_album "$@"
    ;;
  search-albums)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh search-albums <artistId> --albums <albumId1,albumId2,...>" && exit 1
    cmd_search_albums "$@"
    ;;
  add-album)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh add-album <foreignAlbumId> --artist-id <lidarrArtistId> [--unmonitor]" && exit 1
    cmd_add_album "$@"
    ;;
  unmonitor-others)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh unmonitor-others <artistId> --keep <albumId1,albumId2,...>" && exit 1
    cmd_unmonitor_others "$@"
    ;;
  artists)
    cmd_artists "$@"
    ;;
  albums)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh albums <artistId>" && exit 1
    cmd_albums "$@"
    ;;
  search)
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh search <artistId> [--album <albumId>]" && exit 1
    cmd_search "$@"
    ;;
  missing)
    cmd_missing "$@"
    ;;
  queue)
    cmd_queue "$@"
    ;;
  *)
    echo "Lidarr CLI"
    echo ""
    echo "Usage:"
    echo "  lidarr.sh search-artist \"query\"                    - Search artists (MusicBrainz)"
    echo "  lidarr.sh search-album \"query\"                     - Search albums"
    echo "  lidarr.sh add-artist <foreignArtistId> [--monitor MODE] - Add artist (MODE: all|none|missing|latest|first|latestAndFirst|last)"
    echo "  lidarr.sh monitor-album --album <albumId> [--monitor|--unmonitor] [--search] - Toggle album monitoring"
    echo "  lidarr.sh search-albums <artistId> --albums <ids>     - Search specific albums"
    echo "  lidarr.sh add-album <foreignAlbumId> --artist-id <id>  - Add album not in artist's list"
    echo "  lidarr.sh unmonitor-others <artistId> --keep <ids>     - Unmonitor all except specified albums"
    echo "  lidarr.sh artists [--limit N]                        - List library artists"
    echo "  lidarr.sh albums <artistId>                          - List albums for artist"
    echo "  lidarr.sh search <artistId> [--album <albumId>]      - Trigger download search"
    echo "  lidarr.sh missing [--limit N]                        - Show missing albums"
    echo "  lidarr.sh queue [--limit N]                          - Show active downloads"
    exit 1
    ;;
esac
