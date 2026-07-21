#!/bin/sh
# SPDX-License-Identifier: Apache-2.0

set -eu

config_path="${CAPOWN_MASTER_CONFIG:-/data/config.toml}"

# Keep the first-run configuration in the persistent user directory. Existing
# configuration is never overwritten; runtime-specific values are supplied by
# environment variables in compose.yaml.
if [ ! -f "$config_path" ]; then
    mkdir -p "$(dirname "$config_path")"
    cp /opt/capown/config.toml.example "$config_path"
fi

# Seed the registry on first run if not already present. Always point the
# Master at the persistent /data path so container HOME search is not used.
registry_target="${CAPOWN_MASTER_REGISTRY_PATH:-/data/registry/registry.json}"
export CAPOWN_MASTER_REGISTRY_PATH="$registry_target"
if [ ! -f "$registry_target" ]; then
    mkdir -p "$(dirname "$registry_target")"
    if [ -f /opt/capown/registry/registry.json ]; then
        cp /opt/capown/registry/registry.json "$registry_target"
    fi
fi

exec /usr/local/bin/capown-master "$@"
