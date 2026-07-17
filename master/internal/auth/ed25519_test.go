package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"testing"
)

func TestValidEd25519PublicKey(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if !ValidEd25519PublicKey(hex.EncodeToString(publicKey)) {
		t.Fatal("valid public key was rejected")
	}
	for _, invalid := range []string{"", "zz", hex.EncodeToString(publicKey[:31])} {
		if ValidEd25519PublicKey(invalid) {
			t.Fatalf("invalid public key %q was accepted", invalid)
		}
	}
}
