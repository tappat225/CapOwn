#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# install-master.sh -- CapOwn Master local source installation.
#
# Installs the Master binary, configuration, and database directory below
# ~/.capown/master. It does not create a system service.
#
# Usage: bash scripts/install-master.sh [--prefix <dir>]
#   Default prefix: $HOME/.capown

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MASTER_SRC="$(cd "${SCRIPT_DIR}/../master" && pwd)"
VERSION_MANIFEST="$(cd "${SCRIPT_DIR}/.." && pwd)/version.json"
CAPOWN_ROOT="${HOME}/.capown"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --prefix requires a directory" >&2
        exit 1
      fi
      CAPOWN_ROOT="$2"
      shift 2
      ;;
    --help|-h)
      sed -n '1,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

MASTER_DIR="${CAPOWN_ROOT}/master"
BIN_DIR="${CAPOWN_ROOT}/bin"
CONFIG_FILE="${MASTER_DIR}/config.toml"
BINARY_FILE="${MASTER_DIR}/capown-master"
LAUNCHER="${BIN_DIR}/capown-master"

echo "CapOwn Master Installer"
echo "======================="
echo ""
echo "Source: ${MASTER_SRC}"
echo "Data:   ${MASTER_DIR}"
echo ""

if ! command -v go >/dev/null 2>&1; then
  echo "ERROR: Go 1.23 or newer is required." >&2
  exit 1
fi

GO_MAJOR="$(go version | sed -E 's/.*go([0-9]+)\.([0-9]+).*/\1/')"
GO_MINOR="$(go version | sed -E 's/.*go([0-9]+)\.([0-9]+).*/\2/')"
if [[ -z "${GO_MAJOR}" || -z "${GO_MINOR}" || \
      "${GO_MAJOR}" -lt 1 || \
      ("${GO_MAJOR}" -eq 1 && "${GO_MINOR}" -lt 23) ]]; then
  echo "ERROR: Go 1.23 or newer is required, found: $(go version)" >&2
  exit 1
fi

echo "Go:     $(go version)"
echo ""

MASTER_VERSION="$(cd "${MASTER_SRC}" && go run ./cmd/capown-version --manifest "${VERSION_MANIFEST}" --field master_version)"
PROTOCOL_VERSION="$(cd "${MASTER_SRC}" && go run ./cmd/capown-version --manifest "${VERSION_MANIFEST}" --field protocol_version)"
echo "Master:   ${MASTER_VERSION}"
echo "Protocol: ${PROTOCOL_VERSION}"
echo ""

mkdir -p "${MASTER_DIR}/data" "${MASTER_DIR}/registry" "${BIN_DIR}"

echo "Building Master..."
(
  cd "${MASTER_SRC}"
  go build \
    -ldflags "-X github.com/capown/master/internal/version.MasterVersion=${MASTER_VERSION} -X github.com/capown/master/internal/version.ProtocolVersion=${PROTOCOL_VERSION}" \
    -o "${BINARY_FILE}" ./cmd/capown-master
)

# Copy the plugin registry (overwrites on every install).
cp "${MASTER_SRC}/../registry/registry.json" "${MASTER_DIR}/registry/registry.json"
chmod 644 "${MASTER_DIR}/registry/registry.json"
echo "Registry: ${MASTER_DIR}/registry/registry.json"

if [[ ! -f "${CONFIG_FILE}" ]]; then
  cp "${MASTER_SRC}/config.toml.example" "${CONFIG_FILE}"
  chmod 600 "${CONFIG_FILE}"
  echo "Created config: ${CONFIG_FILE}"
else
  echo "Config exists:  ${CONFIG_FILE} (not overwritten)"
fi

cat > "${LAUNCHER}" <<'LAUNCHER_EOF'
#!/usr/bin/env bash
# CapOwn Master launcher
set -euo pipefail
MASTER_DIR="$(cd "$(dirname "$0")/../master" && pwd)"
cd "${MASTER_DIR}"
export CAPOWN_MASTER_CONFIG="${MASTER_DIR}/config.toml"
exec "${MASTER_DIR}/capown-master" "$@"
LAUNCHER_EOF
chmod +x "${LAUNCHER}"

echo ""
echo "Installation complete."
echo "  Launcher: ${LAUNCHER}"
echo "  Config:   ${CONFIG_FILE}"
echo "  Database: ${MASTER_DIR}/data/master.db"
echo ""
echo "Run the Master with:"
echo "  ${LAUNCHER}"
