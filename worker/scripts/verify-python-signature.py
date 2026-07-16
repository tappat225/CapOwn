#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Verify that Node.js Ed25519 keys and signatures interop with PyNaCl.

Generates a fresh keypair using Node.js, signs a nonce, then verifies
the signature with PyNaCl.

Usage:
    python verify-python-signature.py

Requires: nacl (PyNaCl)
"""

from __future__ import annotations

import json
import subprocess
import sys


def verify():
    # Generate a keypair, sign a nonce via Node.js
    node_script = r"""
const crypto = require("crypto");

// Generate Ed25519 keypair
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

// Export raw hex keys (PyNaCl compatible)
const privateDer = privateKey.export({ format: "der", type: "pkcs8" });
const rawSeed = Buffer.from(privateDer.subarray(16));
const privateKeyHex = rawSeed.toString("hex");

const publicDer = publicKey.export({ format: "der", type: "spki" });
const rawPub = Buffer.from(publicDer.subarray(12));
const publicKeyHex = rawPub.toString("hex");

// Sign a nonce
const nonce = "test-nonce-12345";
const signature = crypto.sign(null, Buffer.from(nonce, "utf-8"), privateKey);

console.log(JSON.stringify({
    private_key: privateKeyHex,
    public_key: publicKeyHex,
    nonce: nonce,
    signature: signature.toString("hex"),
}));
"""

    try:
        result = subprocess.run(
            ["node", "-e", node_script],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except FileNotFoundError:
        print("FAIL: node not found in PATH")
        return False
    except subprocess.TimeoutExpired:
        print("FAIL: node subprocess timed out")
        return False

    if result.returncode != 0:
        print(f"FAIL: node error: {result.stderr}")
        return False

    data = json.loads(result.stdout)
    private_key = data["private_key"]
    public_key = data["public_key"]
    nonce = data["nonce"]
    signature = data["signature"]

    print(f"Node.js generated keys:")
    print(f"  private_key (hex, {len(private_key)//2} bytes): {private_key[:16]}...{private_key[-16:]}")
    print(f"  public_key  (hex, {len(public_key)//2} bytes): {public_key[:16]}...{public_key[-16:]}")
    print(f"  nonce:     {nonce}")
    print(f"  signature: {signature[:32]}...{signature[-32:]}")

    # Verify with PyNaCl
    import nacl.signing
    import nacl.encoding

    verify_key = nacl.signing.VerifyKey(
        public_key.encode("ascii"),
        encoder=nacl.encoding.HexEncoder,
    )

    try:
        verify_key.verify(
            nonce.encode("utf-8"),
            bytes.fromhex(signature),
        )
        print("")
        print("SUCCESS: PyNaCl verified the signature from Node.js")
        return True
    except nacl.exceptions.BadSignatureError:
        print("")
        print("FAIL: PyNaCl rejected the signature from Node.js")
        return False


def main():
    ok = verify()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
