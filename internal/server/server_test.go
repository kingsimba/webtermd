package server

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"ax-term/internal/auth"

	"github.com/gorilla/websocket"
)

func setupTestServer(t *testing.T) (*httptest.Server, *rsa.PrivateKey, func()) {
	t.Helper()

	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}

	sshDir := t.TempDir()
	akPath := filepath.Join(sshDir, "authorized_keys")
	pubBytes := x509.MarshalPKCS1PublicKey(&priv.PublicKey)
	pubDER := pem.EncodeToMemory(&pem.Block{Type: "RSA PUBLIC KEY", Bytes: pubBytes})
	os.WriteFile(akPath, pubDER, 0600)

	staticDir := os.DirFS(t.TempDir())

	a := auth.NewWithSSHDir(sshDir)
	srv := httptest.NewServer(New(a, staticDir, false, "bash"))

	cleanup := func() {
		srv.Close()
		a.Close()
	}
	return srv, priv, cleanup
}

func signNonce(priv *rsa.PrivateKey, nonce string) string {
	hash := sha256.Sum256([]byte(nonce))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, hash[:])
	return base64.StdEncoding.EncodeToString(sig)
}

func TestChallengeEndpoint(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	resp, err := http.Get(srv.URL + "/api/challenge")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var body struct {
		Nonce string `json:"nonce"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Nonce == "" {
		t.Fatal("empty nonce")
	}
}

func TestChallengeMethodNotAllowed(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	resp, err := http.Post(srv.URL+"/api/challenge", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", resp.StatusCode)
	}
}

func TestWebSocketAuthSuccess(t *testing.T) {
	srv, priv, cleanup := setupTestServer(t)
	defer cleanup()

	// Get challenge
	resp, err := http.Get(srv.URL + "/api/challenge")
	if err != nil {
		t.Fatal(err)
	}
	var body struct{ Nonce string `json:"nonce"` }
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()

	// Connect WebSocket
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	wsURL += "?nonce=" + url.QueryEscape(body.Nonce) + "&signature=" + url.QueryEscape(signNonce(priv, body.Nonce))

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// Send some input and receive output
	conn.WriteMessage(websocket.BinaryMessage, []byte("echo hello\r"))
	// Read a few messages to get terminal output
	for i := 0; i < 3; i++ {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if strings.Contains(string(msg), "hello") {
			return // success
		}
	}
}

func TestWebSocketAuthFailure(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	wsURL += "?nonce=bad&signature=bad"

	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected error, got connection")
	}
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestWebSocketMissingParams(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"

	_, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err == nil {
		t.Fatal("expected error, got connection")
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestStaticFileServing(t *testing.T) {
	srv, _, cleanup := setupTestServer(t)
	defer cleanup()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Static dir is empty, should get 404 for root index.html
	// but the server should handle the request without panic
	_ = resp.StatusCode
}

func TestWebSocketResize(t *testing.T) {
	srv, priv, cleanup := setupTestServer(t)
	defer cleanup()

	resp, _ := http.Get(srv.URL + "/api/challenge")
	var body struct{ Nonce string `json:"nonce"` }
	json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	wsURL += "?nonce=" + url.QueryEscape(body.Nonce) + "&signature=" + url.QueryEscape(signNonce(priv, body.Nonce))

	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Send resize message — should not crash
	resizeMsg := `{"rows":30,"cols":100}`
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte(resizeMsg)); err != nil {
		t.Fatal(err)
	}
}
