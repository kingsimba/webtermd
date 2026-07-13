# Design Insights

Key architectural decisions and non-obvious mechanisms in ax-term.

---

## Reverse Proxy: Base Path on the Client, Not the Server

The server has no concept of a URL prefix — it serves all routes from `/` (`/api/challenge`, `/ws`, `/api/download/...`). When deployed behind a reverse proxy at a sub-path (e.g., `/robot_api/v1/.../term/`), all paths shift.

**Decision:** The client computes the base path from `location.pathname` and prepends it to every URL it constructs. The server generates relative API paths (`/api/download/...`) and the client normalizes them.

**Why on the client:** The server doesn't know its own public URL. Nginx could pass `X-Forwarded-Prefix`, but that requires coordination between the proxy config and the app — fragile. The browser always knows the real URL. The client is the single point where the prefix gets applied, keeping the server stateless with respect to routing.

**Trade-off:** Upload and download URLs are absolute-path on the wire, then prefixed by the client before use. A different client (e.g., curl) would need to do the same prefixing. If you ever need the server to generate full URLs (e.g., for emailed download links), you'd need to add a configurable base URL to the server.

---

## WebSocket: Binary for I/O, JSON for Control

A single WebSocket carries two lanes: raw PTY bytes (bidirectional binary) and JSON control messages (bidirectional text). There's no multiplexing protocol or sub-protocol negotiation — the `type` field in JSON and the binary/text distinction is enough.

**Why a single connection:** Avoids the complexity of coordinating two connections (one for terminal, one for file operations). The session token for upload auth is delivered on the control channel, so it's inherently tied to the WebSocket lifecycle.

**Why binary for terminal I/O:** UTF-8 bytes go straight from xterm.js to the PTY and back, with no JSON encoding overhead. Unicode characters, ANSI escapes, and binary escapes all pass through transparently.

---

## CWD Tracking: /proc Polling, Not Shell Hooks

The server reads `/proc/<pid>/cwd` every 500ms to detect directory changes. There are no shell hooks, no `PROMPT_COMMAND`, no OSC 7 escape sequences.

**Decision:** Polling is simpler than injecting behavior into the shell. It works regardless of shell configuration (bash, zsh, fish), doesn't require modifying `.bashrc`, and survives `exec bash` or nested shells — as long as the top-level shell process changes directory, `/proc/<pid>/cwd` reflects it.

**Trade-off:** Up to 500ms of staleness. For a terminal that displays the CWD in a toolbar, this is imperceptible. A more precise approach would intercept `cd` via shell hooks, but that breaks when the user runs a different shell or clears their environment.

---

## CWD Restore After Server Restart

When the server restarts, the PTY dies and a fresh shell spawns at `$HOME`. The client remembers the last CWD and can restore it — but must distinguish a server restart (new shell, wrong CWD) from a brief network blip (same shell, correct CWD).

**Decision:** On WebSocket open, the client records its last known CWD. It waits for the server's first `cwd` message (which arrives within 500ms from the polling goroutine). If the server's CWD differs from what the client remembers, the shell must be new — the client sends `restore-cwd` and the server injects `cd <path>` into the PTY. If they match, nothing happens.

**Why wait for the first cwd message:** Injecting `cd` immediately on connect risks corrupting user input if the user was mid-typing during a network blip. By waiting for the CWD poll to prove the shell is fresh, the restore only fires when the terminal is guaranteed idle (no user has typed anything into the new shell yet).

**Why inject keystrokes instead of setting the shell's CWD directly:** The shell tracks its own CWD internally (for `$PWD`, prompt rendering, tab completion). Changing the process's CWD via `os.Chdir` wouldn't update the shell's internal state. Writing `cd <path>\n` to the PTY is the only way to make bash aware of the change.

---

## Download: Token-based with Heartbeat

File downloads go through HTTP, not the WebSocket, to leverage browser download managers (pause, resume, Range requests).

**Decision:** A one-time token is generated via WebSocket and passed to the client as a URL. The browser navigates an iframe to that URL, triggering a download without navigating the main page. Tokens expire after 10 minutes of inactivity.

**Heartbeat during transfer:** A goroutine extends the token expiry every minute while `http.ServeContent` is streaming. This keeps the token alive for the entire download, even if it takes longer than 10 minutes (large files, slow connections).

**Why iframe navigation:** A direct `window.location` redirect would close the WebSocket. An `<a>` click with `download` attribute works but doesn't send cookies/auth headers (the download endpoint uses URL tokens, so this isn't an issue here, but the iframe pattern is forward-compatible).

**Why Range support matters:** Chrome's download manager issues Range requests for pause/resume. Without `Accept-Ranges`, a paused download must restart from zero. The token heartbeat ensures the token is still valid when Chrome retries.

---

## Upload: Chunked HTTP with WebSocket Coordination

Uploads are initiated via WebSocket (to get auth tokens and a temp file ID), then chunked over HTTP POST.

**Decision:** Separation of concerns. The WebSocket carries the control plane (init, commit, cancel, status). HTTP carries the data plane — it's built for large binary transfers, supports streaming, and doesn't interfere with terminal responsiveness.

**Resume across restarts:** The client stores upload state (ID, filename, offset) in `localStorage`. On reconnect, it queries the server for the upload's current received bytes via `upload-status` and resumes from that offset. The server persists temp files and metadata JSON on disk, so uploads survive server restarts within a 30-minute expiry window.

**Why chunk at 1 MiB:** Large enough to amortize HTTP overhead, small enough that a failed chunk doesn't waste much work. Also fits comfortably in browser memory limits.

---

## Upload Persistence on Disk

Partial uploads write to `<id>.download` files with metadata in `<id>.json` files. On startup, the server scans the upload directory and rebuilds its in-memory state.

**Why files, not an embedded database:** There are at most a handful of concurrent uploads per server instance. Files are simpler — no schema migrations, no dependency. The `.download` + `.json` pair is self-describing: the JSON has all the metadata, the download file is the raw bytes. GC just deletes both files.

---

## No Authentication State: Stateless Challenge-Response

The challenge endpoint generates a random nonce (valid for 60 seconds, single-use). The WebSocket upgrade includes the nonce and its signature. The server verifies the signature against `authorized_keys` and the connection proceeds.

**Decision:** No sessions, no cookies, no JWT. The WebSocket connection itself is the session — when it drops, everything is gone except the disk-backed upload state. Key changes in `authorized_keys` take effect immediately on the next connection.

**Why stateless:** The server is an edge daemon that might restart at any time. Stateless auth means no session store to recover, no tokens to revoke, no clock-sync issues.

---

## Copy/Paste: Ctrl+C/V as Windows Terminal

By default, xterm.js sends Ctrl+C (`\x03`) and Ctrl+V (`\x16`) straight to the PTY. This is the Unix terminal convention, but it conflicts with muscle memory for users accustomed to Windows Terminal or modern GUI apps, where Ctrl+C copies and Ctrl+V pastes.

**Decision:** Ctrl+C copies the selection to clipboard; only when nothing is selected does `\x03` reach the PTY as SIGINT. Ctrl+V always reads the system clipboard and pastes into the terminal.

**Capture-phase DOM listener, not `attachCustomKeyEventHandler`:** The xterm.js API `attachCustomKeyEventHandler` fires during xterm.js's own keydown handling. Returning `false` tells xterm.js to skip sending the byte to onData, but the browser's native paste behavior on the hidden textarea can still fire independently, causing duplicate pastes. A capture-phase `addEventListener(..., true)` on the terminal container element runs before any xterm.js internal handler and before the browser's default action. `stopImmediatePropagation()` kills the event entirely — xterm.js and the browser never see it.

**Why `navigator.clipboard` instead of execCommand:** The Clipboard API is async, requires a user gesture (which a keydown satisfies), and works in all modern browsers. `document.execCommand('copy')` is synchronous but deprecated and blocked in some contexts.

**Why `term.paste()` for paste instead of writing to onData:** `term.paste()` handles bracketed paste mode, multi-line text, and line-feed normalization. Writing raw bytes directly would bypass these.
