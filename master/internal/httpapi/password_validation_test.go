package httpapi

import "testing"

func TestHasMinimumPasswordLength(t *testing.T) {
	if hasMinimumPasswordLength("12345") {
		t.Fatal("five-character passwords should be rejected")
	}
	if !hasMinimumPasswordLength("123456") {
		t.Fatal("six-character passwords should be accepted")
	}
}
