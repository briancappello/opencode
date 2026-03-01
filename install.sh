#!/usr/bin/env bash
set -eo pipefail

# Fork install script for briancappello/opencode
# Installs the latest release from GitHub Releases

REPO="briancappello/opencode"

# Installation directory priority (matching upstream):
# 1. $OPENCODE_INSTALL_DIR - Custom installation directory
# 2. $XDG_BIN_DIR - XDG Base Directory Specification compliant path
# 3. $HOME/.opencode/bin - Default (matches upstream install location)
if [[ -n "${OPENCODE_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="$OPENCODE_INSTALL_DIR"
elif [[ -n "${XDG_BIN_DIR:-}" ]]; then
  INSTALL_DIR="$XDG_BIN_DIR"
else
  INSTALL_DIR="${HOME}/.opencode/bin"
fi

tmp_dir=""

cleanup() {
  if [[ -n "$tmp_dir" && -d "$tmp_dir" ]]; then
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info() { echo -e "${GREEN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Detect OS and architecture
detect_platform() {
  local os arch

  case "$(uname -s)" in
    Linux*)  os="linux" ;;
    Darwin*) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows" ;;
    *) error "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac

  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) error "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac

  echo "${os}-${arch}"
}

# Get the latest release version from GitHub
get_latest_version() {
  local response version
  if command -v curl &>/dev/null; then
    response=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
  elif command -v wget &>/dev/null; then
    response=$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest")
  else
    error "Neither curl nor wget found. Please install one of them."
    exit 1
  fi

  # Extract tag_name from JSON - handle the + character in version
  version=$(echo "$response" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')

  if [[ -z "$version" ]]; then
    error "Failed to fetch latest version from GitHub"
    exit 1
  fi

  echo "$version"
}

# Download and install
install() {
  local platform version target_version asset_name download_url tmp_dir

  platform=$(detect_platform)
  info "Detected platform: ${platform}"

  # Use VERSION env var if set, otherwise fetch latest
  if [[ -n "${VERSION:-}" ]]; then
    target_version="v${VERSION#v}"
    info "Installing specified version: ${target_version}"
  else
    target_version=$(get_latest_version)
    info "Latest version: ${target_version}"
  fi

  # Construct asset name
  # Format: opencode-{os}-{arch}.tar.gz or opencode-{os}-{arch}.zip
  case "$platform" in
    linux-*)
      asset_name="opencode-${platform}.tar.gz"
      ;;
    darwin-*|windows-*)
      asset_name="opencode-${platform}.zip"
      ;;
  esac

  download_url="https://github.com/${REPO}/releases/download/${target_version}/${asset_name}"
  info "Downloading: ${download_url}"

  # Create temp directory
  tmp_dir=$(mktemp -d)

  # Download
  if command -v curl &>/dev/null; then
    curl -fsSL "$download_url" -o "${tmp_dir}/${asset_name}"
  else
    wget -q "$download_url" -O "${tmp_dir}/${asset_name}"
  fi

  # Extract
  info "Extracting..."
  cd "$tmp_dir"
  case "$asset_name" in
    *.tar.gz)
      tar -xzf "$asset_name"
      ;;
    *.zip)
      unzip -q "$asset_name"
      ;;
  esac

  # Find the binary
  local binary
  binary=$(find . -name "opencode" -o -name "opencode.exe" | head -1)
  if [[ -z "$binary" ]]; then
    error "Could not find opencode binary in archive"
    exit 1
  fi

  # Install
  mkdir -p "$INSTALL_DIR"
  chmod +x "$binary"
  mv "$binary" "${INSTALL_DIR}/opencode"

  info "Installed to: ${INSTALL_DIR}/opencode"

  # Check for other opencode installations that might shadow this one
  local other_opencode
  other_opencode=$(which opencode 2>/dev/null || true)
  if [[ -n "$other_opencode" && "$other_opencode" != "${INSTALL_DIR}/opencode" ]]; then
    warn "Another opencode installation found at: $other_opencode"
    warn "This may shadow the version just installed."
    echo ""
    echo "To fix, either:"
    echo "  1. Remove the other installation: rm \"$other_opencode\""
    echo "  2. Ensure ${INSTALL_DIR} comes first in your PATH"
    echo ""
  fi

  # Check if INSTALL_DIR is in PATH
  if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    warn "${INSTALL_DIR} is not in your PATH"
    echo ""
    echo "Add it to your shell config:"
    echo ""
    echo "  # For bash (add to ~/.bashrc):"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
    echo "  # For zsh (add to ~/.zshrc):"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo ""
    echo "  # For fish (add to ~/.config/fish/config.fish):"
    echo "  set -gx PATH ${INSTALL_DIR} \$PATH"
    echo ""
  fi

  info "Installation complete!"
  info "Run 'opencode --version' to verify"
}

install
