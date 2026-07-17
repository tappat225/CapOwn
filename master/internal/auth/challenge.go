package auth

import (
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// ChallengeEntry holds an Ed25519 nonce challenge.
type ChallengeEntry struct {
	WorkerID  string
	Nonce     string
	ExpiresAt time.Time
}

// ChallengeStore is an in-memory store for Ed25519 nonces (matching Python's ChallengeStore).
type ChallengeStore struct {
	mu    sync.RWMutex
	store map[string]*ChallengeEntry
	ttl   time.Duration
	max   int
}

// NewChallengeStore creates a new ChallengeStore with the given TTL and max entries.
func NewChallengeStore(ttl time.Duration, max int) *ChallengeStore {
	return &ChallengeStore{
		store: make(map[string]*ChallengeEntry),
		ttl:   ttl,
		max:   max,
	}
}

// Create generates a new nonce for a worker and returns the nonce and expires_at string.
func (cs *ChallengeStore) Create(workerID string) (nonce string, expiresAt string) {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	// Evict oldest if at capacity
	if len(cs.store) >= cs.max {
		var oldestKey string
		var oldestTime time.Time
		for k, v := range cs.store {
			if oldestKey == "" || v.ExpiresAt.Before(oldestTime) {
				oldestKey = k
				oldestTime = v.ExpiresAt
			}
		}
		delete(cs.store, oldestKey)
	}

	b := make([]byte, 32)
	rand.Read(b)
	nonce = hex.EncodeToString(b)
	exp := time.Now().UTC().Add(cs.ttl)
	expiresAt = exp.Format(time.RFC3339)

	cs.store[nonce] = &ChallengeEntry{
		WorkerID:  workerID,
		Nonce:     nonce,
		ExpiresAt: exp,
	}
	return nonce, expiresAt
}

// Validate checks a nonce+workerID pair. The nonce is consumed (one-time use).
func (cs *ChallengeStore) Validate(nonce, workerID string) bool {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	entry, ok := cs.store[nonce]
	if !ok {
		return false
	}
	delete(cs.store, nonce) // one-time use

	if entry.WorkerID != workerID {
		return false
	}
	if time.Now().UTC().After(entry.ExpiresAt) {
		return false
	}
	return true
}

// Cleanup removes expired nonces.
func (cs *ChallengeStore) Cleanup() int {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	now := time.Now().UTC()
	count := 0
	for k, v := range cs.store {
		if now.After(v.ExpiresAt) {
			delete(cs.store, k)
			count++
		}
	}
	return count
}

// RevokeWorker removes all pending nonces for a worker.
func (cs *ChallengeStore) RevokeWorker(workerID string) int {
	cs.mu.Lock()
	defer cs.mu.Unlock()

	count := 0
	for k, v := range cs.store {
		if v.WorkerID == workerID {
			delete(cs.store, k)
			count++
		}
	}
	return count
}
