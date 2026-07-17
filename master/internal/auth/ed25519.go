package auth

import (
	"crypto/ed25519"
	"encoding/hex"
)

// ValidEd25519PublicKey reports whether value is a hex-encoded 32-byte key.
func ValidEd25519PublicKey(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == ed25519.PublicKeySize
}

// VerifyEd25519 verifies an Ed25519 signature.
// publicKeyHex: 64-char hex-encoded Ed25519 public key
// message: the raw message (nonce)
// signatureHex: 128-char hex-encoded Ed25519 signature
func VerifyEd25519(publicKeyHex, message, signatureHex string) bool {
	// Decode public key
	pubBytes, err := hex.DecodeString(publicKeyHex)
	if err != nil || !ValidEd25519PublicKey(publicKeyHex) {
		return false
	}

	// Decode signature
	sigBytes, err := hex.DecodeString(signatureHex)
	if err != nil || len(sigBytes) != ed25519.SignatureSize {
		return false
	}

	return ed25519.Verify(ed25519.PublicKey(pubBytes), []byte(message), sigBytes)
}
