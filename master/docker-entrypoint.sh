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

exec /usr/local/bin/capown-master "$@"
