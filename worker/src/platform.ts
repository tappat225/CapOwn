// SPDX-License-Identifier: Apache-2.0
/** Platform detection utilities wrapping Node's `os` module. */

import * as os from "node:os";

export interface PlatformInfo {
  hostname: string;
  os: string;
  release: string;
  arch: string;
}

export function getPlatformInfo(): PlatformInfo {
  return {
    hostname: os.hostname(),
    os: os.platform().toLowerCase(),
    release: os.release(),
    arch: os.arch(),
  };
}
