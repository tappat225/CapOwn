// SPDX-License-Identifier: Apache-2.0

// capown-version reads the repository version manifest for build scripts.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
)

type manifest struct {
	ProtocolVersion string `json:"protocol_version"`
	Components      map[string]struct {
		Version string `json:"version"`
	} `json:"components"`
}

func main() {
	manifestPath := flag.String("manifest", "", "path to version.json")
	field := flag.String("field", "", "manifest field to print")
	flag.Parse()

	if *manifestPath == "" {
		fail("--manifest is required")
	}
	if *field != "master_version" && *field != "protocol_version" {
		fail("--field must be master_version or protocol_version")
	}

	raw, err := os.ReadFile(*manifestPath)
	if err != nil {
		fail("read manifest: %v", err)
	}
	var values manifest
	if err := json.Unmarshal(raw, &values); err != nil {
		fail("parse manifest: %v", err)
	}

	value := ""
	if *field == "master_version" {
		value = values.Components["master"].Version
	} else {
		value = values.ProtocolVersion
	}
	if value == "" {
		fail("manifest field %s is empty", *field)
	}
	fmt.Println(value)
}

func fail(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "capown-version: "+format+"\n", args...)
	os.Exit(1)
}
