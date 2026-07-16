#!/usr/bin/env bash
# Stand up a disposable Linux test box for trying install.sh.
# Works with Apple `container`, Docker, or Podman (auto-detected, or set CONTAINER_ENGINE).
set -euo pipefail

IMAGE_NAME="agentic-workflow-test"
CONTAINER_NAME="agentic-workflow-test"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

detect_engine() {
    if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
        command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
            echo "error: CONTAINER_ENGINE=${CONTAINER_ENGINE} not found in PATH" >&2
            exit 1
        }
        echo "$CONTAINER_ENGINE"
        return
    fi
    for e in container docker podman; do
        command -v "$e" >/dev/null 2>&1 && { echo "$e"; return; }
    done
    echo "error: no container engine found (looked for: container, docker, podman)" >&2
    exit 1
}

ENGINE="$(detect_engine)"

usage() {
    cat <<EOF
Usage: $0 [build|start|shell|stop|rm|status]

  build   Build (or rebuild) the ${IMAGE_NAME} image
  start   Start the container in the background (builds image if missing)
  shell   Exec an interactive shell into the running container
  stop    Stop the container
  rm      Stop and remove the container
  status  Show container status

With no args: build (if needed) + start + shell.

Engine: ${ENGINE} (override with CONTAINER_ENGINE=container|docker|podman)

Note: the image COPYs the repo in at build time, so re-run `build` after
local changes to pick them up.
EOF
}

ensure_engine_ready() {
    case "$ENGINE" in
    container)
        if ! container system status >/dev/null 2>&1; then
            echo "==> starting container system service"
            container system start
        fi
        ;;
    docker | podman)
        if ! "$ENGINE" info >/dev/null 2>&1; then
            echo "error: $ENGINE daemon not reachable (is it running?)" >&2
            exit 1
        fi
        ;;
    esac
}

image_exists() {
    "$ENGINE" image inspect "${IMAGE_NAME}:latest" >/dev/null 2>&1
}

container_running() {
    case "$ENGINE" in
    container)
        container list --format json 2>/dev/null | grep -q "\"id\":\"${CONTAINER_NAME}\""
        ;;
    docker | podman)
        [[ -n "$("$ENGINE" ps -q --filter "name=^${CONTAINER_NAME}\$" 2>/dev/null)" ]]
        ;;
    esac
}

container_exists() {
    case "$ENGINE" in
    container)
        container list --all --format json 2>/dev/null | grep -q "\"id\":\"${CONTAINER_NAME}\""
        ;;
    docker | podman)
        [[ -n "$("$ENGINE" ps -aq --filter "name=^${CONTAINER_NAME}\$" 2>/dev/null)" ]]
        ;;
    esac
}

do_build() {
    ensure_engine_ready
    echo "==> building image ${IMAGE_NAME} (${ENGINE})"
    "$ENGINE" build -t "${IMAGE_NAME}" "${SCRIPT_DIR}"
}

do_start() {
    ensure_engine_ready
    image_exists || do_build
    if container_running; then
        echo "==> ${CONTAINER_NAME} already running"
        return
    fi
    container_exists && "$ENGINE" rm -f "${CONTAINER_NAME}" >/dev/null 2>&1
    echo "==> starting ${CONTAINER_NAME}"
    "$ENGINE" run -d --name "${CONTAINER_NAME}" "${IMAGE_NAME}" sleep infinity
}

do_shell() {
    container_running || do_start
    "$ENGINE" exec -it "${CONTAINER_NAME}" /bin/bash
}

do_stop() {
    "$ENGINE" stop "${CONTAINER_NAME}" 2>/dev/null || true
}

do_rm() {
    do_stop
    "$ENGINE" rm "${CONTAINER_NAME}" 2>/dev/null || true
}

do_status() {
    case "$ENGINE" in
    container) container list --all ;;
    docker | podman) "$ENGINE" ps -a --filter "name=${CONTAINER_NAME}" ;;
    esac
}

cmd="${1:-}"
case "$cmd" in
    build) do_build ;;
    start) do_start ;;
    shell) do_shell ;;
    stop) do_stop ;;
    rm) do_rm ;;
    status) do_status ;;
    "") do_start && do_shell ;;
    *) usage; exit 1 ;;
esac
