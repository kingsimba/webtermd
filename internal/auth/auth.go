package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sync"
	"time"
)

// NonceTTL is how long a challenge nonce remains valid.
const NonceTTL = 5 * time.Minute

type nonceEntry struct {
	expires time.Time
}

// Authenticator manages challenge-response authentication using ~/.ssh/authorized_keys.
type Authenticator struct {
	mu     sync.Mutex
	nonces map[string]nonceEntry
	sshDir string
	stopGC chan struct{}
}

// New creates an Authenticator that reads authorized_keys from the current user's ~/.ssh.
func New() (*Authenticator, error) {
	u, err := user.Current()
	if err != nil {
		return nil, fmt.Errorf("get current user: %w", err)
	}
	sshDir := filepath.Join(u.HomeDir, ".ssh")
	a := &Authenticator{
		nonces: make(map[string]nonceEntry),
		sshDir: sshDir,
		stopGC: make(chan struct{}),
	}
	go a.gcLoop()
	return a, nil
}

// NewWithSSHDir creates an Authenticator that reads authorized_keys from a custom .ssh directory (for testing).
func NewWithSSHDir(sshDir string) *Authenticator {
	a := &Authenticator{
		nonces: make(map[string]nonceEntry),
		sshDir: sshDir,
		stopGC: make(chan struct{}),
	}
	go a.gcLoop()
	return a
}

// Close stops background goroutines.
func (a *Authenticator) Close() {
	close(a.stopGC)
}

// GenerateChallenge returns a new base64-encoded nonce.
func (a *Authenticator) GenerateChallenge() string {
	b := make([]byte, 32)
	rand.Read(b)
	nonce := base64.StdEncoding.EncodeToString(b)

	a.mu.Lock()
	a.nonces[nonce] = nonceEntry{expires: time.Now().Add(NonceTTL)}
	a.mu.Unlock()

	return nonce
}

// Verify checks that signature is a valid signature of nonce by one of the keys in authorized_keys.
// Nonces are reusable within their TTL window — each successful verification extends the expiry.
func (a *Authenticator) Verify(nonce, signatureB64 string) bool {
	a.mu.Lock()
	entry, ok := a.nonces[nonce]
	if !ok {
		a.mu.Unlock()
		return false
	}
	if time.Now().After(entry.expires) {
		delete(a.nonces, nonce)
		a.mu.Unlock()
		return false
	}
	a.mu.Unlock()

	sig, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return false
	}

	keys, err := a.loadAuthorizedKeys()
	if err != nil {
		return false
	}

	hash := sha256.Sum256([]byte(nonce))
	for _, pubKey := range keys {
		if pubKey.Verify(hash[:], sig) {
			// Extend the TTL so the same nonce+sig can be reused
			// across page refreshes while the session is alive.
			a.mu.Lock()
			a.nonces[nonce] = nonceEntry{expires: time.Now().Add(NonceTTL)}
			a.mu.Unlock()
			return true
		}
	}
	return false
}

// ExtendNonce refreshes a nonce's TTL. Called periodically while the
// WebSocket stays open so the saved pair survives page refreshes.
func (a *Authenticator) ExtendNonce(nonce string) {
	a.mu.Lock()
	if _, ok := a.nonces[nonce]; ok {
		a.nonces[nonce] = nonceEntry{expires: time.Now().Add(NonceTTL)}
	}
	a.mu.Unlock()
}

// loadAuthorizedKeys reads and parses ~/.ssh/authorized_keys.
func (a *Authenticator) loadAuthorizedKeys() ([]sshPublicKey, error) {
	path := filepath.Join(a.sshDir, "authorized_keys")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	// Try PEM first
	var keys []sshPublicKey
	remaining := data
	for len(remaining) > 0 {
		block, rest := pem.Decode(remaining)
		if block == nil {
			break
		}
		remaining = rest
		switch block.Type {
		case "RSA PUBLIC KEY":
			pub, err := x509.ParsePKCS1PublicKey(block.Bytes)
			if err == nil {
				keys = append(keys, &rsaKey{pub: pub})
			}
		case "PUBLIC KEY":
			pubRaw, err := x509.ParsePKIXPublicKey(block.Bytes)
			if err != nil {
				continue
			}
			if key, err := wrapPublicKey(pubRaw); err == nil {
				keys = append(keys, key)
			}
		}
	}

	// If no PEM keys found, parse as OpenSSH authorized_keys format
	if len(keys) == 0 {
		keys = parseOpenSSHAuthorizedKeys(string(data))
	}

	return keys, nil
}

func (a *Authenticator) gcLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			a.mu.Lock()
			now := time.Now()
			for nonce, entry := range a.nonces {
				if now.After(entry.expires) {
					delete(a.nonces, nonce)
				}
			}
			a.mu.Unlock()
		case <-a.stopGC:
			return
		}
	}
}
