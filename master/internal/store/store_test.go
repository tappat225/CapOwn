package store

import (
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	f, err := os.CreateTemp("", "master-test-*.db")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	s, err := New(f.Name())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		s.Close()
		os.Remove(f.Name())
	})
	return s
}

func TestHashPasswordVerify(t *testing.T) {
	hash, salt := HashPassword("test-password-123")
	if hash == "" || salt == "" {
		t.Fatal("hash and salt should not be empty")
	}
	if !VerifyPassword("test-password-123", hash, salt) {
		t.Error("VerifyPassword should match")
	}
	if VerifyPassword("wrong-password", hash, salt) {
		t.Error("VerifyPassword should reject wrong password")
	}
}

func TestVerifyPasswordEmpty(t *testing.T) {
	if VerifyPassword("pwd", "", "salt") {
		t.Error("empty stored hash should fail")
	}
	if VerifyPassword("pwd", "hash", "") {
		t.Error("empty salt should fail")
	}
}

func TestHashToken(t *testing.T) {
	h := HashToken("test-token")
	if len(h) != 64 {
		t.Errorf("expected 64-char hash, got %d", len(h))
	}
}

func TestRegisterFirstUser(t *testing.T) {
	s := newTestStore(t)

	userID, sessionToken, expiresAt, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	if userID == "" {
		t.Error("userID should not be empty")
	}
	if sessionToken == "" {
		t.Error("sessionToken should not be empty")
	}
	if expiresAt == "" {
		t.Error("expiresAt should not be empty")
	}

	// Second registration should fail
	_, _, _, err = s.RegisterFirstUser("admin2", "password123", 3600)
	if err == nil {
		t.Error("second registration should fail")
	}

	// Verify user was created
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}
	if user == nil {
		t.Fatal("user not found")
	}
	if user.Role != "admin" {
		t.Errorf("expected admin role, got %q", user.Role)
	}
	if user.PasswordHash == "" {
		t.Error("password should be set")
	}
}

func TestInvitationRegistrationIsSingleUseAndAtomic(t *testing.T) {
	s := newTestStore(t)
	adminID, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	code, invitation, err := s.CreateInvitation(adminID, "new teammate", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if code == "" || invitation.CodeHash == code || invitation.CodePrefix == "" {
		t.Fatal("invitation secret handling is invalid")
	}

	userID, session, _, err := s.RegisterInvitedUser(code, "alice", "secret1", 3600)
	if err != nil {
		t.Fatal(err)
	}
	if userID == "" || session == "" {
		t.Fatal("invited registration did not create a user session")
	}
	user, err := s.GetUser("alice")
	if err != nil || user == nil || user.Role != "user" {
		t.Fatalf("unexpected invited user: %#v, %v", user, err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "bob", "secret1", 3600); !errors.Is(err, ErrInvitationInvalid) {
		t.Fatalf("reused invitation should fail, got %v", err)
	}
}

func TestUsernameConflictDoesNotConsumeInvitation(t *testing.T) {
	s := newTestStore(t)
	adminID, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CreateInvitation(adminID, "", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "admin", "secret1", 3600); !errors.Is(err, ErrUsernameConflict) {
		t.Fatalf("expected username conflict, got %v", err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "alice", "secret1", 3600); err != nil {
		t.Fatalf("invitation should remain usable after a rolled-back conflict: %v", err)
	}
}

func TestExpiredInvitationIsRejected(t *testing.T) {
	s := newTestStore(t)
	adminID, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	code, _, err := s.CreateInvitation(adminID, "", -time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.RegisterInvitedUser(code, "alice", "secret1", 3600); !errors.Is(err, ErrInvitationInvalid) {
		t.Fatalf("expired invitation should fail, got %v", err)
	}
}

func TestRegisterFirstUserConcurrent(t *testing.T) {
	s := newTestStore(t)
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, username := range []string{"admin-a", "admin-b"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			_, _, _, err := s.RegisterFirstUser(name, "password123", 3600)
			results <- err
		}(username)
	}
	wg.Wait()
	close(results)

	successes := 0
	for err := range results {
		if err == nil {
			successes++
		}
	}
	if successes != 1 {
		t.Fatalf("expected exactly one successful registration, got %d", successes)
	}
	if count := s.CountUsers(); count != 1 {
		t.Fatalf("expected exactly one user, got %d", count)
	}
}

func TestParseTimestampPythonCompatibility(t *testing.T) {
	for _, value := range []string{
		"2026-07-16T12:34:56.123456",
		"2026-07-16T12:34:56Z",
	} {
		if _, err := ParseTimestamp(value); err != nil {
			t.Fatalf("ParseTimestamp(%q): %v", value, err)
		}
	}
}

func TestCreateAndValidateToken(t *testing.T) {
	s := newTestStore(t)

	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}

	plaintext, token, err := s.CreateToken(user.UserID, "client", "test-token")
	if err != nil {
		t.Fatal(err)
	}
	if plaintext == "" {
		t.Error("plaintext should not be empty")
	}
	if token.TokenType != "client" {
		t.Errorf("expected client type, got %q", token.TokenType)
	}

	// Validate
	validated, err := s.ValidateToken(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if validated == nil {
		t.Error("token should be valid")
	}
}

func TestClientTokenLifecycleAndUsageAudit(t *testing.T) {
	s := newTestStore(t)

	user, err := s.CreateUser("alice", "user")
	if err != nil {
		t.Fatal(err)
	}
	plaintext, token, err := s.CreateToken(user.UserID, "client", "test-token")
	if err != nil {
		t.Fatal(err)
	}

	if err := s.TouchToken(token.TokenID, "203.0.113.42"); err != nil {
		t.Fatal(err)
	}
	used, err := s.GetTokenByID(token.TokenID)
	if err != nil {
		t.Fatal(err)
	}
	if !used.LastUsedAt.Valid || used.LastUsedIP.String != "203.0.113.42" {
		t.Fatalf("usage audit not recorded: %#v", used)
	}

	if err := s.SetTokenDisabled(token.TokenID, true); err != nil {
		t.Fatal(err)
	}
	if disabled, err := s.ValidateToken(plaintext); err != nil {
		t.Fatal(err)
	} else if disabled != nil {
		t.Fatal("disabled token should not validate")
	}

	if err := s.SetTokenDisabled(token.TokenID, false); err != nil {
		t.Fatal(err)
	}
	if enabled, err := s.ValidateToken(plaintext); err != nil {
		t.Fatal(err)
	} else if enabled == nil {
		t.Fatal("re-enabled token should validate")
	}

	if err := s.RevokeToken(token.TokenID); err != nil {
		t.Fatal(err)
	}
	listed, err := s.ListOwnedClientTokens(user.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || !listed[0].RevokedAt.Valid {
		t.Fatalf("revoked token should remain visible in client list: %#v", listed)
	}
}

func TestCreateSessionAndValidate(t *testing.T) {
	s := newTestStore(t)

	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}

	plaintext, _, _, err := s.CreateSessionToken(user.UserID, 3600)
	if err != nil {
		t.Fatal(err)
	}

	sess, err := s.ValidateSession(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if sess == nil {
		t.Error("session should be valid")
	}

	// Revoke and check
	if err := s.RevokeSession(plaintext); err != nil {
		t.Fatal(err)
	}
	sess, err = s.ValidateSession(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if sess != nil {
		t.Error("revoked session should be invalid")
	}
}

func TestRegistrationTokenLifecycle(t *testing.T) {
	s := newTestStore(t)

	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}
	plaintext, token, err := s.CreateRegistrationToken(user.UserID, 3600, 1, "test-registration")
	if err != nil {
		t.Fatal(err)
	}

	// Validate
	validated, err := s.ValidateRegistrationToken(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if validated == nil {
		t.Fatal("registration token should be valid")
	}
	if validated.Label != "test-registration" {
		t.Errorf("expected label 'test-registration', got %q", validated.Label)
	}

	// Consume
	if err := s.ConsumeRegistrationToken(token.TokenID); err != nil {
		t.Fatal(err)
	}

	// After consumption, should be exhausted
	validated, err = s.ValidateRegistrationToken(plaintext)
	if err != nil {
		t.Fatal(err)
	}
	if validated != nil {
		t.Error("exhausted registration token should be invalid")
	}
}

func TestRenameAndRevokeWorkerAtomic(t *testing.T) {
	s := newTestStore(t)
	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, _ := s.GetUser("admin")
	plaintext, _, err := s.CreateRegistrationToken(user.UserID, 3600, 1, "worker")
	if err != nil {
		t.Fatal(err)
	}
	result, _, err := s.RegisterWorkerAtomic(
		plaintext, "host", "00", "linux", "capability", "", "",
	)
	if err != nil {
		t.Fatal(err)
	}
	workerID := result.WorkerID
	worker, err := s.GetActiveWorker(workerID)
	if err != nil || worker == nil || worker.Status != "offline" || worker.LastHeartbeat.Valid {
		t.Fatalf("new Worker should be offline before runtime heartbeat: %#v, %v", worker, err)
	}
	if _, becameOnline, err := s.ReconnectWorker(workerID, "host", "linux", "capability", "", "", "[]"); err != nil || !becameOnline {
		t.Fatalf("runtime heartbeat should bring Worker online: became_online=%v err=%v", becameOnline, err)
	}
	if err := s.RenameWorkerAtomic(workerID, user.UserID, "worker.two"); err != nil {
		t.Fatal(err)
	}
	worker, err = s.GetActiveWorker(workerID)
	if err != nil || worker == nil {
		t.Fatalf("get renamed worker: %v", err)
	}
	if worker.WorkerName != "worker.two" || !worker.PreviousWorkerName.Valid || worker.PreviousWorkerName.String != "host" {
		t.Fatalf("unexpected rename state: %#v", worker)
	}
	owner, err := s.GetOwner(workerID)
	if err != nil || owner == nil || owner.WorkerName != "worker.two" {
		t.Fatalf("owner binding was not renamed: %#v, %v", owner, err)
	}
	if err := s.RevokeWorkerAtomic(workerID, "wrong-owner"); err != ErrWorkerNotFound {
		t.Fatalf("wrong owner should not revoke worker, got %v", err)
	}
	if err := s.RevokeWorkerAtomic(workerID, user.UserID); err != nil {
		t.Fatal(err)
	}
	if active, err := s.GetActiveWorker(workerID); err != nil || active != nil {
		t.Fatalf("revoked worker should be inactive: %#v, %v", active, err)
	}
}

func TestRegisterWorkerRegistrationIdentity(t *testing.T) {
	s := newTestStore(t)
	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	admin, _ := s.GetUser("admin")

	token1, token1Row, err := s.CreateRegistrationToken(admin.UserID, 3600, 2, "t1")
	if err != nil {
		t.Fatal(err)
	}
	pubKey := "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
	first, errCode, err := s.RegisterWorkerAtomic(
		token1, "host.example", pubKey, "linux", "capability", "", "",
	)
	if err != nil || first == nil || first.WorkerID == "" || !first.Created {
		t.Fatalf("first registration failed: code=%q err=%v", errCode, err)
	}
	if first.WorkerName != "host-example" {
		t.Fatalf("unexpected Master-generated Worker name: %q", first.WorkerName)
	}

	// Reusing the same token and identity is idempotent, even after the first
	// token use and regardless of public key case.
	retry, errCode, err := s.RegisterWorkerAtomic(
		token1, "different-host", strings.ToUpper(pubKey), "linux", "capability", "", "",
	)
	if err != nil || retry == nil || retry.Created || retry.WorkerID != first.WorkerID || retry.WorkerName != first.WorkerName {
		t.Fatalf("expected idempotent registration, got result=%#v code=%q err=%v", retry, errCode, err)
	}
	token1After, err := s.GetRegistrationTokenByID(token1Row.TokenID)
	if err != nil {
		t.Fatal(err)
	}
	if token1After.UsedCount != 1 {
		t.Fatalf("idempotent retry should not consume token, got used_count=%d", token1After.UsedCount)
	}

	// A new token creates a new registration even for the same owner and key.
	token1b, _, err := s.CreateRegistrationToken(admin.UserID, 3600, 1, "t1b")
	if err != nil {
		t.Fatal(err)
	}
	reregistered, errCode, err := s.RegisterWorkerAtomic(
		token1b, "new-host", pubKey, "linux", "capability", "", "",
	)
	if err != nil || reregistered == nil || !reregistered.Created || reregistered.WorkerID == first.WorkerID {
		t.Fatalf("new-token re-registration failed: result=%#v code=%q err=%v", reregistered, errCode, err)
	}
	if reregistered.WorkerName != first.WorkerName || len(reregistered.Superseded) != 1 || reregistered.Superseded[0].WorkerID != first.WorkerID {
		t.Fatalf("new-token re-registration did not preserve and supersede the prior Worker: %#v", reregistered)
	}

	// The same multi-use token can register a different identity and gets a
	// distinct Worker ID.
	otherKey := strings.Repeat("bc", 32)
	second, errCode, err := s.RegisterWorkerAtomic(
		token1, "host.example", otherKey, "linux", "capability", "", "",
	)
	if err != nil || second == nil || !second.Created || second.WorkerID == first.WorkerID {
		t.Fatalf("second registration failed: result=%#v code=%q err=%v", second, errCode, err)
	}
	if second.WorkerName != "host-example-2" {
		t.Fatalf("unexpected collision-resolved Worker name: %q", second.WorkerName)
	}

	// A second active identity with the same hostname gets a unique suffix.
	token1c, _, err := s.CreateRegistrationToken(admin.UserID, 3600, 1, "t1c")
	if err != nil {
		t.Fatal(err)
	}
	third, errCode, err := s.RegisterWorkerAtomic(
		token1c, "host.example", strings.Repeat("de", 32), "linux", "capability", "", "",
	)
	if err != nil || third == nil || !third.Created || third.WorkerName != "host-example-3" {
		t.Fatalf("expected a unique Master-generated suffix: result=%#v code=%q err=%v", third, errCode, err)
	}

	// A new owner's token transfers the same installation to a new Worker ID.
	other, err := s.CreateUser("other", "user")
	if err != nil {
		t.Fatal(err)
	}
	token2, token2Row, err := s.CreateRegistrationToken(other.UserID, 3600, 1, "t2")
	if err != nil {
		t.Fatal(err)
	}
	transferred, errCode, err := s.RegisterWorkerAtomic(
		token2, "new-host", pubKey, "linux", "capability", "", "",
	)
	if err != nil || transferred == nil || !transferred.Created || transferred.WorkerID == first.WorkerID {
		t.Fatalf("transfer failed: result=%#v code=%q err=%v", transferred, errCode, err)
	}
	if transferred.WorkerName != first.WorkerName || len(transferred.Superseded) != 1 || transferred.Superseded[0].WorkerID != reregistered.WorkerID {
		t.Fatalf("transfer did not preserve and supersede the prior registration: %#v", transferred)
	}
	for _, oldID := range []string{first.WorkerID, reregistered.WorkerID} {
		if active, err := s.GetActiveWorker(oldID); err != nil || active != nil {
			t.Fatalf("prior Worker should be revoked after transfer: id=%s worker=%#v err=%v", oldID, active, err)
		}
	}
	transferredOwner, err := s.GetOwner(transferred.WorkerID)
	if err != nil || transferredOwner == nil || transferredOwner.UserID != other.UserID {
		t.Fatalf("transferred Worker has wrong owner: %#v, %v", transferredOwner, err)
	}

	// Replaying a superseded registration must not restore the revoked ID.
	_, errCode, err = s.RegisterWorkerAtomic(
		token1, "host.example", pubKey, "linux", "capability", "", "",
	)
	if err == nil || errCode != "registration_superseded" {
		t.Fatalf("expected registration_superseded, got code=%q err=%v", errCode, err)
	}
	token2After, err := s.GetRegistrationTokenByID(token2Row.TokenID)
	if err != nil {
		t.Fatal(err)
	}
	if token2After.UsedCount != 1 {
		t.Fatalf("transfer should consume the new token, got used_count=%d", token2After.UsedCount)
	}
}

func insertLegacyWorker(t *testing.T, s *Store, workerID, ownerID, publicKey string) {
	t.Helper()
	_, err := s.rawDB().Exec(
		`INSERT INTO workers (worker_id, worker_name, owner_user_id, public_key, hostname, os, mode, capabilities, workspace, status, registered_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?)`,
		workerID, workerID, ownerID, publicKey, "legacy-host", "linux", "capability", "", "", NowISO(),
	)
	if err != nil {
		t.Fatal(err)
	}
}

func TestNormalizeLegacyWorkerPublicKeyBeforeIndex(t *testing.T) {
	s := newTestStore(t)
	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.rawDB().Exec(`DROP INDEX idx_worker_public_key_active`); err != nil {
		t.Fatal(err)
	}
	publicKey := strings.Repeat("ab", 32)
	insertLegacyWorker(t, s, "wrk_legacy_upper", user.UserID, strings.ToUpper(publicKey))

	if err := s.initDB(); err != nil {
		t.Fatal(err)
	}
	worker, err := s.GetWorker("wrk_legacy_upper")
	if err != nil {
		t.Fatal(err)
	}
	if worker.PublicKey != publicKey {
		t.Fatalf("legacy public key was not normalized: %q", worker.PublicKey)
	}
}

func TestAllowLegacyDuplicateWorkerPublicKeysDuringMigration(t *testing.T) {
	s := newTestStore(t)
	_, _, _, err := s.RegisterFirstUser("admin", "password123", 3600)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.GetUser("admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.rawDB().Exec(`DROP INDEX idx_worker_public_key_active`); err != nil {
		t.Fatal(err)
	}
	publicKey := strings.Repeat("cd", 32)
	insertLegacyWorker(t, s, "wrk_legacy_one", user.UserID, publicKey)
	insertLegacyWorker(t, s, "wrk_legacy_two", user.UserID, strings.ToUpper(publicKey))

	if err := s.initDB(); err != nil {
		t.Fatal(err)
	}
	workers, err := s.ListAllWorkers()
	if err != nil {
		t.Fatal(err)
	}
	if len(workers) != 2 {
		t.Fatalf("expected both legacy Workers to remain, got %d", len(workers))
	}
}
