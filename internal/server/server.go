package server

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"ax-term/internal/auth"
	"ax-term/internal/ptysession"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Server serves the API and static files.
type Server struct {
	auth       *auth.Authenticator
	mux        http.ServeMux
	staticDir  string
	activeSess map[*websocket.Conn]*ptysession.Session
	mu         sync.Mutex
}

// New creates a new Server.
func New(a *auth.Authenticator, staticDir string) *Server {
	s := &Server{
		auth:       a,
		staticDir:  staticDir,
		activeSess: make(map[*websocket.Conn]*ptysession.Session),
	}
	s.mux.HandleFunc("/api/challenge", s.handleChallenge)
	s.mux.HandleFunc("/ws", s.handleWS)
	s.mux.Handle("/", http.FileServer(http.Dir(staticDir)))
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

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
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

	s.mu.Lock()
	s.activeSess[conn] = sess
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.activeSess, conn)
		s.mu.Unlock()
		sess.Close()
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

	// WebSocket → PTY
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		// Check for resize control message (JSON: {"rows":N,"cols":N})
		var resize struct {
			Rows uint16 `json:"rows"`
			Cols uint16 `json:"cols"`
		}
		if json.Unmarshal(msg, &resize) == nil && resize.Rows > 0 && resize.Cols > 0 {
			_ = sess.Resize(resize.Rows, resize.Cols)
			continue
		}

		// Otherwise, write keystrokes to PTY
		sess.Write(msg)
	}
}
