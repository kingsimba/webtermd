package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
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

// downloadEntry is a one-time download token.
type downloadEntry struct {
	Path      string
	Filename  string
	ExpiresAt time.Time
}

// Server serves the API and static files.
type Server struct {
	auth       *auth.Authenticator
	mux        http.ServeMux
	noAuth     bool
	activeSess map[*websocket.Conn]*ptysession.Session
	mu         sync.Mutex

	uploadDir      string
	uploads        map[string]*uploadEntry
	uploadMu       sync.Mutex
	downloadTokens map[string]*downloadEntry
	downloadMu     sync.Mutex
}

// New creates a new Server.
func New(a *auth.Authenticator, staticFS fs.FS, noAuth bool) *Server {
	homeDir, _ := os.UserHomeDir()
	if homeDir == "" {
		homeDir = "/tmp"
	}
	uploadDir := filepath.Join(homeDir, ".ax-term-uploads")
	os.MkdirAll(uploadDir, 0700)

	s := &Server{
		auth:           a,
		noAuth:         noAuth,
		activeSess:     make(map[*websocket.Conn]*ptysession.Session),
		uploadDir:      uploadDir,
		uploads:        make(map[string]*uploadEntry),
		downloadTokens: make(map[string]*downloadEntry),
	}

	// Recover partial uploads from disk metadata.
	s.recoverUploads()

	s.mux.HandleFunc("/api/challenge", s.handleChallenge)
	s.mux.HandleFunc("/ws", s.handleWS)
	s.mux.HandleFunc("/api/upload/", s.handleUpload)
	s.mux.HandleFunc("/api/download/", s.handleDownload)
	s.mux.Handle("/", http.FileServerFS(staticFS))

	go s.uploadGC()
	go s.downloadGC()

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
	token := r.URL.Query().Get("utoken")

	s.uploadMu.Lock()
	e, ok := s.uploads[id]
	s.uploadMu.Unlock()

	if !ok {
		http.Error(w, "invalid or expired upload", http.StatusNotFound)
		return
	}
	// After server restart, a recovered upload may have a different token.
	// Accept the new token if it's the first request from the new session.
	if e.Token != token {
		s.uploadMu.Lock()
		e.Token = token
		s.saveMeta(e)
		s.uploadMu.Unlock()
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

func (s *Server) handleDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Path: /api/download/<token>
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/download/"), "/")
	if len(parts) < 1 || parts[0] == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}
	token := parts[0]

	s.downloadMu.Lock()
	e, ok := s.downloadTokens[token]
	s.downloadMu.Unlock()

	if !ok || time.Now().After(e.ExpiresAt) {
		http.Error(w, "invalid or expired download link", http.StatusNotFound)
		return
	}

	// Heartbeat: extend expiry while ServeContent is streaming, so long
	// transfers and paused downloads don't lose their token mid-flight.
	// After ServeContent returns (done or disconnected), the token still
	// has 10 minutes for Range retries.
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(1 * time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				s.downloadMu.Lock()
				if e, ok := s.downloadTokens[token]; ok {
					e.ExpiresAt = time.Now().Add(10 * time.Minute)
				}
				s.downloadMu.Unlock()
			}
		}
	}()
	defer close(stop)

	f, err := os.Open(e.Path)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, e.Filename))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, e.Filename, info.ModTime(), f)
}

func (s *Server) downloadGC() {
	for {
		time.Sleep(1 * time.Minute)
		s.downloadMu.Lock()
		now := time.Now()
		for token, e := range s.downloadTokens {
			if now.After(e.ExpiresAt) {
				delete(s.downloadTokens, token)
			}
		}
		s.downloadMu.Unlock()
	}
}

func (s *Server) wsSendJSON(conn *websocket.Conn, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}

// dirHash returns a hex SHA-256 hash of the sorted directory entry names.
// Returns empty string if the directory cannot be read.
func dirHash(path string) string {
	entries, err := os.ReadDir(path)
	if err != nil {
		return ""
	}
	h := sha256.New()
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for _, e := range entries {
		h.Write([]byte(e.Name()))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// sendFileList reads a directory and sends a file-list message over the WebSocket.
func (s *Server) sendFileList(conn *websocket.Conn, cwd string) {
	entries, err := os.ReadDir(cwd)
	if err != nil {
		s.wsSendJSON(conn, map[string]string{"type": "file-list-error", "message": err.Error()})
		return
	}
	type fileInfo struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		IsDir bool   `json:"isDir"`
	}
	files := make([]fileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, fileInfo{
			Name:  e.Name(),
			Size:  info.Size(),
			IsDir: e.IsDir(),
		})
	}
	s.wsSendJSON(conn, map[string]interface{}{
		"type":  "file-list",
		"dir":   cwd,
		"files": files,
	})
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

	// CWD + directory polling goroutine.
	cwdStop := make(chan struct{})
	defer close(cwdStop)
	go func() {
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		lastCWD := ""
		lastDirHash := ""
		for {
			select {
			case <-cwdStop:
				return
			case <-ticker.C:
				cwd, err := sess.GetCWD()
				if err != nil || cwd == "" {
					continue
				}
				// Send cwd when it changes.
				if cwd != lastCWD {
					lastCWD = cwd
					lastDirHash = "" // force file-list on CWD change
					if err := s.wsSendJSON(conn, map[string]string{
						"type": "cwd",
						"path": cwd,
					}); err != nil {
						return
					}
				}
				// Auto-refresh file list when directory content changes.
				dh := dirHash(cwd)
				if dh != "" && dh != lastDirHash {
					lastDirHash = dh
					s.sendFileList(conn, cwd)
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

			case "restore-cwd":
				var rc struct {
					Path string `json:"path"`
				}
				if json.Unmarshal(msg, &rc) != nil || rc.Path == "" {
					continue
				}
				if info, err := os.Stat(rc.Path); err == nil && info.IsDir() {
					sess.Write([]byte("cd " + rc.Path + "\n"))
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
				if !ok {
					s.uploadMu.Unlock()
					s.wsSendJSON(conn, map[string]interface{}{"type": "upload-status", "id": status.ID, "exists": false})
					continue
				}
				// Re-own recovered uploads to the new session token
				// (server restart generates a new session token).
				if e.Token != sessionToken {
					e.Token = sessionToken
					s.saveMeta(e)
				}
				s.uploadMu.Unlock()
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

			case "list-files":
				cwd, _ := sess.GetCWD()
				if cwd == "" {
					cwd = "/tmp"
				}
				s.sendFileList(conn, cwd)

			case "download":
				var dl struct {
					Path string `json:"path"`
				}
				if json.Unmarshal(msg, &dl) != nil || dl.Path == "" {
					s.wsSendJSON(conn, map[string]string{"type": "download-error", "message": "missing path"})
					continue
				}
				cwd, _ := sess.GetCWD()
				if cwd == "" {
					cwd = "/tmp"
				}
				// Resolve and validate path stays within CWD.
				resolved := filepath.Clean(filepath.Join(cwd, dl.Path))
				if !strings.HasPrefix(resolved, cwd+string(os.PathSeparator)) && resolved != cwd {
					s.wsSendJSON(conn, map[string]string{"type": "download-error", "message": "path escapes working directory"})
					continue
				}
				info, err := os.Stat(resolved)
				if err != nil || info.IsDir() {
					s.wsSendJSON(conn, map[string]string{"type": "download-error", "message": "file not found or is a directory"})
					continue
				}
				token := generateID()
				s.downloadMu.Lock()
				s.downloadTokens[token] = &downloadEntry{
					Path:      resolved,
					Filename:  filepath.Base(resolved),
					ExpiresAt: time.Now().Add(10 * time.Minute),
				}
				s.downloadMu.Unlock()
				s.wsSendJSON(conn, map[string]interface{}{
					"type":     "download-ready",
					"url":      "/api/download/" + token,
					"filename": filepath.Base(resolved),
				})
			}
			continue
		}

		// Otherwise, write keystrokes to PTY.
		sess.Write(msg)
	}
}
