#!/usr/bin/env bash
# qBittorrent WebUI CLI — add / list / status / pause / resume / remove.
# Designed to consume `prowlarr.sh grab N --json` output via stdin or --json-file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Per-user scratch files.
CACHE_FILE="${TMPDIR:-/tmp}/qbittorrent_torrents_${USER:-default}.json"
RAW_FILE="${TMPDIR:-/tmp}/qbittorrent_raw_${USER:-default}.json"
COOKIE_JAR="${TMPDIR:-/tmp}/qbittorrent_cookie_${USER:-default}.jar"
# Exported so the python resolver (run via command substitution) can read them.
export CACHE_FILE RAW_FILE

# Load .env
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${QBITTORRENT_URL:-}" || -z "${QBITTORRENT_USERNAME:-}" || -z "${QBITTORRENT_PASSWORD:-}" ]]; then
  echo "Error: QBITTORRENT_URL, QBITTORRENT_USERNAME, and QBITTORRENT_PASSWORD must be set in $ENV_FILE"
  echo "Copy $SCRIPT_DIR/../.env.example to $SCRIPT_DIR/../.env and fill in values."
  exit 1
fi

API_BASE="${QBITTORRENT_URL%/}/api/v2"

# --- auth + http helpers -----------------------------------------------------

qbt_login() {
  local resp
  resp=$(curl -s -c "$COOKIE_JAR" \
    --data-urlencode "username=$QBITTORRENT_USERNAME" \
    --data-urlencode "password=$QBITTORRENT_PASSWORD" \
    "$API_BASE/auth/login")
  if [[ "$resp" != "Ok." ]]; then
    echo "Error: qBittorrent login failed (response: \"$resp\"). Check creds in $ENV_FILE." >&2
    exit 1
  fi
}

api_get() {  # $1 = endpoint incl. query string
  curl -fs -b "$COOKIE_JAR" "$API_BASE$1"
}
api_post() {  # $1 = endpoint; rest = curl data flags
  local endpoint="$1"; shift
  curl -fs -b "$COOKIE_JAR" "$@" "$API_BASE$endpoint"
}

# --- add ---------------------------------------------------------------------

cmd_add() {
  local category="" savepath="" tags="" name="" json_file=""
  local positional=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --category|-C) category="$2"; shift 2 ;;
      --save-path|--savepath|-p) savepath="$2"; shift 2 ;;
      --tags|-t) tags="$2"; shift 2 ;;
      --name|-n) name="$2"; shift 2 ;;
      --json-file) json_file="$2"; shift 2 ;;
      --*) echo "Unknown option: $1" >&2; shift ;;
      *) positional+=("$1"); shift ;;
    esac
  done

  if [[ -z "$category" ]]; then
    echo "Error: --category is required for add (matches how sonarr/radarr use tv-sonarr/radarr)." >&2
    echo "Existing categories can be listed via './scripts/qbittorrent.sh list --json' (categories field)." >&2
    echo "A new category is auto-created if it does not exist." >&2
    exit 1
  fi

  qbt_login

  # Ensure category exists (auto-create). getCategories returns a JSON map.
  local cat_exists
  cat_exists=$(api_get /torrents/categories | python3 -c "import json,sys; print('true' if '$category' in json.load(sys.stdin) else 'false')")
  if [[ "$cat_exists" != "true" ]]; then
    api_post /torrents/createCategory --data-urlencode "category=$category" --data-urlencode "savePath=" >/dev/null \
      || { echo "Error: failed to auto-create category '$category'." >&2; exit 1; }
    echo "Created category '$category'." >&2
  fi

  # Resolve input: --json-file > piped stdin > positional magnet/url.
  local input_json=""
  if [[ -n "$json_file" ]]; then
    [[ -f "$json_file" ]] || { echo "Error: --json-file not found: $json_file" >&2; exit 1; }
    input_json=$(cat "$json_file")
  elif [[ ! -t 0 ]]; then
    input_json=$(cat)
  fi

  local urls_to_add=() names_to_add=()

  if [[ -n "$input_json" ]]; then
    # prowlarr grab/search --json shape: object or array of objects with
    # magnet_url and/or download_url. Prefer magnet, fall back to download.
    while IFS= read -r pair; do
      [[ -z "$pair" ]] && continue
      local u="${pair%%$'\t'*}"; local t="${pair##*$'\t'}"
      [[ "$u" == "$t" ]] && t=""
      urls_to_add+=("$u")
      names_to_add+=("$t")
    done < <(INPUT_JSON="$input_json" python3 <<'PYEOF'
import json, os
raw = os.environ["INPUT_JSON"]
data = json.loads(raw)
if isinstance(data, dict):
    data = [data]
for r in data:
    url = r.get("magnet_url") or r.get("download_url") or r.get("magnetUrl") or r.get("downloadUrl") or ""
    title = r.get("title", "")
    if url:
        print(f"{url}\t{title}")
PYEOF
)
    if [[ ${#urls_to_add[@]} -eq 0 ]]; then
      echo "Error: no magnet_url/download_url found in piped JSON." >&2
      exit 1
    fi
  else
    if [[ ${#positional[@]} -eq 0 ]]; then
      echo "Usage: qbittorrent.sh add <magnet|url> --category <c> [--save-path P] [--tags a,b] [--name N]" >&2
      echo "       prowlarr.sh grab N --json | qbittorrent.sh add --category <c>" >&2
      echo "       qbittorrent.sh add --json-file result.json --category <c>" >&2
      exit 1
    fi
    for u in "${positional[@]}"; do urls_to_add+=("$u"); names_to_add+=(""); done
  fi

  # Classify and prepare: magnet URIs are passed through qBittorrent's `urls`
  # param; http(s) .torrent URLs are fetched HOST-SIDE and uploaded as files.
  # The host-side fetch is essential for Prowlarr's proxied download links,
  # which use http://localhost:9696/... and are only reachable on the host —
  # qBittorrent fetches `urls` from inside its container and cannot reach them.
  local tmp_dir
  tmp_dir=$(mktemp -d)
  local magnet_blob="" file_args=() fetched=0
  for i in "${!urls_to_add[@]}"; do
    local u="${urls_to_add[$i]}"
    if [[ "$u" == magnet:* ]]; then
      magnet_blob+="${u}"$'\n'
      continue
    fi
    if [[ "$u" != http://* && "$u" != https://* ]]; then
      echo "Error: not a magnet: or http(s):// URL: $u" >&2
      rm -rf "$tmp_dir"; exit 1
    fi
    # Resolve the URL host-side. Prowlarr's proxied download links may redirect
    # to a magnet: URI (TPB et al.) or to the real .torrent. Follow redirects
    # manually — curl -L cannot follow a magnet: scheme.
    local cur="$u" resolved=0 redir=""
    for _ in 1 2 3 4 5 6; do
      redir=$(curl -s -o /dev/null -w "%{redirect_url}" --max-time 20 "$cur" 2>/dev/null || true)
      if [[ "$redir" == magnet:* ]]; then
        magnet_blob+="${redir}"$'\n'; resolved=1; break
      elif [[ -n "$redir" ]]; then
        cur="$redir"; continue
      else
        local tf="$tmp_dir/torrent_${i}.torrent"
        if curl -fsSL --max-time 30 -o "$tf" "$cur"; then
          file_args+=(-F "torrents=@${tf}"); fetched=$((fetched+1)); resolved=1
        fi
        break
      fi
    done
    if [[ "$resolved" -ne 1 ]]; then
      echo "Error: failed to resolve/fetch .torrent from: $u" >&2
      rm -rf "$tmp_dir"; exit 1
    fi
  done

  # rename is only meaningful for a single torrent (multi ordering is undefined).
  local rename_val=""
  if [[ ${#urls_to_add[@]} -eq 1 ]]; then
    local n="${names_to_add[0]}"
    [[ -z "$n" ]] && n="$name"
    [[ -n "$n" ]] && rename_val="$n"
  fi

  # multipart/form-data POST (supports both file uploads and form fields).
  local args=(-F "category=$category")
  [[ -n "$savepath" ]] && args+=(-F "savepath=$savepath")
  [[ -n "$tags" ]] && args+=(-F "tags=$tags")
  [[ -n "$magnet_blob" ]] && args+=(-F "urls=$magnet_blob")
  [[ ${#file_args[@]} -gt 0 ]] && args+=("${file_args[@]}")
  [[ -n "$rename_val" ]] && args+=(-F "rename=$rename_val")

  local resp
  resp=$(curl -fs -b "$COOKIE_JAR" "${args[@]}" "$API_BASE/torrents/add") \
    || { rm -rf "$tmp_dir"; echo "Error: add request failed." >&2; exit 1; }
  rm -rf "$tmp_dir"

  if [[ "$resp" == "Ok." ]]; then
    local via=""
    [[ $fetched -gt 0 ]] && via=" ($fetched .torrent uploaded host-side)"
    echo "Added ${#urls_to_add[@]} torrent(s) to category '$category'${via}."
    [[ -n "$savepath" ]] && echo "save-path: $savepath"
    [[ -n "$tags" ]] && echo "tags: $tags"
    echo "Run './scripts/qbittorrent.sh list' to see it."
  else
    echo "Error: add failed (response: \"$resp\")." >&2
    exit 1
  fi
}

# --- list --------------------------------------------------------------------

cmd_list() {
  local filter="" category="" tag="" format="compact" limit=50

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --filter|-f) filter="$2"; shift 2 ;;
      --category|-C) category="$2"; shift 2 ;;
      --tag) tag="$2"; shift 2 ;;
      --limit|-l) limit="$2"; shift 2 ;;
      --json) format="json"; shift ;;
      --detail|-d) format="detail"; shift ;;
      --*) echo "Unknown option: $1" >&2; shift ;;
      *) echo "Unknown arg: $1" >&2; shift ;;
    esac
  done

  qbt_login

  local endpoint="/torrents/info"
  local sep="?"
  [[ -n "$filter" ]]   && { endpoint="${endpoint}${sep}filter=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$filter")"; sep="&"; }
  [[ -n "$category" ]] && { endpoint="${endpoint}${sep}category=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$category")"; sep="&"; }
  [[ -n "$tag" ]]      && { endpoint="${endpoint}${sep}tag=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$tag")"; sep="&"; }

  if ! api_get "$endpoint" > "$RAW_FILE"; then
    echo "Error: qBittorrent request failed." >&2; exit 1
  fi

  FORMAT="$format" LIMIT="$limit" CACHE_FILE="$CACHE_FILE" RAW_FILE="$RAW_FILE" python3 <<'PYEOF'
import json, os, sys

with open(os.environ["RAW_FILE"]) as f:
    data = json.load(f)
data.sort(key=lambda t: t.get("added_on", 0), reverse=True)

limit = int(os.environ["LIMIT"])
data = data[:limit]

# Cache for #N index resolution in status/pause/resume/remove.
with open(os.environ["CACHE_FILE"], "w") as f:
    json.dump(data, f)

def fmt_size(b):
    b = float(b or 0)
    for u in ["B","KB","MB","GB"]:
        if b < 1024: return f"{b:.0f}{u}" if u=="B" else f"{b:.1f}{u}"
        b /= 1024
    return f"{b:.1f}TB"

def fmt_speed(b):
    b = float(b or 0)
    if b < 1024: return f"{b:.0f}B/s"
    return fmt_size(b) + "/s"

def state_label(s):
    m = {
      'downloadingDL':'downloading','uploadingUP':'seeding','forcedDL':'downloading','forcedUP':'seeding',
      'stalledDL':'stalled','stalledUP':'stalled',
      'queuedDL':'queued','queuedUP':'queued',
      'pausedDL':'paused','pausedUP':'paused','stoppedDL':'stopped','stoppedUP':'stopped',
      'checkingDL':'checking','checkingUP':'checking','checkingResumeData':'checking','checkingURL':'checking',
      'allocating':'allocating','metaDL':'metadata','forcedMetaDL':'metadata',
      'moving':'moving','error':'error','missingFiles':'missing',
    }
    return m.get(s, s)

fmt = os.environ["FORMAT"]
if not data:
    print("No torrents.")
    sys.exit(0)

if fmt == "json":
    slim = [{
        "index": i+1, "hash": t.get("hash",""), "name": t.get("name",""),
        "size": t.get("size",0), "size_human": fmt_size(t.get("size",0)),
        "progress": round(t.get("progress",0)*100,1),
        "state": t.get("state",""), "state_label": state_label(t.get("state","")),
        "dlspeed": fmt_speed(t.get("dlspeed",0)), "upspeed": fmt_speed(t.get("upspeed",0)),
        "ratio": round(t.get("ratio",0),2), "eta": t.get("eta",0),
        "category": t.get("category",""), "tags": t.get("tags",""),
        "save_path": t.get("save_path",""),
    } for i,t in enumerate(data)]
    print(json.dumps(slim, indent=2)); sys.exit(0)

# compact (default)
for i,t in enumerate(data):
    pct = round(t.get("progress",0)*100)
    dl = t.get("dlspeed",0)
    speed = f" ↓{fmt_speed(dl)}" if dl else ""
    print(f"  [{i+1}] {pct:>3}% {state_label(t.get('state','')):<11} {fmt_size(t.get('size',0)):<7}{speed:<13} {t.get('name','')}")
PYEOF
}

# --- selector resolution (status/pause/resume/remove) -----------------------

# Fetches fresh torrent list to RAW_FILE, then resolves selectors to hashes.
# Selectors: "#N" (from list cache), 40-hex hash, or name substring.
# Prints pipe-joined hashes to stdout, human summary to stderr.
# Env:  SELECTORS (newline-sep)  ALL (true/false)  RAW_FILE  CACHE_FILE
resolve_hashes() {
  python3 <<'PYEOF'
import json, os, sys, re

sels = [s for s in os.environ.get("SELECTORS","").split("\n") if s]
allow_all = os.environ.get("ALL","") == "true"

with open(os.environ["RAW_FILE"]) as f:
    torrents = json.load(f)
by_hash = {t.get("hash",""): t for t in torrents}

cache = []
if os.path.exists(os.environ["CACHE_FILE"]):
    try:
        with open(os.environ["CACHE_FILE"]) as f:
            cache = json.load(f)
    except Exception:
        cache = []

def find_name(sub):
    sub_l = sub.lower()
    matches = [t for t in torrents if sub_l in t.get("name","").lower()]
    return matches

resolved = []
errors = []
for s in sels:
    s = s.strip()
    if re.fullmatch(r"[0-9a-fA-F]{40}", s):                 # exact 40-hex hash
        resolved.append(s.lower())
        print(f"  {s[:12]}… -> {by_hash.get(s.lower(),{}).get('name','(not found)')[:50]}", file=sys.stderr)
    elif (s.startswith("#") and s[1:].isdigit()) or s.isdigit():   # [N] index (bare or #N)
        idx = int(s.lstrip("#"))
        if idx < 1 or idx > len(cache):
            errors.append(f"{s}: index out of range (1-{len(cache)}); run 'list' first.")
            continue
        resolved.append(cache[idx-1].get("hash",""))
        print(f"  [{idx}] -> {cache[idx-1].get('name','')[:50]}", file=sys.stderr)
    else:                                                     # case-insensitive name substring
        matches = find_name(s)
        if not matches:
            errors.append(f"{s!r}: no matching torrent."); continue
        if len(matches) > 1 and not allow_all:
            errors.append(f"{s!r}: ambiguous ({len(matches)} matches). Re-run with --all or a more specific name/hash.")
            for m in matches[:8]:
                print(f"      {m.get('hash','')[:12]}  {m.get('name','')[:50]}", file=sys.stderr)
            continue
        for m in matches:
            resolved.append(m.get("hash",""))
            print(f"  {s!r} -> {m.get('name','')[:50]}", file=sys.stderr)

if errors:
    for e in errors: print(f"  Error: {e}", file=sys.stderr)
    sys.exit(2)

# dedupe, preserve order
seen=set(); out=[]
for h in resolved:
    if h and h not in seen:
        seen.add(h); out.append(h)
print("|".join(out))
PYEOF
}

cmd_status() {
  local format="detail"
  local selectors=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json) format="json"; shift ;;
      --*) echo "Unknown option: $1" >&2; shift ;;
      *) selectors+=("$1"); shift ;;
    esac
  done
  [[ ${#selectors[@]} -eq 0 ]] && { echo "Usage: qbittorrent.sh status <hash|#N|name> [--json]" >&2; exit 1; }
  qbt_login
  api_get /torrents/info > "$RAW_FILE" || { echo "Error: request failed." >&2; exit 1; }
  SELECTORS=$(printf '%s\n' "${selectors[@]}"); ALL=false; export SELECTORS ALL
  local hashes
  hashes=$(resolve_hashes) || exit 1
  [[ -z "$hashes" ]] && { echo "No torrent resolved." >&2; exit 1; }

  FORMAT="$format" HASHES="$hashes" RAW_FILE="$RAW_FILE" python3 <<'PYEOF'
import json, os, sys
hashes = os.environ["HASHES"].split("|")
with open(os.environ["RAW_FILE"]) as f:
    torrents = json.load(f)
sel = {h.lower() for h in hashes}
match = [t for t in torrents if t.get("hash","").lower() in sel]

def fmt_size(b):
    b=float(b or 0)
    for u in ["B","KB","MB","GB"]:
        if b<1024: return f"{b:.0f}{u}" if u=="B" else f"{b:.1f}{u}"
        b/=1024
    return f"{b:.1f}TB"
def fmt_speed(b):
    b=float(b or 0)
    if b<1024: return f"{b:.0f}B/s"
    return fmt_size(b)+"/s"
def fmt_eta(s):
    s=int(s or 0)
    if s<=0: return "—"
    h,r=divmod(s,3600); m,sec=divmod(r,60)
    return f"{h}h{m}m" if h else f"{m}m{sec}s"

if os.environ["FORMAT"]=="json":
    out=[{k:t.get(k) for k in ["hash","name","size","progress","state","dlspeed","upspeed",
        "ratio","eta","num_seeds","num_leechs","num_complete","num_incomplete",
        "category","tags","save_path","content_path","added_on","completion_on","seeding_time"]} for t in match]
    print(json.dumps(out, indent=2)); sys.exit(0)

for t in match:
    print(f"  {t.get('name','')}")
    print(f"      Hash:      {t.get('hash','')}")
    print(f"      State:     {t.get('state','')}  ({round(t.get('progress',0)*100,1)}%)")
    print(f"      Size:      {fmt_size(t.get('size',0))}")
    print(f"      Down/Up:   {fmt_speed(t.get('dlspeed',0))} / {fmt_speed(t.get('upspeed',0))}")
    print(f"      Ratio:     {round(t.get('ratio',0),2)}   ETA: {fmt_eta(t.get('eta',0))}")
    print(f"      Seeds/Leech: {t.get('num_seeds',0)}/{t.get('num_leechs',0)}  (seen {t.get('num_complete',0)}/{t.get('num_incomplete',0)})")
    print(f"      Category:  {t.get('category','')}   Tags: {t.get('tags','') or '(none)'}")
    print(f"      Save:      {t.get('save_path','')}")
    print()
PYEOF
}

# pause/resume share logic. $1=endpoint (stop|start), rest=args.
cmd_lifecycle() {
  local endpoint="$1"; shift
  local allow_all=false
  local selectors=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all) allow_all=true; shift ;;
      --*) echo "Unknown option: $1" >&2; shift ;;
      *) selectors+=("$1"); shift ;;
    esac
  done
  [[ ${#selectors[@]} -eq 0 ]] && { echo "Usage: qbittorrent.sh <pause|resume> <hash|#N|name> [--all]" >&2; exit 1; }
  qbt_login
  api_get /torrents/info > "$RAW_FILE" || { echo "Error: request failed." >&2; exit 1; }
  SELECTORS=$(printf '%s\n' "${selectors[@]}"); ALL="$allow_all"; export SELECTORS ALL
  local hashes
  hashes=$(resolve_hashes) || { echo "Resolve failed; nothing changed." >&2; exit 1; }
  [[ -z "$hashes" ]] && { echo "No torrent resolved." >&2; exit 1; }
  api_post "/torrents/$endpoint" --data-urlencode "hashes=$hashes" >/dev/null || { echo "Error: $endpoint failed." >&2; exit 1; }
  echo "$endpoint ok (${hashes//|/ } )."
}

cmd_remove() {
  local delete_files=false allow_all=false
  local selectors=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --delete-files) delete_files=true; shift ;;
      --all) allow_all=true; shift ;;
      --*) echo "Unknown option: $1" >&2; shift ;;
      *) selectors+=("$1"); shift ;;
    esac
  done
  [[ ${#selectors[@]} -eq 0 ]] && { echo "Usage: qbittorrent.sh remove <hash|#N|name> [--delete-files] [--all]" >&2; exit 1; }
  qbt_login
  api_get /torrents/info > "$RAW_FILE" || { echo "Error: request failed." >&2; exit 1; }
  SELECTORS=$(printf '%s\n' "${selectors[@]}"); ALL="$allow_all"; export SELECTORS ALL
  local hashes
  hashes=$(resolve_hashes) || { echo "Resolve failed; nothing changed." >&2; exit 1; }
  [[ -z "$hashes" ]] && { echo "No torrent resolved." >&2; exit 1; }
  if [[ "$delete_files" == "true" ]]; then
    echo "WARNING: deleting downloaded data for: ${hashes//|/ }" >&2
  fi
  api_post /torrents/delete --data-urlencode "hashes=$hashes" --data-urlencode "deleteFiles=$delete_files" >/dev/null \
    || { echo "Error: delete failed." >&2; exit 1; }
  echo "Removed (${hashes//|/ })$( [[ "$delete_files" == "true" ]] && echo " + data")."
}

# --- main --------------------------------------------------------------------

cmd="${1:-help}"
shift || true

case "$cmd" in
  add)     cmd_add "$@" ;;
  list)    cmd_list "$@" ;;
  status)  cmd_status "$@" ;;
  pause)   cmd_lifecycle stop "$@" ;;
  resume)  cmd_lifecycle start "$@" ;;
  remove)  cmd_remove "$@" ;;
  help|--help|-h|"")
    cat <<'EOF'
qBittorrent CLI

Add torrents (magnet or .torrent URL) to qBittorrent and manage them.

Usage:
  qbittorrent.sh add <magnet|url> --category <c> [options]
      --category <c>        REQUIRED. Auto-created if new.
      --save-path <path>    override save location
      --tags <a,b>          comma-separated tags
      --name <n>            rename torrent
      --json-file <f>       add from a prowlarr grab/search --json file
      (stdin)               pipe prowlarr `grab N --json` or `search --json`

  qbittorrent.sh list [options]
      --filter <f>          all|downloading|seeding|completed|paused|active|inactive|stalled
      --category <c>        filter by category
      --tag <t>             filter by tag
      --limit <N>           default 50
      --json                machine-readable output
      -d, --detail           (reserved)

  qbittorrent.sh status <hash|#N|name> [--json]

  qbittorrent.sh pause  <hash|#N|name> [...] [--all]
  qbittorrent.sh resume <hash|#N|name> [...] [--all]
  qbittorrent.sh remove <hash|#N|name> [...] [--delete-files] [--all]

Selectors:
  #N            result [N] from the last 'list'
  <40-hex hash> exact torrent hash
  <name>        substring match (ambiguous unless --all)

Workflow (prowlarr -> qbittorrent):
  ./scripts/prowlarr.sh search "ubuntu 24.04" --category pc --json
  ./scripts/prowlarr.sh grab 1 --json | ./scripts/qbittorrent.sh add --category linux
  ./scripts/qbittorrent.sh list
EOF
    ;;
  *) echo "Unknown command: $cmd (try 'help')" >&2; exit 1 ;;
esac
