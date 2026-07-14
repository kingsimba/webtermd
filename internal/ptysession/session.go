package ptysession

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

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

// leafPID walks /proc/<pid>/task/<pid>/children to find the deepest
// living descendant.  This handles nested shells (bash→bash),
// screen/tmux (bash→screen→SCREEN→bash), and foreground commands
// (bash→vim).  Returns the starting pid when traversal fails or no
// children exist.
func leafPID(pid int) int {
	for {
		data, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/children", pid, pid))
		if err != nil {
			return pid
		}
		children := strings.Fields(string(data))
		found := false
		for _, c := range children {
			child, err := strconv.Atoi(c)
			if err != nil {
				continue
			}
			// Verify child is still alive.
			if _, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", child)); err == nil {
				pid = child
				found = true
				break
			}
		}
		if !found {
			return pid
		}
	}
}

// GetCWD returns the current working directory of the shell process
// or its deepest child (handles screen, tmux, nested shells).
func (s *Session) GetCWD() (string, error) {
	if s.cmd.Process == nil {
		return "", fmt.Errorf("process not started")
	}
	pid := leafPID(s.cmd.Process.Pid)
	link := fmt.Sprintf("/proc/%d/cwd", pid)
	return filepath.EvalSymlinks(link)
}

// ForegroundProc returns the name of the foreground process on the
// controlling terminal, or "" if it cannot be determined.  Uses leafPID
// to find the innermost process, then reads /proc/<pid>/stat to find
// the tpgid (foreground process group), then /proc/<tpgid>/comm for
// the name.  Returns "bash", "vim", "python3", etc.
func (s *Session) ForegroundProc() string {
	if s.cmd.Process == nil {
		return ""
	}
	pid := leafPID(s.cmd.Process.Pid)

	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return ""
	}
	// Format: <pid> (<comm>) <state> ...; skip comm by finding the last ')'.
	line := string(data)
	idx := strings.LastIndexByte(line, ')')
	if idx < 0 || idx+1 >= len(line) {
		return ""
	}
	fields := strings.Fields(line[idx+1:])
	// fields[0]=state, [1]=ppid, [2]=pgrp, [3]=session, [4]=tty_nr, [5]=tpgid
	if len(fields) < 6 {
		return ""
	}
	tpgid, err := strconv.Atoi(fields[5])
	if err != nil {
		return ""
	}

	comm, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", tpgid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(comm))
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
