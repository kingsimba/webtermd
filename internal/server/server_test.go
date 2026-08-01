package server

import (
	"bytes"
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

	"webtermd/internal/auth"

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
	var body struct {
		Nonce string `json:"nonce"`
	}
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

func authenticatedFileRequest(t *testing.T, srv *httptest.Server, priv *rsa.PrivateKey, method, requestURL string, body []byte) *http.Response {
	t.Helper()

	challenge, err := http.Get(srv.URL + "/api/challenge")
	if err != nil {
		t.Fatal(err)
	}
	defer challenge.Body.Close()
	var challengeBody struct {
		Nonce string `json:"nonce"`
	}
	if err := json.NewDecoder(challenge.Body).Decode(&challengeBody); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(method, requestURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Webtermd-Nonce", challengeBody.Nonce)
	req.Header.Set("X-Webtermd-Signature", signNonce(priv, challengeBody.Nonce))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestFileAPISave(t *testing.T) {
	srv, priv, cleanup := setupTestServer(t)
	defer cleanup()

	cwd := t.TempDir()
	path := filepath.Join(cwd, "config.yaml")
	if err := os.WriteFile(path, []byte("enabled: true\n"), 0640); err != nil {
		t.Fatal(err)
	}

	putBody, err := json.Marshal(map[string]string{
		"cwd":     cwd,
		"path":    "config.yaml",
		"content": "enabled: false\n",
	})
	if err != nil {
		t.Fatal(err)
	}
	resp := authenticatedFileRequest(t, srv, priv, http.MethodPut, srv.URL+"/api/files", putBody)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT: expected 200, got %d", resp.StatusCode)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "enabled: false\n" {
		t.Fatalf("unexpected saved content: %q", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0640 {
		t.Fatalf("expected preserved mode 0640, got %04o", info.Mode().Perm())
	}
}

func TestFileAPIAccess(t *testing.T) {
	srv, priv, cleanup := setupTestServer(t)
	defer cleanup()

	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "config.py"), []byte("enabled = True\n"), 0600); err != nil {
		t.Fatal(err)
	}
	requestURL := srv.URL + "/api/files/access?cwd=" + url.QueryEscape(cwd) + "&path=config.py"
	resp := authenticatedFileRequest(t, srv, priv, http.MethodGet, requestURL, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var body struct {
		Path     string `json:"path"`
		Writable bool   `json:"writable"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Path != "config.py" || !body.Writable {
		t.Fatalf("unexpected access response: %#v", body)
	}
}

func TestFileAPIRejectsUnsafeRequests(t *testing.T) {
	srv, priv, cleanup := setupTestServer(t)
	defer cleanup()

	cwd := t.TempDir()
	if err := os.WriteFile(filepath.Join(cwd, "binary"), []byte{'a', 0, 'b'}, 0600); err != nil {
		t.Fatal(err)
	}

	unauthenticated, err := http.NewRequest(http.MethodPut, srv.URL+"/api/files", bytes.NewBufferString(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	unauthenticatedResponse, err := http.DefaultClient.Do(unauthenticated)
	if err != nil {
		t.Fatal(err)
	}
	if unauthenticatedResponse.StatusCode != http.StatusUnauthorized {
		unauthenticatedResponse.Body.Close()
		t.Fatalf("missing credentials: expected 401, got %d", unauthenticatedResponse.StatusCode)
	}
	unauthenticatedResponse.Body.Close()

	cases := []struct {
		name string
		path string
		want int
	}{
		{name: "traversal", path: "../outside", want: http.StatusBadRequest},
		{name: "directory", path: ".", want: http.StatusBadRequest},
		{name: "binary", path: "binary", want: http.StatusUnsupportedMediaType},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"cwd": cwd, "path": testCase.path, "content": "updated\n"})
			if err != nil {
				t.Fatal(err)
			}
			resp := authenticatedFileRequest(t, srv, priv, http.MethodPut, srv.URL+"/api/files", body)
			defer resp.Body.Close()
			if resp.StatusCode != testCase.want {
				t.Fatalf("expected %d, got %d", testCase.want, resp.StatusCode)
			}
		})
	}

	overLimit, err := json.Marshal(map[string]string{
		"cwd":     cwd,
		"path":    "binary",
		"content": strings.Repeat("x", maxEditorFileSize+1),
	})
	if err != nil {
		t.Fatal(err)
	}
	resp := authenticatedFileRequest(t, srv, priv, http.MethodPut, srv.URL+"/api/files", overLimit)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized content: expected 413, got %d", resp.StatusCode)
	}
}

func TestIsWithinDir(t *testing.T) {
	cases := []struct {
		root string
		path string
		want bool
	}{
		{root: "/", path: "/etc/nginx/nginx.conf", want: true},
		{root: "/tmp/work", path: "/tmp/work/config.yaml", want: true},
		{root: "/tmp/work", path: "/tmp/other/config.yaml", want: false},
	}
	for _, testCase := range cases {
		if got := isWithinDir(testCase.root, testCase.path); got != testCase.want {
			t.Errorf("isWithinDir(%q, %q) = %t, want %t", testCase.root, testCase.path, got, testCase.want)
		}
	}
}

func TestWebSocketResize(t *testing.T) {
	srv, priv, cleanup := setupTestServer(t)
	defer cleanup()

	resp, _ := http.Get(srv.URL + "/api/challenge")
	var body struct {
		Nonce string `json:"nonce"`
	}
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
