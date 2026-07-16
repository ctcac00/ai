#!/usr/bin/env bash
# install.sh — install harness binaries + deploy configs + rtk + plugins.
#
# Usage:
#   ./install.sh              # install everything
#   ./install.sh claude       # one harness config: claude | codex | pi | omp | opencode
#   ./install.sh --dry-run    # print plan + overwrite list, write nothing
#   ./install.sh -y|--yes     # don't prompt before overwriting existing files (unattended)
#   ./install.sh --no-rtk     # skip rtk install/init
#   ./install.sh --no-self-claude  # skip agentic-workflow claude plugin install
#   ./install.sh --no-self-pi      # skip agentic-workflow pi package install
#   ./install.sh --no-langfuse  # skip langfuse plugin install
#   ./install.sh --no-caveman   # skip caveman plugin install
#   ./install.sh --no-extra-skills # skip find-skills/skill-creator install
#
# Phases (in order):
#   1. Install harness binaries if missing (claude, pi, omp, opencode, codex)
#   2. rsync repo's .<harness>/ onto ~/.<harness>/ (settings, hooks, extensions)
#   3. Install plugins (langfuse, caveman) + find-skills/skill-creator (claude only)
#   4. rtk init -g for each harness (installs RTK.md + PreToolUse hook)
#
# rtk binary is auto-installed to ~/.local/bin if missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
ASSUME_YES=0
RTK=1
SELF_CLAUDE=1
SELF_PI=1
LANGFUSE=1
CAVEMAN=1
EXTRA_SKILLS=1
HAS_RSYNC=0
command -v rsync >/dev/null 2>&1 && HAS_RSYNC=1

ALL_HARNESSES=(claude codex pi omp opencode)

RTK_INSTALL_URL="https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh"

usage() {
	cat <<EOF
install.sh — install harness binaries + deploy configs + rtk + plugins.

Usage:
  ./install.sh [harness]     harness: ${ALL_HARNESSES[*]} (default: all)
  ./install.sh --dry-run     print plan + overwrite list, write nothing
  ./install.sh -y, --yes     don't prompt before overwriting existing files (unattended)
  ./install.sh --no-rtk      skip rtk install/init
  ./install.sh --no-self-claude  skip agentic-workflow claude plugin install
  ./install.sh --no-self-pi      skip agentic-workflow pi package install
  ./install.sh --no-langfuse skip langfuse plugin install
  ./install.sh --no-caveman  skip caveman plugin install
  ./install.sh --no-extra-skills  skip find-skills/skill-creator install
  ./install.sh -h, --help    this help
EOF
}

src_for() {
	case "$1" in
	claude) printf '%s/.claude' "$SCRIPT_DIR" ;;
	codex) printf '%s/.codex' "$SCRIPT_DIR" ;;
	pi) printf '%s/.pi' "$SCRIPT_DIR" ;;
	omp) printf '%s/.omp' "$SCRIPT_DIR" ;;
	opencode) printf '%s/.config/opencode' "$SCRIPT_DIR" ;;
	*) return 1 ;;
	esac
}
dst_for() {
	case "$1" in
	claude) printf '%s/.claude' "$HOME" ;;
	codex) printf '%s/.codex' "$HOME" ;;
	pi) printf '%s/.pi' "$HOME" ;;
	omp) printf '%s/.omp' "$HOME" ;;
	opencode) printf '%s/.config/opencode' "$HOME" ;;
	*) return 1 ;;
	esac
}

rtk_flag_for() {
	case "$1" in
	claude) printf '%s' "-g" ;;
	codex) printf '%s' "-g --codex" ;;
	pi) printf '%s' "-g --agent pi" ;;
	omp) printf '%s' "-g --agent pi" ;; # oh-my-pi uses the pi integration
	opencode) printf '%s' "-g --opencode" ;;
	*) return 1 ;;
	esac
}

# Parse args.
TARGETS=()
for a in "$@"; do
	case "$a" in
	-h | --help)
		usage
		exit 0
		;;
	-n | --dry-run) DRY_RUN=1 ;;
	-y | --yes) ASSUME_YES=1 ;;
	--no-rtk) RTK=0 ;;
	--no-self-claude) SELF_CLAUDE=0 ;;
	--no-self-pi) SELF_PI=0 ;;
	--no-langfuse) LANGFUSE=0 ;;
	--no-caveman) CAVEMAN=0 ;;
	--no-extra-skills) EXTRA_SKILLS=0 ;;
	claude | codex | pi | omp | opencode) TARGETS+=("$a") ;;
	*)
		echo "error: unknown argument '$a'" >&2
		usage >&2
		exit 2
		;;
	esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("${ALL_HARNESSES[@]}")

# --- colors & icons --------------------------------------------------------

C_RESET='\033[0m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_GREEN='\033[32m'
C_YELLOW='\033[33m'

ICON_OK='✓'
ICON_FAIL='✗'
ICON_WARN='!'
ICON_NEW='+'
ICON_OVERWRITE='~'
ICON_PLAN='→'
ICON_SKIP='○'

# --- helpers ---------------------------------------------------------------

section() {
	printf '\n\033[1m\033[97m%s\033[0m\n' "$*"
	printf '\033[2m%.0s─\033[0m' {1..50}
	printf '\n'
}

subsection() { printf '  \033[1m%s\033[0m\n' "$*"; }

ok() { printf "  \033[32m${ICON_OK}\033[0m  %s\n" "$*"; }
fail() { printf "  \033[31m${ICON_FAIL}\033[0m  %s\n" "$*" >&2; }
warn() { printf "  \033[33m${ICON_WARN}\033[0m  %s\n" "$*" >&2; }
skip() { printf "  \033[2m${ICON_SKIP}  %s\033[0m\n" "$*"; }
plan() { printf "  \033[36m${ICON_PLAN}\033[0m  %s\n" "$*"; }
note() { printf "    \033[2m%s\033[0m\n" "$*"; }
file_new() { printf "    \033[32m${ICON_NEW}\033[0m  %s\n" "$*"; }
file_over() { printf "    \033[33m${ICON_OVERWRITE}\033[0m  %s\n" "$*"; }

# List files that exist at dst (would be overwritten) vs new. Returns overwrite count via $OVERWRITE_COUNT.
dry_run_diff() {
	local src="$1" dst="$2"
	OVERWRITE_COUNT=0
	[ -d "$src" ] || return 0
	local new=0 changed=0
	while IFS= read -r -d '' f; do
		local rel="${f#$src/}"
		if [ -e "$dst/$rel" ]; then
			file_over "$rel"
			changed=$((changed + 1))
		else
			file_new "$rel"
			new=$((new + 1))
		fi
	done < <(find "$src" -type f -print0 | sort -z)
	note "${new} new, ${changed} overwrite"
	OVERWRITE_COUNT=$changed
}

confirm_overwrite() {
	local dst="$1"
	[ "$ASSUME_YES" -eq 1 ] && return 0
	if [ ! -t 0 ]; then
		fail "refusing to overwrite $dst non-interactively — pass -y/--yes to confirm"
		return 1
	fi
	printf "  \033[33mOverwrite ${OVERWRITE_COUNT} existing file(s) under %s?\033[0m [y/N] " "$dst"
	read -r reply
	case "$reply" in
	y | Y | yes | YES) return 0 ;;
	*) return 1 ;;
	esac
}

install_dir() {
	local src="$1" dst="$2"
	[ -d "$src" ] || {
		warn "missing source $src — skip"
		return 0
	}
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "$src/ → $dst/"
		dry_run_diff "$src" "$dst"
		return 0
	fi
	plan "$src/ → $dst/"
	dry_run_diff "$src" "$dst"
	if [ "$OVERWRITE_COUNT" -gt 0 ]; then
		confirm_overwrite "$dst" || {
			skip "$dst — skipped (not confirmed)"
			return 0
		}
	fi
	mkdir -p "$dst"
	if [ "$HAS_RSYNC" -eq 1 ]; then
		rsync -a "$src/" "$dst/"
	else
		cp -a "$src/." "$dst/"
	fi
}

# --- preflight -------------------------------------------------------------

preflight() {
	command -v node >/dev/null 2>&1 || warn "node not on PATH (pi extensions need it)"
}

# --- rtk -------------------------------------------------------------------

ensure_rtk() {
	if command -v rtk >/dev/null 2>&1; then
		ok "rtk $(rtk --version 2>/dev/null || echo present)"
		return 0
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "install rtk → ~/.local/bin"
		return 0
	fi
	note "installing rtk → ~/.local/bin"
	if curl -fsSL "$RTK_INSTALL_URL" | sh; then
		export PATH="$HOME/.local/bin:$PATH"
		command -v rtk >/dev/null 2>&1 && ok "rtk $(rtk --version)" || {
			warn "rtk install finished but rtk not on PATH"
			return 1
		}
	else
		warn "rtk installer failed — install manually: curl -fsSL $RTK_INSTALL_URL | sh"
		return 1
	fi
}

rtk_init() {
	local h="$1" flag patch
	flag="$(rtk_flag_for "$h")"
	# codex/opencode handle their own patching; others need --auto-patch.
	case "$h" in
	codex | opencode) patch="" ;;
	*) patch="--auto-patch" ;;
	esac
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "rtk init $flag $patch"
		return 0
	fi
	if ! command -v rtk >/dev/null 2>&1; then
		warn "rtk missing — skip init for $h"
		return 0
	fi
	# shellcheck disable=SC2086
	rtk init $flag $patch >/dev/null 2>&1 && ok "rtk init $h ($flag)" || warn "rtk init $h returned non-zero"
}

# --- harness binaries ------------------------------------------------------

ensure_bin() {
	local cmd="$1" label="$2" fn="$3"
	if command -v "$cmd" >/dev/null 2>&1; then
		printf "  \033[32m${ICON_OK}\033[0m  %s  \033[2m%s\033[0m\n" "$label" "$(command -v "$cmd")"
		return 0
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "install $label"
		return 0
	fi
	note "installing $label..."
	"$fn" && ok "$label installed" || warn "$label install failed"
}

_install_claude() { npm install -g @anthropic-ai/claude-code; }
_install_pi() {
	# pi's installer prompts via /dev/tty regardless of stdin; setsid detaches
	# the controlling tty so it falls back to its non-interactive default.
	if [ "$ASSUME_YES" -eq 1 ] && command -v setsid >/dev/null 2>&1; then
		curl -fsSL https://pi.dev/install.sh | setsid sh
	else
		curl -fsSL https://pi.dev/install.sh | sh
	fi
}
_install_omp() { curl -fsSL https://omp.sh/install | sh; }
_install_opencode() { curl -fsSL https://opencode.ai/install | bash; }
_install_codex() { curl -fsSL https://chatgpt.com/codex/install.sh | sh; }

install_bins() {
	section "Binaries"
	ensure_bin claude "claude" _install_claude
	ensure_bin pi "pi" _install_pi
	ensure_bin omp "omp" _install_omp
	ensure_bin opencode "opencode" _install_opencode
	ensure_bin codex "codex" _install_codex
}

# --- per-harness -----------------------------------------------------------

do_claude() {
	local src dst
	src="$(src_for claude)"
	dst="$(dst_for claude)"
	subsection "claude  →  $dst"
	install_dir "$src" "$dst"
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "chmod +x statusline-command.sh"
	else
		[ -f "$dst/statusline-command.sh" ] && chmod +x "$dst/statusline-command.sh" && ok "statusline-command.sh executable"
	fi
}

do_codex() {
	local src dst
	src="$(src_for codex)"
	dst="$(dst_for codex)"
	subsection "codex  →  $dst"
	install_dir "$src" "$dst"
}

do_pi() {
	local src dst
	src="$(src_for pi)"
	dst="$(dst_for pi)"
	subsection "pi  →  $dst"
	install_dir "$src" "$dst"
	if [ "$DRY_RUN" -eq 0 ] && [ -d "$dst/agent/extensions" ]; then
		ok "extensions synced (incl. build artifacts)"
	fi
}

do_omp() {
	local src dst
	src="$(src_for omp)"
	dst="$(dst_for omp)"
	subsection "omp  →  $dst"
	install_dir "$src" "$dst"
}

do_opencode() {
	local src dst
	src="$(src_for opencode)"
	dst="$(dst_for opencode)"
	subsection "opencode  →  $dst"
	install_dir "$src" "$dst"
}

# --- plugin helpers --------------------------------------------------------

# install_plugin <repo> <name> <label>  (claude plugin)
install_plugin() {
	local repo="$1" name="$2" label="$3"
	if ! command -v claude >/dev/null 2>&1; then
		skip "$label — claude not on PATH"
		return 0
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "claude plugin marketplace add $repo"
		plan "claude plugin install ${name}@${name}"
		return 0
	fi
	claude plugin marketplace add "$repo" </dev/null &&
		ok "$label marketplace source added" ||
		warn "claude plugin marketplace add $repo returned non-zero (may already exist)"
	claude plugin install "${name}@${name}" </dev/null &&
		ok "$label plugin installed" ||
		warn "run manually: claude plugin install ${name}@${name}"
}

# install_codex_plugin <repo> <label>
install_codex_plugin() {
	local repo="$1" label="$2"
	if ! command -v codex >/dev/null 2>&1; then
		skip "$label — codex not on PATH"
		return 0
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "codex plugin marketplace add $repo"
		return 0
	fi
	codex plugin marketplace add "$repo" </dev/null &&
		ok "$label marketplace source added" ||
		warn "codex plugin marketplace add $repo returned non-zero (may already exist)"
}

# install_marketplace_only <repo> <label>  (claude marketplace source, no plugin install)
install_marketplace_only() {
	local repo="$1" label="$2"
	if ! command -v claude >/dev/null 2>&1; then
		skip "$label — claude not on PATH"
		return 0
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "claude plugin marketplace add $repo"
		return 0
	fi
	claude plugin marketplace add "$repo" </dev/null &&
		ok "$label marketplace source added" ||
		warn "claude plugin marketplace add $repo returned non-zero (may already exist)"
}

# install_pi_package <repo> <label> — install a pi package from a git source.
install_pi_package() {
	local repo="$1" label="$2"
	if ! command -v pi >/dev/null 2>&1; then
		skip "$label — pi not on PATH"
		return 0
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "pi install git:$repo"
		return 0
	fi
	pi install "git:$repo" >/dev/null 2>&1 &&
		ok "$label pi package installed" ||
		warn "run manually: pi install git:$repo"
}

# install_skillsh_skill <repo> <skill> — global single skill via skills.sh.
install_skillsh_skill() {
	local repo="$1" skill="$2"
	if ! command -v npx >/dev/null 2>&1; then
		skip "$skill — npx not on PATH"
		return 0
	fi
	if [ "$DRY_RUN" -eq 1 ]; then
		plan "npx skills add $repo --skill $skill -g -y"
		return 0
	fi
	npx --yes skills add "$repo" --skill "$skill" -g -y >/dev/null 2>&1 &&
		ok "$skill installed" ||
		warn "npx skills add $skill returned non-zero"
}

# --- main ------------------------------------------------------------------

if [ "$DRY_RUN" -eq 1 ]; then
	printf "${C_YELLOW}${C_BOLD}  DRY RUN — no files will be written${C_RESET}\n"
fi
printf "${C_DIM}  repo: %s${C_RESET}\n" "$SCRIPT_DIR"
preflight

if [ "$RTK" -eq 1 ]; then
	section "RTK"
	ensure_rtk || true
fi

install_bins

section "Configs"
for h in "${TARGETS[@]}"; do
	"do_${h}"
	echo
done

section "Plugins"
if [ "$SELF_CLAUDE" -eq 1 ]; then
	subsection "agentic-workflow (claude)"
	if ! command -v claude >/dev/null 2>&1; then
		skip "agentic-workflow — claude not on PATH"
	elif [ "$DRY_RUN" -eq 1 ]; then
		plan "claude plugin marketplace add ctcac00/ai"
		plan "claude plugin install agentic-workflow"
	else
		claude plugin marketplace add "ctcac00/ai" </dev/null &&
			ok "agentic-workflow marketplace source added" ||
			warn "claude plugin marketplace add ctcac00/ai returned non-zero (may already exist)"
		claude plugin install "agentic-workflow" </dev/null &&
			ok "agentic-workflow plugin installed" ||
			warn "run manually: claude plugin install agentic-workflow"
	fi

fi

if [ "$SELF_PI" -eq 1 ]; then
	subsection "agentic-workflow (pi package)"
	install_pi_package "github.com/ctcac00/ai" "agentic-workflow"
fi

if [ "$LANGFUSE" -eq 1 ]; then
	subsection "langfuse"
	install_plugin "langfuse/Claude-Observability-Plugin" "langfuse-observability" "langfuse (claude)"
	install_codex_plugin "langfuse/codex-observability-plugin" "langfuse (codex)"
fi

if [ "$CAVEMAN" -eq 1 ]; then
	subsection "caveman"
	install_plugin "JuliusBrussee/caveman" "caveman" "caveman"
fi

if [ "$EXTRA_SKILLS" -eq 1 ]; then
	subsection "find-skills"
	install_skillsh_skill "https://github.com/vercel-labs/skills" "find-skills"
	subsection "skill-creator"
	install_skillsh_skill "https://github.com/anthropics/skills" "skill-creator"
	subsection "anthropic-agent-skills"
	install_marketplace_only "anthropics/skills" "anthropic-agent-skills"
fi

if [ "$RTK" -eq 1 ]; then
	section "RTK Init"
	_seen_rtk_flags=""
	for h in "${TARGETS[@]}"; do
		_f="$(rtk_flag_for "$h" 2>/dev/null || true)"
		case "$_seen_rtk_flags" in
		*"|${_f}|"*)
			skip "rtk init $h — same flag as pi, duplicate skipped"
			continue
			;;
		esac
		_seen_rtk_flags="${_seen_rtk_flags}|${_f}|"
		rtk_init "$h"
	done
	[ "$DRY_RUN" -eq 0 ] && note "Restart your AI tool(s) to activate the rtk hook."
fi

printf '\n'
if [ "$DRY_RUN" -eq 1 ]; then
	printf "${C_YELLOW}${C_BOLD}  Dry run complete.${C_RESET}  Re-run without --dry-run to apply.\n\n"
else
	printf "${C_GREEN}${C_BOLD}  Done.${C_RESET}\n\n"
fi
