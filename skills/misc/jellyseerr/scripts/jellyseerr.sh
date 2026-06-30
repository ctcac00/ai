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

if [[ -z "${JELLYSEERR_URL:-}" || -z "${JELLYSEERR_API_KEY:-}" ]]; then
  echo "Error: JELLYSEERR_URL and JELLYSEERR_API_KEY must be set in $ENV_FILE"
  exit 1
fi

API_BASE="${JELLYSEERR_URL}/api/v1"
API_KEY="$JELLYSEERR_API_KEY"

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

format_status() {
  case "$1" in
    0) echo "unknown" ;;
    1) echo "pending" ;;
    2) echo "processing" ;;
    3) echo "partial" ;;
    4) echo "available" ;;
    5) echo "blacklisted" ;;
    *) echo "unknown($1)" ;;
  esac
}

format_request_status() {
  case "$1" in
    1) echo "pending" ;;
    2) echo "approved" ;;
    3) echo "declined" ;;
    *) echo "unknown($1)" ;;
  esac
}

cmd_search() {
  local query="$1"
  local response
  response=$(api_get "/search?query=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$query'))" 2>/dev/null || echo "$query" | sed 's/ /%20/g')")

  echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('results', [])[:15]
if not results:
    print('No results found.')
    sys.exit(0)
for r in results:
    mt = r.get('mediaType', 'unknown')
    title = r.get('title') or r.get('name', 'Unknown')
    year = r.get('releaseDate', r.get('firstAirDate', ''))[:4]
    mid = r.get('id', '?')
    mi = r.get('mediaInfo', {})
    status = mi.get('status', 0) if mi else 0
    status_map = {0:'unknown', 1:'pending', 2:'processing', 3:'partial', 4:'available', 5:'blacklisted'}
    print(f'  [{mt.upper():5}] {title} ({year}) - TMDB:{mid} - {status_map.get(status, \"unknown\")}')
" 2>/dev/null || echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
results = data.get('results', [])[:15]
if not results:
    print('No results found.')
    sys.exit(0)
for r in results:
    mt = r.get('mediaType', 'unknown')
    title = r.get('title') or r.get('name', 'Unknown')
    mid = r.get('id', '?')
    print(f'  [{mt.upper():5}] {title} - TMDB:{mid}')
"
}

cmd_stats() {
  local response
  response=$(api_get "/request/count")
  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Requests: {d.get(\"total\",0)} total')
print(f'  Movies: {d.get(\"movie\",0)}  TV: {d.get(\"tv\",0)}')
print(f'  Pending: {d.get(\"pending\",0)}  Approved: {d.get(\"approved\",0)}  Declined: {d.get(\"declined\",0)}')
print(f'  Processing: {d.get(\"processing\",0)}  Available: {d.get(\"available\",0)}')
"
}

cmd_requests() {
  local filter_status="" filter_type="" limit=10

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --status) filter_status="$2"; shift 2 ;;
      --type) filter_type="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local endpoint="/request?take=${limit}&sort=added"
  local response
  response=$(api_get "$endpoint")

  # Resolve titles by fetching movie/TV details for each request
  echo "$response" | python3 -c "
import sys, json, urllib.request

api_base = '$API_BASE'
api_key = '$API_KEY'

def fetch_title(media_type, tmdb_id):
    endpoint = f'/movie/{tmdb_id}' if media_type == 'movie' else f'/tv/{tmdb_id}'
    try:
        req = urllib.request.Request(f'{api_base}{endpoint}', headers={'X-Api-Key': api_key})
        with urllib.request.urlopen(req, timeout=5) as resp:
            d = json.loads(resp.read())
            return d.get('title') or d.get('name', f'TMDB:{tmdb_id}')
    except:
        return f'TMDB:{tmdb_id}'

data = json.load(sys.stdin)
results = data.get('results', []) if isinstance(data, dict) else data

status_map = {1:'pending', 2:'approved', 3:'declined', 4:'processing', 5:'completed'}
type_filter = '$filter_type'.lower() if '$filter_type' else ''
status_filter = '$filter_status'.lower() if '$filter_status' else ''

shown = 0
for r in results:
    mt = r.get('type', 'unknown')
    media = r.get('media', {})
    tmdb_id = media.get('tmdbId')
    title = fetch_title(mt, tmdb_id) if tmdb_id else 'Unknown'
    st = r.get('status', 0)
    st_str = status_map.get(st, f'unknown({st})')
    date = r.get('createdAt', '')[:10]
    user = r.get('requestedBy', {}).get('displayName', '?')

    if type_filter and mt.lower() != type_filter:
        continue
    if status_filter and st_str.split('(')[0] != status_filter:
        continue

    print(f'  [{mt.upper():5}] {title} - {st_str} - requested {date} by {user}')
    shown += 1

if shown == 0:
    print('No matching requests found.')
" 2>/dev/null || echo "Error parsing response"
}

cmd_request() {
  local media_type="$1"  # movie or tv
  local tmdb_id="$2"
  local seasons="${3:-}"

  if [[ "$media_type" != "movie" && "$media_type" != "tv" ]]; then
    echo "Error: media type must be 'movie' or 'tv'"
    exit 1
  fi

  local body
  if [[ "$media_type" == "movie" ]]; then
    body="{\"mediaType\":\"movie\",\"mediaId\":${tmdb_id}}"
  else
    if [[ -n "$seasons" ]]; then
      # Parse seasons like "1,2,3" into JSON array
      local seasons_json
      seasons_json=$(echo "$seasons" | tr ',' '\n' | python3 -c "import sys,json; print(json.dumps([int(l.strip()) for l in sys.stdin if l.strip()]))")
      body="{\"mediaType\":\"tv\",\"mediaId\":${tmdb_id},\"seasons\":${seasons_json}}"
    else
      body="{\"mediaType\":\"tv\",\"mediaId\":${tmdb_id}}"
    fi
  fi

  local response
  response=$(api_post "/request" "$body")

  echo "$response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
rid = d.get('id', '?')
mt = d.get('type', '?')
st = {1:'pending', 2:'approved', 3:'declined'}.get(d.get('status', 0), 'unknown')
media = d.get('media', {})
title = media.get('title') or media.get('name', '?')
print(f'Request #{rid}: {title} ({mt}) - Status: {st}')
" 2>/dev/null || echo "Request submitted. Response: $response"
}

# Main
cmd="${1:-}"
shift || true

case "$cmd" in
  search)
    [[ -z "${1:-}" ]] && echo "Usage: jellyseerr.sh search \"query\"" && exit 1
    cmd_search "$*"
    ;;
  stats)
    cmd_stats
    ;;
  requests)
    cmd_requests "$@"
    ;;
  request)
    [[ -z "${1:-}" || -z "${2:-}" ]] && echo "Usage: jellyseerr.sh request <movie|tv> <tmdb_id> [--seasons 1,2,3]" && exit 1
    media_type="$1"
    tmdb_id="$2"
    seasons=""
    if [[ "${3:-}" == "--seasons" ]]; then
      seasons="${4:-}"
    fi
    cmd_request "$media_type" "$tmdb_id" "$seasons"
    ;;
  *)
    echo "Jellyseerr CLI"
    echo ""
    echo "Usage:"
    echo "  jellyseerr.sh search \"query\"         - Search movies & TV"
    echo "  jellyseerr.sh stats                   - Request summary stats"
    echo "  jellyseerr.sh requests [--status X] [--type X] [--limit N]"
    echo "                                        - List requests"
    echo "  jellyseerr.sh request <movie|tv> <id> [--seasons 1,2,3]"
    echo "                                        - Request new media"
    exit 1
    ;;
esac
