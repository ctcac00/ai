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
  shift

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --root-folder) root_folder="$2"; shift 2 ;;
      --quality-profile) quality_profile="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

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
    'monitor': 'all',
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
    date = alb.get('releaseDate', '')[:10]
    mon = 'M' if alb.get('monitored') else ' '
    stats = alb.get('statistics', {})
    total = stats.get('totalTrackCount', 0)
    avail = stats.get('trackCount', 0)
    pct = int(avail * 100 / total) if total > 0 else 0
    status = f'{avail}/{total} tracks' if pct < 100 else 'complete'
    print(f'  [{mon}] {title} ({date}) - {status}')
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

# Main
cmd="${1:-}"
shift || true

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
    [[ -z "${1:-}" ]] && echo "Usage: lidarr.sh add-artist <foreignArtistId> [--root-folder PATH] [--quality-profile NAME]" && exit 1
    cmd_add_artist "$@"
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
    echo "  lidarr.sh add-artist <foreignArtistId>               - Add artist to library"
    echo "  lidarr.sh artists [--limit N]                        - List library artists"
    echo "  lidarr.sh albums <artistId>                          - List albums for artist"
    echo "  lidarr.sh search <artistId> [--album <albumId>]      - Trigger download search"
    echo "  lidarr.sh missing [--limit N]                        - Show missing albums"
    echo "  lidarr.sh queue [--limit N]                          - Show active downloads"
    exit 1
    ;;
esac
