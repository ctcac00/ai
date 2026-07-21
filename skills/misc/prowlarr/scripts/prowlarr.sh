#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Cache: store last search results so `grab <N>` can resolve by index.
CACHE_FILE="${TMPDIR:-/tmp}/prowlarr_results_${USER:-default}.json"

# Load .env
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${PROWLARR_URL:-}" || -z "${PROWLARR_API_KEY:-}" ]]; then
  echo "Error: PROWLARR_URL and PROWLARR_API_KEY must be set in $ENV_FILE"
  echo "Copy $SCRIPT_DIR/../.env.example to $SCRIPT_DIR/../.env and fill in values."
  exit 1
fi

API_BASE="${PROWLARR_URL%/}/api/v1"
API_KEY="$PROWLARR_API_KEY"

api_get() {
  local endpoint="$1"
  curl -s -f -H "X-Api-Key: $API_KEY" "${API_BASE}${endpoint}"
}

# Resolve a user-supplied category (name or number) into Prowlarr category IDs.
# Prowlarr uses Newznab-style categories; aliases map common names to roots.
resolve_category() {
  local input="${1,,}"  # lowercase
  case "$input" in
    movie|movies|film)            echo "2000" ;;
    tv|tvshow|tvshows|series)     echo "5000" ;;
    audio|music|mp3|flac)         echo "3000" ;;
    book|books|ebook|ebooks)      echo "7000" ;;
    pc|software|games-pc|apps)    echo "4000" ;;
    console|console-games)        echo "1000" ;;
    xxx|adult)                    echo "6000" ;;
    other)                        echo "0" ;;
    *)                            echo "$input" ;;  # assume already numeric
  esac
}

cmd_search() {
  local query="" category="" indexer="" limit=15 format="compact"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --category|-c) category="$(resolve_category "$2")"; shift 2 ;;
      --indexer|-i)  indexer="$2"; shift 2 ;;
      --limit|-l)    limit="$2"; shift 2 ;;
      --format|-f)   format="$2"; shift 2 ;;
      --detail|-d)   format="detail"; shift ;;
      --json)        format="json"; shift ;;
      --*)           echo "Unknown option: $1" >&2; shift ;;
      *)             query="$query $1"; shift ;;
    esac
  done
  query="${query# }"

  if [[ -z "$query" ]]; then
    echo "Usage: prowlarr.sh search \"query\" [--category <movies|tv|audio|books|id>] [--indexer <name|id>] [--limit N] [--format compact|detail|json] [--detail] [--json]"
    exit 1
  fi

  local enc_query
  enc_query=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$query")

  local endpoint="/search?query=${enc_query}&type=search&limit=500&offset=0"
  [[ -n "$category" ]] && endpoint="${endpoint}&categories=${category}"
  [[ -n "$indexer" ]]  && endpoint="${endpoint}&indexerIds=${indexer}"

  local raw_file
  raw_file="${TMPDIR:-/tmp}/prowlarr_raw_${USER:-default}.json"
  if ! api_get "$endpoint" > "$raw_file"; then
    echo "Error: Prowlarr request failed. Check PROWLARR_URL and that the server is reachable." >&2
    exit 1
  fi

  # Parse, filter, cache, and render in one python pass. Raw JSON is passed via
  # a temp file (not stdin, which carries the heredoc script).
  FORMAT="$format" LIMIT="$limit" QUERY="$query" \
  CACHE_FILE="$CACHE_FILE" RAW_FILE="$raw_file" \
  python3 <<'PYEOF'
import json, os, sys

with open(os.environ["RAW_FILE"]) as f:
    data = json.load(f)
if not isinstance(data, list):
    print("Error: unexpected response shape", file=sys.stderr)
    sys.exit(1)

# Normalize + dedupe by infoHash (fall back to guid) so the same release from
# multiple indexers doesn't crowd the list. Keep the copy with the most seeders.
def key(r):
    h = r.get("infoHash")
    return h if h else r.get("guid", id(r))

best = {}
for r in data:
    k = key(r)
    if k not in best or r.get("seeders", 0) > best[k].get("seeders", 0):
        best[k] = r
results = sorted(best.values(), key=lambda r: r.get("seeders", 0), reverse=True)

limit = int(os.environ["LIMIT"])
results = results[:limit]

# Cache for `grab`.
with open(os.environ["CACHE_FILE"], "w") as f:
    json.dump(results, f)

def fmt_size(b):
    b = float(b or 0)
    for u in ["B","KB","MB","GB"]:
        if b < 1024:
            return f"{b:.0f}{u}" if u == "B" else f"{b:.1f}{u}"
        b /= 1024
    return f"{b:.1f}TB"

def fmt_age(days):
    d = float(days or 0)
    if d < 1:   return "<1d"
    if d < 60:  return f"{int(d)}d"
    if d < 365: return f"{int(d/30)}mo"
    return f"{int(d/365)}y"

fmt = os.environ["FORMAT"]

if not results:
    print(f"No results for \"{os.environ['QUERY']}\".")
    sys.exit(0)

if fmt == "json":
    # Slim object for AI/programmatic consumption: everything needed to pick
    # a release and hand off to a download client.
    slim = [{
        "index": i + 1,
        "title": r.get("title", ""),
        "size": r.get("size", 0),
        "size_human": fmt_size(r.get("size", 0)),
        "seeders": r.get("seeders", 0),
        "leechers": r.get("leechers", 0),
        "age_days": round(r.get("age", 0)),
        "age_human": fmt_age(r.get("age", 0)),
        "indexer": r.get("indexer", ""),
        "protocol": r.get("protocol", ""),
        "category_ids": [c.get("id") for c in r.get("categories", [])],
        "category_names": [c.get("name", str(c.get("id"))) for c in r.get("categories", [])],
        "info_hash": r.get("infoHash", ""),
        "magnet_url": r.get("magnetUrl", ""),
        "download_url": r.get("downloadUrl", ""),
        "info_url": r.get("infoUrl", ""),
        "publish_date": r.get("publishDate", ""),
    } for i, r in enumerate(results)]
    print(json.dumps(slim, indent=2))
    sys.exit(0)

if fmt == "detail":
    for i, r in enumerate(results):
        s = r.get("seeders", 0); l = r.get("leechers", 0)
        print(f"  [{i+1}] {r.get('title','')}")
        print(f"      Seeders: {s}  Leechers: {l}")
        print(f"      Size: {fmt_size(r.get('size',0))}  Age: {fmt_age(r.get('age',0))}")
        print(f"      Indexer: {r.get('indexer','')}  Protocol: {r.get('protocol','')}")
        cats = [c.get("name", str(c.get("id"))) for c in r.get("categories", [])]
        if cats:
            print(f"      Categories: {', '.join(cats)}")
        if r.get("infoHash"):
            print(f"      Hash: {r['infoHash']}")
        print()
    sys.exit(0)

# compact (default)
for i, r in enumerate(results):
    s = r.get("seeders", 0)
    print(f"  [{i+1}] S:{s:<4} {fmt_size(r.get('size',0)):<7} {fmt_age(r.get('age',0)):<5} {r.get('indexer',''):<10} {r.get('title','')}")
PYEOF
}

cmd_grab() {
  local index="${1:-}"
  local format="magnet"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --format|-f) format="$2"; shift 2 ;;
      --json)      format="json"; shift ;;
      --magnet)    format="magnet"; shift ;;
      --torrent)   format="torrent"; shift ;;
      *)           index="$1"; shift ;;
    esac
  done

  if [[ -z "$index" ]]; then
    echo "Usage: prowlarr.sh grab <index|#N> [--format magnet|torrent|json]"
    echo "  <index> is the [N] number from the last 'search' output."
    exit 1
  fi

  if [[ ! -f "$CACHE_FILE" ]]; then
    echo "Error: no cached search results. Run 'search' first." >&2
    exit 1
  fi

  # Accept "#3" or "3".
  index="${index#\#}"

  FORMAT="$format" INDEX="$index" CACHE_FILE="$CACHE_FILE" python3 <<'PYEOF'
import json, os, sys

with open(os.environ["CACHE_FILE"]) as f:
    results = json.load(f)

idx = int(os.environ["INDEX"])
if idx < 1 or idx > len(results):
    print(f"Error: index {idx} out of range (1-{len(results)}).", file=sys.stderr)
    sys.exit(1)

r = results[idx - 1]
fmt = os.environ["FORMAT"]

if fmt == "json":
    out = {
        "index": idx,
        "title": r.get("title", ""),
        "indexer": r.get("indexer", ""),
        "size": r.get("size", 0),
        "seeders": r.get("seeders", 0),
        "info_hash": r.get("infoHash", ""),
        "magnet_url": r.get("magnetUrl", ""),
        "download_url": r.get("downloadUrl", ""),
    }
    print(json.dumps(out, indent=2))
elif fmt == "torrent":
    url = r.get("downloadUrl", "")
    if not url:
        print("Error: no direct .torrent download URL for this result.", file=sys.stderr)
        sys.exit(1)
    print(url)
elif fmt == "magnet":
    url = r.get("magnetUrl", "") or r.get("downloadUrl", "")
    if not url:
        print("Error: no magnet or download URL for this result.", file=sys.stderr)
        sys.exit(1)
    print(f"# {r.get('title','')}")
    print(url)
PYEOF
}

# Main
cmd="${1:-help}"
shift || true

case "$cmd" in
  search)
    cmd_search "$@"
    ;;
  grab)
    cmd_grab "$@"
    ;;
  *)
    echo "Prowlarr CLI"
    echo ""
    echo "Search across all configured torrent indexers, then grab a release's magnet link."
    echo ""
    echo "Usage:"
    echo "  prowlarr.sh search \"query\" [options]"
    echo "    -c, --category <name|id>   movies, tv, audio, books, pc, console, xxx, other, or numeric"
    echo "    -i, --indexer  <name|id>   restrict to one indexer"
    echo "    -l, --limit    <N>         max results (default 15)"
    echo "    -f, --format   <fmt>       compact (default), detail, json"
    echo "    -d, --detail               shortcut for --format detail"
    echo "        --json                 shortcut for --format json"
    echo ""
    echo "  prowlarr.sh grab <#N> [options]"
    echo "        --magnet    print magnet URL (default)"
    echo "        --torrent   print direct .torrent download URL"
    echo "        --json      full release object (for piping to a download client)"
    echo ""
    echo "Examples:"
    echo "  prowlarr.sh search \"ubuntu 24.04\" --category pc --limit 10"
    echo "  prowlarr.sh search \"debian 12 iso\" --json"
    echo "  prowlarr.sh grab 2 --json"
    exit 0
    ;;
esac
