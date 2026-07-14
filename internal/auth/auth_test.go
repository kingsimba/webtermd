package auth

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestGenerateAndVerify(t *testing.T) {
	// Generate a real RSA key for testing
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	// Write authorized_keys in OpenSSH format
	sshDir := t.TempDir()
	akPath := filepath.Join(sshDir, "authorized_keys")
	pubBytes := x509.MarshalPKCS1PublicKey(&priv.PublicKey)
	pubDER := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: pubBytes})
	if err := os.WriteFile(akPath, pubDER, 0600); err != nil {
		t.Fatal(err)
	}

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	if nonce == "" {
		t.Fatal("empty nonce")
	}

	// Sign the nonce
	hash := sha256.Sum256([]byte(nonce))
	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("valid signature rejected")
	}
}

func TestVerifyWrongSignature(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)
	wrongPriv, _ := rsa.GenerateKey(rand.Reader, 2048)

	sshDir := t.TempDir()
	akPath := filepath.Join(sshDir, "authorized_keys")
	pubBytes := x509.MarshalPKCS1PublicKey(&priv.PublicKey)
	pubDER := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: pubBytes})
	os.WriteFile(akPath, pubDER, 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()

	// Sign with wrong key
	hash := sha256.Sum256([]byte(nonce))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, wrongPriv, crypto.SHA256, hash[:])
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if a.Verify(nonce, sigB64) {
		t.Fatal("wrong signature accepted")
	}
}

func TestNonceReusableWithinTTL(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)

	sshDir := t.TempDir()
	akPath := filepath.Join(sshDir, "authorized_keys")
	pubBytes := x509.MarshalPKCS1PublicKey(&priv.PublicKey)
	pubDER := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: pubBytes})
	os.WriteFile(akPath, pubDER, 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	hash := sha256.Sum256([]byte(nonce))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, hash[:])
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("first use rejected")
	}
	// Nonces are now reusable within the TTL window.
	if !a.Verify(nonce, sigB64) {
		t.Fatal("reuse within TTL rejected")
	}
}

func TestVerifyExpiredNonce(t *testing.T) {
	a := NewWithSSHDir(t.TempDir())
	defer a.Close()

	nonce := a.GenerateChallenge()

	// Manually expire the nonce
	a.mu.Lock()
	a.nonces[nonce] = nonceEntry{expires: a.nonces[nonce].expires.Add(-120 * time.Second)}
	a.mu.Unlock()

	if a.Verify(nonce, "dummy") {
		t.Fatal("expired nonce accepted")
	}
}

func TestVerifyUnknownNonce(t *testing.T) {
	a := NewWithSSHDir(t.TempDir())
	defer a.Close()

	if a.Verify("nonexistent", "dummy") {
		t.Fatal("unknown nonce accepted")
	}
}

func TestParseOpenSSHKey(t *testing.T) {
	priv, _ := rsa.GenerateKey(rand.Reader, 2048)

	// Build an SSH wire-format public key: string("ssh-rsa") + mpint(e) + mpint(n)
	algo := []byte("ssh-rsa")
	eBytes := make([]byte, 4)
	e := priv.PublicKey.E
	for i := 3; i >= 0; i-- {
		eBytes[i] = byte(e & 0xff)
		e >>= 8
	}
	nBytes := priv.PublicKey.N.Bytes()

	wire := sshString(algo)
	wire = append(wire, sshString(eBytes)...)
	wire = append(wire, sshString(nBytes)...)

	b64 := base64.StdEncoding.EncodeToString(wire)
	akLine := "ssh-rsa " + b64 + " test@ax-term\n"

	sshDir := t.TempDir()
	akPath := filepath.Join(sshDir, "authorized_keys")
	os.WriteFile(akPath, []byte(akLine), 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	hash := sha256.Sum256([]byte(nonce))
	sig, err := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("OpenSSH-format key rejected")
	}
}

func sshString(s []byte) []byte {
	out := make([]byte, 4+len(s))
	out[0] = byte(len(s) >> 24)
	out[1] = byte(len(s) >> 16)
	out[2] = byte(len(s) >> 8)
	out[3] = byte(len(s))
	copy(out[4:], s)
	return out
}

func TestVerifyWithMultipleKeys(t *testing.T) {
	priv1, _ := rsa.GenerateKey(rand.Reader, 2048)
	priv2, _ := rsa.GenerateKey(rand.Reader, 2048)

	sshDir := t.TempDir()
	akPath := filepath.Join(sshDir, "authorized_keys")

	pub1Bytes := x509.MarshalPKCS1PublicKey(&priv1.PublicKey)
	pub2Bytes := x509.MarshalPKCS1PublicKey(&priv2.PublicKey)
	content := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: pub1Bytes})
	content = append(content, pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: pub2Bytes})...)
	os.WriteFile(akPath, content, 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	hash := sha256.Sum256([]byte(nonce))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, priv2, crypto.SHA256, hash[:])
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("second key rejected")
	}
}

func TestVerifyNoAuthorizedKeys(t *testing.T) {
	a := NewWithSSHDir(t.TempDir())
	defer a.Close()

	nonce := a.GenerateChallenge()
	if a.Verify(nonce, "dummy") {
		t.Fatal("accepted with no authorized_keys")
	}
}

func TestChallengeUniqueness(t *testing.T) {
	a := NewWithSSHDir(t.TempDir())
	defer a.Close()

	n1 := a.GenerateChallenge()
	n2 := a.GenerateChallenge()
	if n1 == n2 {
		t.Fatal("duplicate nonces")
	}
}

func TestEd25519OpenSSHKey(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	// Build SSH wire format: string("ssh-ed25519") + string(32-byte key)
	wire := sshString([]byte("ssh-ed25519"))
	wire = append(wire, sshString([]byte(pub))...)

	b64 := base64.StdEncoding.EncodeToString(wire)
	akLine := "ssh-ed25519 " + b64 + " test@ax-term\n"

	sshDir := t.TempDir()
	os.WriteFile(filepath.Join(sshDir, "authorized_keys"), []byte(akLine), 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	hash := sha256.Sum256([]byte(nonce))
	sig := ed25519.Sign(priv, hash[:])
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("Ed25519 OpenSSH key rejected")
	}
}

func TestECDSAOpenSSHKey(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	algo := "ecdsa-sha2-nistp256"
	curve := "nistp256"

	// Build SSH wire format: string(algo) + string(curve) + string(0x04 || x || y)
	pubKeyBytes := elliptic.Marshal(priv.Curve, priv.X, priv.Y)
	wire := sshString([]byte(algo))
	wire = append(wire, sshString([]byte(curve))...)
	wire = append(wire, sshString(pubKeyBytes)...)

	b64 := base64.StdEncoding.EncodeToString(wire)
	akLine := algo + " " + b64 + " test@ax-term\n"

	sshDir := t.TempDir()
	os.WriteFile(filepath.Join(sshDir, "authorized_keys"), []byte(akLine), 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	hash := sha256.Sum256([]byte(nonce))
	sig, err := ecdsa.SignASN1(rand.Reader, priv, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("ECDSA OpenSSH key rejected")
	}
}

func TestEd25519PEMKey(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	pubBytes, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	pemBlock := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubBytes})

	sshDir := t.TempDir()
	os.WriteFile(filepath.Join(sshDir, "authorized_keys"), pemBlock, 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	hash := sha256.Sum256([]byte(nonce))
	sig := ed25519.Sign(priv, hash[:])
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("Ed25519 PEM key rejected")
	}
}

func TestECDSAPEMKey(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	pubBytes, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	pemBlock := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubBytes})

	sshDir := t.TempDir()
	os.WriteFile(filepath.Join(sshDir, "authorized_keys"), pemBlock, 0600)

	a := NewWithSSHDir(sshDir)
	defer a.Close()

	nonce := a.GenerateChallenge()
	hash := sha256.Sum256([]byte(nonce))
	sig, err := ecdsa.SignASN1(rand.Reader, priv, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	sigB64 := base64.StdEncoding.EncodeToString(sig)

	if !a.Verify(nonce, sigB64) {
		t.Fatal("ECDSA PEM key rejected")
	}
}
