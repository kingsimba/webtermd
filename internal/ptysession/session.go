package ptysession

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/creack/pty"
)

// Session wraps a PTY attached to a shell.
type Session struct {
	cmd    *exec.Cmd
	pty    *os.File
	closed chan struct{}
}

// New spawns a Bash PTY and returns a Session.
func New() (*Session, error) {
	cmd := exec.Command("bash")
	cmd.Env = append(cmd.Environ(), "TERM=xterm-256color")

	f, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}

	return &Session{
		cmd:    cmd,
		pty:    f,
		closed: make(chan struct{}),
	}, nil
}

// Read reads PTY output into buf. Blocks until data is available or the session is closed.
func (s *Session) Read(buf []byte) (int, error) {
	return s.pty.Read(buf)
}

// Write writes input bytes into the PTY.
func (s *Session) Write(data []byte) (int, error) {
	return s.pty.Write(data)
}

// Resize changes the PTY window size.
func (s *Session) Resize(rows, cols uint16) error {
	ws := &pty.Winsize{Rows: rows, Cols: cols}
	return pty.Setsize(s.pty, ws)
}

// Close terminates the PTY and waits for the shell to exit.
func (s *Session) Close() error {
	select {
	case <-s.closed:
		return nil
	default:
		close(s.closed)
	}
	// Kill the process group so child processes also die.
	if s.cmd.Process != nil {
		s.cmd.Process.Kill()
	}
	_ = s.pty.Close()
	_ = s.cmd.Wait()
	return nil
}

// GetCWD returns the current working directory of the shell process.
func (s *Session) GetCWD() (string, error) {
	if s.cmd.Process == nil {
		return "", fmt.Errorf("process not started")
	}
	link := fmt.Sprintf("/proc/%d/cwd", s.cmd.Process.Pid)
	return filepath.EvalSymlinks(link)
}

// PID returns the shell process PID.
func (s *Session) PID() int {
	if s.cmd.Process == nil {
		return 0
	}
	return s.cmd.Process.Pid
}

// Done returns a channel that is closed when the PTY exits.
func (s *Session) Done() <-chan struct{} {
	return s.closed
}

// StdioPipe provides direct ReadWriteCloser access to the PTY for piping.
func (s *Session) StdioPipe() io.ReadWriteCloser {
	return &ptyReadWriteCloser{
		Reader: s.pty,
		Writer: s.pty,
		Closer: s,
	}
}

type ptyReadWriteCloser struct {
	io.Reader
	io.Writer
	Closer io.Closer
}

func (p *ptyReadWriteCloser) Close() error {
	return p.Closer.Close()
}
