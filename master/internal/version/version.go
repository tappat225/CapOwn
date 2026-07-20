// SPDX-License-Identifier: Apache-2.0

// Package version contains build-injected CapOwn version metadata.
package version

// ProductVersion is injected into release binaries with go build -ldflags.
var ProductVersion = "dev"

// ProtocolVersion is injected into release binaries with go build -ldflags.
var ProtocolVersion = "dev"
