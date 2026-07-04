#!/usr/bin/env bash
set -Eeuo pipefail

RESET=$'\x1b[0m'
COLOR_DEBUG=$'\x1b[38;2;255;154;170m'
COLOR_ERROR=$'\x1b[38;2;159;0;31m'
COLOR_INFO=$'\x1b[38;2;255;107;128m'
COLOR_LOG=$'\x1b[38;2;255;23;68m'
COLOR_WARN=$'\x1b[38;2;216;23;61m'

INSTALL_BUN=1
FROZEN_LOCKFILE=1
VERIFY=0
VERBOSE=0
REPO_URL="${DANDELION_REPO_URL:-https://github.com/AyuBloom/Dandelion.git}"
BRANCH="${DANDELION_BRANCH:-main}"
INSTALL_DIR="${DANDELION_INSTALL_DIR:-$PWD/Dandelion}"
TMP_DIR=""

print_log() {
  local color="$1"
  local level="$2"
  shift 2

  printf "%b[%s]%b %s\n" "$color" "$level" "$RESET" "$*"
}

debug() {
  if [[ "$VERBOSE" -eq 1 ]]; then
    print_log "$COLOR_DEBUG" "debug" "$@"
  fi
}

info() {
  print_log "$COLOR_INFO" "info" "$@"
}

log() {
  print_log "$COLOR_LOG" "log" "$@"
}

warn() {
  print_log "$COLOR_WARN" "warn" "$@" >&2
}

error() {
  print_log "$COLOR_ERROR" "error" "$@" >&2
}

die() {
  error "$@"
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]
       curl -fsSL https://raw.githubusercontent.com/AyuBloom/Dandelion/main/install.sh | bash

Options:
  --install-dir <path>  Directory to clone into when running from curl
  --skip-bun-install    Do not install Bun automatically if it is missing
  --no-frozen-lockfile  Run bun install without --frozen-lockfile
  --verify              Run TypeScript checking and tests after install
  --verbose             Print extra diagnostic output
  -h, --help            Show this help message
USAGE
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT

source_looks_like_project() {
  local dir="$1"

  [[ -f "$dir/package.json" && -f "$dir/bun.lock" && -f "$dir/src/shared/logger.ts" ]]
}

find_local_project_root() {
  local source_path="${BASH_SOURCE[0]:-}"

  if [[ -z "$source_path" || "$source_path" == "-" ]]; then
    return 1
  fi

  local root
  root="$(cd -- "$(dirname -- "$source_path")" 2>/dev/null && pwd -P)" || return 1

  if source_looks_like_project "$root"; then
    printf "%s\n" "$root"
    return 0
  fi

  return 1
}

archive_url() {
  printf "https://github.com/AyuBloom/Dandelion/archive/refs/heads/%s.tar.gz\n" "$BRANCH"
}

download_source_archive() {
  local target="$1"
  local archive
  archive="$(archive_url)"

  if ! command_exists curl; then
    die "curl is required to download Dandelion."
  fi

  if ! command_exists tar; then
    die "tar is required to unpack Dandelion."
  fi

  TMP_DIR="$(mktemp -d)"
  mkdir -p "$target"

  log "Downloading Dandelion from $archive"
  curl -fL "$archive" -o "$TMP_DIR/dandelion.tar.gz"
  mkdir -p "$TMP_DIR/source"
  tar -xzf "$TMP_DIR/dandelion.tar.gz" -C "$TMP_DIR/source" --strip-components=1
  cp -R "$TMP_DIR/source/." "$target/"
}

ensure_source() {
  local target="$1"

  if source_looks_like_project "$target"; then
    info "Using existing Dandelion checkout at $target"
    return
  fi

  if [[ -e "$target" ]] && [[ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    die "$target already exists and does not look like a Dandelion checkout."
  fi

  mkdir -p "$(dirname -- "$target")"

  if command_exists git; then
    log "Cloning Dandelion into $target"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$target"
  else
    download_source_archive "$target"
  fi

  if ! source_looks_like_project "$target"; then
    die "Dandelion source was downloaded, but required project files are missing."
  fi
}

ensure_supported_os() {
  local os
  os="$(uname -s)"

  case "$os" in
    Darwin | Linux)
      debug "Detected supported OS: $os"
      ;;
    *)
      die "Unsupported OS: $os. Dandelion install supports Linux and macOS."
      ;;
  esac
}

load_bun_path() {
  local bun_home="${BUN_INSTALL:-$HOME/.bun}"

  if [[ -x "$bun_home/bin/bun" ]]; then
    export PATH="$bun_home/bin:$PATH"
    debug "Added $bun_home/bin to PATH"
  fi
}

ensure_bun() {
  load_bun_path

  if command_exists bun; then
    info "Using Bun $(bun --version)"
    return
  fi

  if [[ "$INSTALL_BUN" -eq 0 ]]; then
    die "Bun is required but was not found on PATH."
  fi

  if ! command_exists curl; then
    die "curl is required to install Bun automatically."
  fi

  log "Bun was not found. Installing Bun with the official installer..."
  curl -fsSL https://bun.sh/install | bash
  load_bun_path

  if ! command_exists bun; then
    die "Bun installed, but bun is still not available on PATH. Open a new shell or add ${BUN_INSTALL:-$HOME/.bun}/bin to PATH."
  fi

  info "Installed Bun $(bun --version)"
}

install_dependencies() {
  local -a install_args=("install")

  if [[ "$FROZEN_LOCKFILE" -eq 1 ]]; then
    install_args+=("--frozen-lockfile")
  fi

  log "Installing project dependencies"
  debug "Running: bun ${install_args[*]}"
  bun "${install_args[@]}"
}

run_verification() {
  log "Running TypeScript type checking"
  bunx tsc --noEmit

  log "Running tests"
  bun test tests/
}

main() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --skip-bun-install)
        INSTALL_BUN=0
        ;;
      --install-dir)
        shift
        if [[ "$#" -eq 0 ]]; then
          die "--install-dir requires a path."
        fi
        INSTALL_DIR="$1"
        ;;
      --install-dir=*)
        INSTALL_DIR="${1#*=}"
        ;;
      --no-frozen-lockfile)
        FROZEN_LOCKFILE=0
        ;;
      --verify)
        VERIFY=1
        ;;
      --verbose)
        VERBOSE=1
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown option: $1"
        ;;
    esac
    shift
  done

  ensure_supported_os

  local root
  if ! root="$(find_local_project_root)"; then
    root="$INSTALL_DIR"
    ensure_source "$root"
  fi

  cd "$root"

  info "Installing Dandelion from $root"
  ensure_bun
  install_dependencies

  if [[ "$VERIFY" -eq 1 ]]; then
    run_verification
  else
    info "Skipping verification. Run ./install.sh --verify to typecheck and test."
  fi

  info "Installation complete"
}

main "$@"
