package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"ax-term/internal/auth"
	"ax-term/internal/ptysession"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// uploadEntry tracks a partial upload.
type uploadEntry struct {
	ID        string    `json:"id"`
	Filename  string    `json:"filename"`
	Size      int64     `json:"size"`
	Received  int64     `json:"received"`
	Token     string    `json:"token"`
	Dir       string    `json:"dir"`
	TempPath  string    `json:"-"`
	MetaPath  string    `json:"-"`
	ExpiresAt time.Time `json:"expires_at"`
}

// Server serves the API and static files.
type Server struct {
	auth       *auth.Authenticator
	mux        http.ServeMux
	noAuth     bool
	activeSess map[*websocket.Conn]*ptysession.Session
	mu         sync.Mutex

	uploadDir string
	uploads   map[string]*uploadEntry
	uploadMu  sync.Mutex
}

// New creates a new Server.
func New(a *auth.Authenticator, staticFS fs.FS, noAuth bool) *Server {
	uploadDir := filepath.Join(os.TempDir(), "ax-term-uploads")
	os.MkdirAll(uploadDir, 0700)

	s := &Server{
		auth:       a,
		noAuth:     noAuth,
		activeSess: make(map[*websocket.Conn]*ptysession.Session),
		uploadDir:  uploadDir,
		uploads:    make(map[string]*uploadEntry),
	}

	// Recover partial uploads from disk metadata.
	s.recoverUploads()

	s.mux.HandleFunc("/api/challenge", s.handleChallenge)
	s.mux.HandleFunc("/ws", s.handleWS)
	s.mux.HandleFunc("/api/upload/", s.handleUpload)
	s.mux.Handle("/", http.FileServerFS(staticFS))

	go s.uploadGC()

	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	nonce := s.auth.GenerateChallenge()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"nonce": nonce})
}

// --- upload helpers ---

func generateID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Server) metaPath(id string) string {
	return filepath.Join(s.uploadDir, id+".json")
}

func (s *Server) saveMeta(e *uploadEntry) {
	data, err := json.Marshal(e)
	if err != nil {
		return
	}
	os.WriteFile(e.MetaPath, data, 0600)
}

func (s *Server) recoverUploads() {
	entries, err := filepath.Glob(filepath.Join(s.uploadDir, "*.json"))
	if err != nil {
		return
	}
	now := time.Now()
	for _, mp := range entries {
		data, err := os.ReadFile(mp)
		if err != nil {
			continue
		}
		var e uploadEntry
		if json.Unmarshal(data, &e) != nil {
			continue
		}
		// Skip expired entries.
		if now.After(e.ExpiresAt) {
			os.Remove(mp)
			os.Remove(filepath.Join(s.uploadDir, e.ID+".download"))
			continue
		}
		e.MetaPath = mp
		e.TempPath = filepath.Join(s.uploadDir, e.ID+".download")
		s.uploads[e.ID] = &e
	}
}

func (s *Server) uploadGC() {
	for {
		time.Sleep(5 * time.Minute)
		s.uploadMu.Lock()
		now := time.Now()
		for id, e := range s.uploads {
			if now.After(e.ExpiresAt) {
				os.Remove(e.TempPath)
				os.Remove(e.MetaPath)
				delete(s.uploads, id)
			}
		}
		s.uploadMu.Unlock()
	}
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	// Path: /api/upload/<id>
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/upload/"), "/")
	if len(parts) < 1 || parts[0] == "" {
		http.Error(w, "missing upload id", http.StatusBadRequest)
		return
	}
	id := parts[0]
	token := r.URL.Query().Get("token")

	s.uploadMu.Lock()
	e, ok := s.uploads[id]
	s.uploadMu.Unlock()

	if !ok || e.Token != token {
		http.Error(w, "invalid or expired upload", http.StatusNotFound)
		return
	}

	switch r.Method {
	case http.MethodPost:
		// Upload a chunk. Query: ?offset=N
		var offset int64
		if _, err := fmt.Sscanf(r.URL.Query().Get("offset"), "%d", &offset); err != nil {
			http.Error(w, "invalid offset", http.StatusBadRequest)
			return
		}

		f, err := os.OpenFile(e.TempPath, os.O_WRONLY, 0600)
		if err != nil {
			http.Error(w, "open temp file: "+err.Error(), http.StatusInternalServerError)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			f.Close()
			http.Error(w, "read body: "+err.Error(), http.StatusInternalServerError)
			return
		}
		n, err := f.WriteAt(body, offset)
		f.Close()
		if err != nil {
			http.Error(w, "write failed: "+err.Error(), http.StatusInternalServerError)
			return
		}

		s.uploadMu.Lock()
		e.Received += int64(n)
		e.ExpiresAt = time.Now().Add(30 * time.Minute)
		s.uploadMu.Unlock()

		s.saveMeta(e)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"bytes_written": n,
			"received":      e.Received,
			"total":         e.Size,
		})

	case http.MethodGet:
		// Get upload status for resume.
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id":       e.ID,
			"filename": e.Filename,
			"received": e.Received,
			"total":    e.Size,
			"dir":      e.Dir,
		})

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Server) wsSendJSON(conn *websocket.Conn, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.noAuth {
		nonce := r.URL.Query().Get("nonce")
		signature := r.URL.Query().Get("signature")
		if nonce == "" || signature == "" {
			http.Error(w, "missing nonce or signature", http.StatusBadRequest)
			return
		}
		if !s.auth.Verify(nonce, signature) {
			http.Error(w, "authentication failed", http.StatusUnauthorized)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade: %v", err)
		return
	}
	defer conn.Close()

	sess, err := ptysession.New()
	if err != nil {
		log.Printf("pty spawn: %v", err)
		return
	}

	sessionToken := generateID()

	s.mu.Lock()
	s.activeSess[conn] = sess
	s.mu.Unlock()

	// Send session token for upload auth.
	s.wsSendJSON(conn, map[string]string{
		"type":          "session",
		"upload_token":  sessionToken,
		"upload_prefix": "/api/upload/",
	})

	defer func() {
		s.mu.Lock()
		delete(s.activeSess, conn)
		s.mu.Unlock()
		sess.Close()
	}()

	// CWD polling goroutine.
	cwdStop := make(chan struct{})
	defer close(cwdStop)
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		lastCWD := ""
		for {
			select {
			case <-cwdStop:
				return
			case <-ticker.C:
				cwd, err := sess.GetCWD()
				if err != nil || cwd == lastCWD {
					continue
				}
				lastCWD = cwd
				if err := s.wsSendJSON(conn, map[string]string{
					"type": "cwd",
					"path": cwd,
				}); err != nil {
					return
				}
			}
		}
	}()

	// PTY → WebSocket
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := sess.Read(buf)
			if err != nil {
				return
			}
			if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
				return
			}
		}
	}()

	// WebSocket → PTY / control
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		// Try JSON control messages first.
		var ctrl struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(msg, &ctrl) == nil && ctrl.Type != "" {
			switch ctrl.Type {
			case "resize":
				var resize struct {
					Rows uint16 `json:"rows"`
					Cols uint16 `json:"cols"`
				}
				if json.Unmarshal(msg, &resize) == nil && resize.Rows > 0 && resize.Cols > 0 {
					_ = sess.Resize(resize.Rows, resize.Cols)
				}

			case "upload-init":
				var init struct {
					Filename string `json:"filename"`
					Size     int64  `json:"size"`
				}
				if json.Unmarshal(msg, &init) != nil || init.Filename == "" || init.Size <= 0 {
					s.wsSendJSON(conn, map[string]string{"type": "upload-error", "message": "invalid filename or size"})
					continue
				}
				cwd, _ := sess.GetCWD()
				if cwd == "" {
					cwd = "/tmp"
				}
				id := generateID()
				tmpPath := filepath.Join(s.uploadDir, id+".download")
				f, err := os.Create(tmpPath)
				if err != nil {
					s.wsSendJSON(conn, map[string]string{"type": "upload-error", "message": "cannot create temp file"})
					continue
				}
				f.Close()

				e := &uploadEntry{
					ID:        id,
					Filename:  filepath.Base(init.Filename),
					Size:      init.Size,
					Token:     sessionToken,
					Dir:       cwd,
					TempPath:  tmpPath,
					MetaPath:  s.metaPath(id),
					ExpiresAt: time.Now().Add(30 * time.Minute),
				}

				s.uploadMu.Lock()
				s.uploads[id] = e
				s.uploadMu.Unlock()

				s.saveMeta(e)

				s.wsSendJSON(conn, map[string]interface{}{
					"type":       "upload-init",
					"id":         id,
					"filename":   init.Filename,
					"dir":        cwd,
					"chunk_size": 1 << 20, // 1MB
				})

			case "upload-commit":
				var commit struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(msg, &commit) != nil || commit.ID == "" {
					s.wsSendJSON(conn, map[string]string{"type": "upload-error", "message": "missing id"})
					continue
				}

				s.uploadMu.Lock()
				e, ok := s.uploads[commit.ID]
				if !ok || e.Token != sessionToken {
					s.uploadMu.Unlock()
					s.wsSendJSON(conn, map[string]string{"type": "upload-error", "message": "upload not found or unauthorized"})
					continue
				}
				delete(s.uploads, commit.ID)
				s.uploadMu.Unlock()

				if e.Received < e.Size {
					os.Remove(e.TempPath)
					os.Remove(e.MetaPath)
					s.wsSendJSON(conn, map[string]string{"type": "upload-error", "message": "incomplete upload"})
					continue
				}

				dest := filepath.Join(e.Dir, e.Filename)
				if err := os.Rename(e.TempPath, dest); err != nil {
					os.Remove(e.TempPath)
					os.Remove(e.MetaPath)
					s.wsSendJSON(conn, map[string]string{"type": "upload-error", "message": "move to target: " + err.Error()})
					continue
				}
				os.Remove(e.MetaPath)

				s.wsSendJSON(conn, map[string]interface{}{
					"type":     "upload-done",
					"id":       commit.ID,
					"filename": e.Filename,
					"path":     dest,
				})

			case "upload-status":
				var status struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(msg, &status) != nil || status.ID == "" {
					continue
				}
				s.uploadMu.Lock()
				e, ok := s.uploads[status.ID]
				s.uploadMu.Unlock()
				if !ok || e.Token != sessionToken {
					s.wsSendJSON(conn, map[string]interface{}{"type": "upload-status", "id": status.ID, "exists": false})
					continue
				}
				s.wsSendJSON(conn, map[string]interface{}{
					"type":     "upload-status",
					"id":       e.ID,
					"filename": e.Filename,
					"received": e.Received,
					"total":    e.Size,
					"exists":   true,
				})

			case "upload-cancel":
				var cancel struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(msg, &cancel) != nil || cancel.ID == "" {
					continue
				}
				s.uploadMu.Lock()
				e, ok := s.uploads[cancel.ID]
				if ok && e.Token == sessionToken {
					os.Remove(e.TempPath)
					os.Remove(e.MetaPath)
					delete(s.uploads, cancel.ID)
				}
				s.uploadMu.Unlock()
			}
			continue
		}

		// Otherwise, write keystrokes to PTY.
		sess.Write(msg)
	}
}
