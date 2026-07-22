// SPDX-License-Identifier: Apache-2.0

// Package version contains build-injected CapOwn version metadata.
package version

// MasterVersion is injected into release binaries with go build -ldflags.
var MasterVersion = "dev"

// ProtocolVersion is injected into release binaries with go build -ldflags.
var ProtocolVersion = "dev"
