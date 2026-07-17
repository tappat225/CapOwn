// SPDX-License-Identifier: Apache-2.0
/** Unit tests for Worker CLI argument and registration-link handling. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRegistrationLink } from "../src/cli.js";

const TOKEN = "cown_register_" + "a".repeat(40);

describe("parseRegistrationLink", () => {
  it("parses a valid registration link", () => {
    const parsed = parseRegistrationLink(
      `https://master.example.com:9210/v1/worker-registrations/${TOKEN}`,
    );

    assert.deepEqual(parsed, {
      masterUrl: "https://master.example.com:9210",
      registrationToken: TOKEN,
    });
  });

  it("accepts http registration links", () => {
    const parsed = parseRegistrationLink(
      `http://localhost/v1/worker-registrations/${TOKEN}`,
    );

    assert.deepEqual(parsed, {
      masterUrl: "http://localhost",
      registrationToken: TOKEN,
    });
  });

  it("rejects links that are not plain HTTP(S) registration URLs", () => {
    const invalidLinks = [
      "not a URL",
      `ftp://master.example.com/v1/worker-registrations/${TOKEN}`,
      `https://user:pass@master.example.com/v1/worker-registrations/${TOKEN}`,
      `https://master.example.com/v1/worker-registrations/${TOKEN}?source=dashboard`,
      `https://master.example.com/v1/worker-registrations/${TOKEN}#worker`,
      `https://master.example.com/v1/worker-registrations/${TOKEN}/extra`,
      `https://master.example.com/v1/worker-registrations/${TOKEN}/`,
      `https://master.example.com/v1//worker-registrations/${TOKEN}`,
      `https://master.example.com/capown/v1/worker-registrations/${TOKEN}`,
      "https://master.example.com/v1/worker-registrations/cown_register_aaa",
      `https://master.example.com/v1/worker-registrations/cown_enroll_${"a".repeat(40)}`,
    ];

    for (const link of invalidLinks) {
      const parsed = parseRegistrationLink(link);
      assert.equal(typeof parsed, "string", `expected rejection for ${link}`);
    }
  });

  it("rejects registration tokens with uppercase or non-hex characters", () => {
    const invalidTokens = [
      "cown_register_" + "A".repeat(40),
      "cown_register_" + "g".repeat(40),
      "cown_register_" + "a".repeat(39),
    ];

    for (const token of invalidTokens) {
      const parsed = parseRegistrationLink(
        `https://master.example.com/v1/worker-registrations/${token}`,
      );
      assert.equal(typeof parsed, "string", `expected rejection for ${token}`);
    }
  });
});
