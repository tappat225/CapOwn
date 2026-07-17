#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# install-worker.sh -- CapOwn Worker Next local source installation.
#
# Installs the Worker from the local repository into ~/.capown/worker/.
# Does not create systemd services, Windows services, or Docker Compose
# entries. Does not auto-register with a Master.
#
# Usage: bash scripts/install-worker.sh [--prefix <dir>]
#   Default prefix: $HOME/.capown

set -euo pipefail

# --- Configuration ---
PREFIX="${HOME:-$HOME}/.capown"
WORKER_SRC="$(cd "$(dirname "$0")/../worker" && pwd)"
APP_DIR="${PREFIX}/worker/app"
BIN_DIR="${PREFIX}/bin"
CONFIG_DIR="${PREFIX}/worker"
CONFIG_FILE="${CONFIG_DIR}/config.toml"
IDENTITY_FILE="${CONFIG_DIR}/identity.toml"
LAUNCHER="${BIN_DIR}/capown-worker"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      PREFIX="$2"
      APP_DIR="${PREFIX}/worker/app"
      BIN_DIR="${PREFIX}/bin"
      CONFIG_DIR="${PREFIX}/worker"
      CONFIG_FILE="${CONFIG_DIR}/config.toml"
      IDENTITY_FILE="${CONFIG_DIR}/identity.toml"
      LAUNCHER="${BIN_DIR}/capown-worker"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

echo "CapOwn Worker Next Installer"
echo "============================"
echo ""
echo "Prefix:  ${PREFIX}"
echo "Source:  ${WORKER_SRC}"
echo ""

# --- Check prerequisites ---
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is not installed." >&2
  echo "  Install Node.js >=20.18.0 from https://nodejs.org/" >&2
  exit 1
fi

NODE_VERSION="$(node --version | sed 's/^v//')"
echo "Node.js version: ${NODE_VERSION}"

# Parse major.minor
NODE_MAJOR="$(echo "${NODE_VERSION}" | cut -d. -f1)"
NODE_MINOR="$(echo "${NODE_VERSION}" | cut -d. -f2)"

if [[ "${NODE_MAJOR}" -lt 20 ]] || { [[ "${NODE_MAJOR}" -eq 20 ]] && [[ "${NODE_MINOR}" -lt 18 ]]; }; then
  echo "ERROR: Node.js >=20.18.0 is required, found ${NODE_VERSION}" >&2
  exit 1
fi

if ! command -v npm &>/dev/null; then
  echo "ERROR: npm is not installed." >&2
  exit 1
fi

NPM_VERSION="$(npm --version)"
echo "npm version:     ${NPM_VERSION}"

# --- Create directories ---
mkdir -p "${APP_DIR}" "${BIN_DIR}" "${CONFIG_DIR}"

# --- Copy source files ---
echo ""
echo "Copying Worker source..."
# Use rsync or cp -a
if command -v rsync &>/dev/null; then
  rsync -a --delete \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.env' \
    "${WORKER_SRC}/" "${APP_DIR}/"
else
  # Fallback: copy with tar
  tar -c \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.env' \
    -C "${WORKER_SRC}" . | tar -xC "${APP_DIR}"
fi

# --- Install dependencies and build ---
echo ""
echo "Installing npm dependencies..."
cd "${APP_DIR}"
npm ci
echo ""
echo "Building TypeScript..."
npm run build

# --- Create launcher ---
echo ""
echo "Creating launcher: ${LAUNCHER}"
cat > "${LAUNCHER}" << 'LAUNCHER_EOF'
#!/usr/bin/env bash
# CapOwn Worker Next launcher
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/../worker/app" && pwd)"
exec node "${APP_DIR}/dist/src/cli.js" "$@"
LAUNCHER_EOF
chmod +x "${LAUNCHER}"

# --- Copy default config if not present ---
if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo ""
  echo "Creating default config: ${CONFIG_FILE}"
  if [[ -f "${APP_DIR}/config.toml.example" ]]; then
    cp "${APP_DIR}/config.toml.example" "${CONFIG_FILE}"
    echo "  (copied from config.toml.example)"
  else
    cat > "${CONFIG_FILE}" << 'CONFIG_EOF'
# CapOwn Worker configuration
role = "worker"

[worker]
reconnect_interval = 5
CONFIG_EOF
    echo "  (generated default)"
  fi
else
  echo ""
  echo "Config already exists: ${CONFIG_FILE}"
  echo "  (not overwritten)"
fi

# --- Symlink to ~/.capown/bin in PATH if needed ---
echo ""
echo "Installation complete!"
echo ""
echo "Installed files:"
echo "  Worker:  ${APP_DIR}"
echo "  Binary:  ${LAUNCHER}"
echo "  Config:  ${CONFIG_FILE}"
echo "  Identity: ${IDENTITY_FILE}"
echo ""
echo "Make sure ${BIN_DIR} is in your PATH:"
echo "  export PATH=\"${BIN_DIR}:\$PATH\""
echo ""
echo "Next steps:"
echo "  1. Register with a Master:"
echo "     capown-worker register https://<master>/v1/worker-registrations/<token>"
echo ""
echo "  2. Start the daemon:"
echo "     capown-worker daemon"
