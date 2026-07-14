# API Reference

webtermd is an edge daemon. Its only client is the Node.js gateway, which holds the private key. End-user authentication (LDAP) happens at the gateway — webtermd does not know or care about users.

## Authentication Model

webtermd reads `~/.ssh/authorized_keys` on each connection attempt. Key changes take effect immediately — no restart needed. The Node.js gateway holds the matching private key. To connect, the gateway proves key possession via challenge-response — the private key never leaves the gateway.

Adding or rotating keys is just `ssh-copy-id` or editing `authorized_keys`.

---

## HTTP

### GET /api/challenge

Returns a one-time nonce for WebSocket authentication.

**Response** `200 OK`

```json
{
  "nonce": "dGhpcyBpcyBhIHJhbmRvbSBub25jZQ=="
}
```

The nonce is a base64-encoded random string. It expires after 5 minutes of inactivity — each successful verification extends the expiry, so the same nonce+signature pair can be reused across page refreshes while the session stays active.

#### Signing from the command line

The server uses RSA PKCS1v1.5 over SHA-256. The frontend displays a one-liner you can copy and run to sign the nonce:

```bash
printf '%s' '<nonce>' | openssl dgst -sha256 -sign ~/.ssh/id_rsa | base64 -w0
```

If your key has a passphrase, OpenSSL will prompt for it. Paste the output into the signature field in the frontend.

**Key format requirement**: Your private key must be in PEM format (begins with `-----BEGIN RSA PRIVATE KEY-----`). OpenSSH-native format keys (begins with `-----BEGIN OPENSSH PRIVATE KEY-----`) need a one-time conversion:

```bash
ssh-keygen -p -m PEM -f ~/.ssh/id_rsa
```

---

### POST /api/upload/:id

Upload a chunk of a file. The upload must have been initiated via WebSocket first.

**Query parameters**

| Parameter | Description                             |
| --------- | --------------------------------------- |
| `utoken`  | Upload token from the WebSocket session |
| `offset`  | Byte offset to write this chunk at      |

**Request body** — raw binary chunk.

**Response** `200 OK`

```json
{
  "bytes_written": 1048576,
  "received": 1048576,
  "total": 4194304
}
```

| Field           | Description                   |
| --------------- | ----------------------------- |
| `bytes_written` | Bytes written from this chunk |
| `received`      | Total bytes received so far   |
| `total`         | Expected total file size      |

---

### GET /api/upload/:id

Query the status of an in-progress upload (used for resuming interrupted uploads).

**Query parameters**

| Parameter | Description                             |
| --------- | --------------------------------------- |
| `utoken`  | Upload token from the WebSocket session |

**Response** `200 OK`

```json
{
  "id": "a1b2c3...",
  "filename": "report.pdf",
  "received": 2097152,
  "total": 4194304,
  "dir": "/home/user/projects"
}
```

| Field      | Description                         |
| ---------- | ----------------------------------- |
| `id`       | Upload ID                           |
| `filename` | Original filename                   |
| `received` | Bytes received so far               |
| `total`    | Expected total file size            |
| `dir`      | Target directory (CWD at init time) |

---

### GET /api/download/:token

Download a file using a token. Tokens are generated via the `download` WebSocket control message and expire after 10 minutes of inactivity. While data is streaming, a heartbeat extends the expiry every minute — long transfers and paused downloads are uninterrupted. Tokens are deleted by the GC goroutine after 10 minutes with no active transfer.

Supports `Range` requests (partial content) and `ETag`/`Last-Modified` for resumable downloads. Chrome's download manager can pause and resume transparently.

**Response headers**

| Header                | Value                           |
| --------------------- | ------------------------------- |
| `Content-Disposition` | `attachment; filename="..."`    |
| `Content-Type`        | `application/octet-stream`      |
| `ETag`                | Hex-encoded file modtime + size |
| `Last-Modified`       | File modification time          |
| `Accept-Ranges`       | `bytes`                         |

**Response** `200 OK` — full file content, or `206 Partial Content` for Range requests.

**Errors**

| Status | Description              |
| ------ | ------------------------ |
| 404    | Invalid or expired token |
| 404    | File not found on disk   |

Tokens can be reused for Range retries. A heartbeat goroutine extends the expiry every minute while `ServeContent` is streaming — the token stays valid for the entire transfer plus 10 minutes after disconnection. They are deleted by the GC goroutine after 10 minutes of inactivity.

### WS /ws

Open a PTY session as the webtermd process user.

**Connection**

```
ws://host:port/ws?nonce=<base64>&signature=<base64>
```

| Parameter   | Description                                       |
| ----------- | ------------------------------------------------- |
| `nonce`     | Challenge from `GET /api/challenge`               |
| `signature` | Nonce signed with the private key, base64-encoded |

The server verifies the signature against the runtime user's `authorized_keys`. Mismatch → connection rejected.

**Message format**

Two message types flow over the same WebSocket:

| Type   | Direction       | Content                        |
| ------ | --------------- | ------------------------------ |
| Binary | Client → Server | Keystrokes (UTF-8)             |
| Binary | Server → Client | Terminal output (ANSI-escaped) |
| Text   | Client → Server | JSON control messages          |
| Text   | Server → Client | JSON control messages          |

Binary messages are raw PTY I/O — they flow directly between xterm.js and the bash process.

Text messages are JSON with a `type` field. They carry control-plane data (resize, CWD updates, file uploads).

---

### WebSocket Control Messages

#### Client → Server

##### resize

Sent when the terminal window changes size.

```json
{ "type": "resize", "rows": 24, "cols": 80 }
```

##### upload-init

Request a new upload. The server creates a temp file, returns an upload ID.

```json
{ "type": "upload-init", "filename": "report.pdf", "size": 4194304 }
```

| Field      | Description              |
| ---------- | ------------------------ |
| `filename` | Original file name       |
| `size`     | Total file size in bytes |

Server responds with `upload-init`.

##### upload-commit

Finalize a completed upload. The server moves the temp file to the target directory (CWD at init time).

```json
{ "type": "upload-commit", "id": "a1b2c3..." }
```

Server responds with `upload-done` or `upload-error`.

##### upload-status

Query the server for an in-progress upload's state (used to resume after reconnect).

```json
{ "type": "upload-status", "id": "a1b2c3..." }
```

Server responds with `upload-status`.

##### upload-cancel

Cancel and clean up an in-progress upload.

```json
{ "type": "upload-cancel", "id": "a1b2c3..." }
```

##### list-files

Request a listing of the current working directory.

```json
{ "type": "list-files" }
```

Server responds with `file-list` or `file-list-error`.

##### download

Request a one-time download URL for a file relative to the current working directory. The path must not escape the CWD (e.g., `../` is blocked).

```json
{ "type": "download", "path": "report.pdf" }
```

Server responds with `download-ready` or `download-error`.

##### preview

Request a preview of a text file relative to the current working directory. The server reads the file and returns its content inline. Files larger than 128 KiB are rejected.

```json
{ "type": "preview", "path": "config.ini" }
```

Server responds with `preview-content` or `preview-error`.

##### restore-cwd

Sent on reconnect when the client detects the server started a fresh shell (CWD reported by the server differs from the last known CWD before disconnect). The server validates the path and injects `cd <path>` into the PTY to restore the working directory.

```json
{ "type": "restore-cwd", "path": "/home/user/projects" }
```

| Field  | Description                               |
| ------ | ----------------------------------------- |
| `path` | Absolute path to restore as the shell CWD |

This message is safe against network blips — the client only sends it when the server's first `cwd` message proves the shell was restarted. If the same shell is still running (network reconnect), the paths match and no restore is triggered.

---

#### Server → Client

##### session

Sent immediately after WebSocket upgrade. Provides an upload token valid for this session.

```json
{
  "type": "session",
  "upload_token": "deadbeef...",
  "upload_prefix": "/api/upload/"
}
```

| Field           | Description                                 |
| --------------- | ------------------------------------------- |
| `upload_token`  | Token required for HTTP upload endpoints    |
| `upload_prefix` | URL prefix for constructing upload requests |

##### cwd

Sent when the shell's working directory changes. Polled every 500ms via `/proc/<pid>/cwd`.

```json
{ "type": "cwd", "path": "/home/user/projects" }
```

##### foreground

Sent when the foreground process on the controlling terminal changes. Polled every 500ms alongside `cwd` via `/proc/<pid>/stat`. The `proc` field is the process name from `/proc/<tpgid>/comm` — e.g. `bash`, `vim`, `python3`, `screen`. The client uses this to enable or disable directory-navigation double-click behaviour (only safe to inject `cd` keystrokes when the foreground process is a known shell).

```json
{ "type": "foreground", "proc": "bash" }
```

##### upload-init

Server response to `upload-init`. The client should begin uploading chunks via HTTP.

```json
{
  "type": "upload-init",
  "id": "a1b2c3...",
  "dir": "/home/user/projects",
  "chunk_size": 1048576
}
```

| Field        | Description                                   |
| ------------ | --------------------------------------------- |
| `id`         | Unique upload ID (use in HTTP chunk requests) |
| `dir`        | Target directory where the file will land     |
| `chunk_size` | Suggested chunk size (1 MiB)                  |

##### upload-done

Upload completed and file was moved to the target directory.

```json
{
  "type": "upload-done",
  "id": "a1b2c3...",
  "filename": "report.pdf",
  "path": "/home/user/projects/report.pdf"
}
```

##### upload-status

Response to an `upload-status` query. `exists` is `false` if the upload was not found (expired or cleaned up).

```json
{
  "type": "upload-status",
  "id": "a1b2c3...",
  "filename": "report.pdf",
  "received": 2097152,
  "total": 4194304,
  "exists": true
}
```

##### upload-error

An error occurred during upload.

```json
{ "type": "upload-error", "message": "incomplete upload" }
```

##### file-list

Response to `list-files`. Contains the resolved directory path and a list of entries.

```json
{
  "type": "file-list",
  "dir": "/home/user/projects",
  "files": [
    { "name": "report.pdf", "size": 4194304, "isDir": false },
    { "name": "src", "size": 4096, "isDir": true }
  ]
}
```

| Field           | Description             |
| --------------- | ----------------------- |
| `dir`           | Resolved directory path |
| `files[].name`  | File or directory name  |
| `files[].size`  | Size in bytes           |
| `files[].isDir` | `true` if directory     |

##### file-list-error

An error occurred while listing files.

```json
{ "type": "file-list-error", "message": "permission denied" }
```

##### download-ready

Response to `download`. Provides a one-time URL for downloading the file.

```json
{
  "type": "download-ready",
  "url": "/api/download/a1b2c3...",
  "filename": "report.pdf"
}
```

| Field      | Description                                 |
| ---------- | ------------------------------------------- |
| `url`      | URL path for `GET /api/download/<token>`    |
| `filename` | Original filename (for Content-Disposition) |

The client should navigate to `url` to trigger the browser download. Tokens can be reused for Range retries — a heartbeat keeps the token alive during active transfers, plus 10 minutes after disconnection.

##### download-error

An error occurred preparing the download.

```json
{ "type": "download-error", "message": "path escapes working directory" }
```

##### preview-content

Response to `preview`. Contains the file content.

```json
{
  "type": "preview-content",
  "path": "config.ini",
  "content": "[server]\nhost=localhost\nport=8080\n"
}
```

| Field     | Description                   |
| --------- | ----------------------------- |
| `path`    | Requested file path           |
| `content` | Full file content as a string |

##### preview-error

An error occurred reading the file for preview.

```json
{ "type": "preview-error", "message": "file too large for preview" }
```

---

### Upload Protocol Flow

```
Client                          Server
  │                                │
  │  ws: upload-init               │
  │  {"filename":"f.pdf","size":N} │
  │ ─────────────────────────────> │  creates temp file
  │                                │
  │  ws: upload-init               │
  │  {"id":"abc","dir":"/home/.."} │
  │ <────────────────────────────  │
  │                                │
  │  HTTP POST /api/upload/abc     │
  │  ?utoken=X&offset=0             │
  │  [chunk 1 binary]              │
  │ ─────────────────────────────> │  writes at offset 0
  │                                │
  │  HTTP POST /api/upload/abc     │
  │  ?utoken=X&offset=1048576       │
  │  [chunk 2 binary]              │
  │ ─────────────────────────────> │  writes at offset 1M
  │       ... (repeat) ...         │
  │                                │
  │  ws: upload-commit             │
  │  {"id":"abc"}                  │
  │ ─────────────────────────────> │  moves temp → target dir
  │                                │
  │  ws: upload-done               │
  │  {"id":"abc","filename":"f.pdf"}│
  │ <────────────────────────────  │
```

**Resume after disconnect:** If the WebSocket drops during upload, the client stores the upload ID and last byte offset in `localStorage`. On reconnect, it queries `upload-status` to find how many bytes the server already has, then resumes chunk uploads from that offset.

**Server restart resilience:** Each upload has two files on disk:

- `<id>.download` — the partial file data
- `<id>.json` — upload metadata (filename, size, received bytes, target directory, expiry)

On startup, the server scans the upload directory for `.json` files and rebuilds its in-memory state. If the client reconnects within the 30-minute expiry window with the same upload ID and matching session token, it can resume. On successful commit, the `.download` file is renamed to the target filename and the `.json` file is deleted. On cancel or GC expiry, both files are removed.

---

### Lifecycle

1. Gateway fetches a challenge from `GET /api/challenge`
2. Gateway signs the nonce with its private key
3. Gateway opens `WS /ws?nonce=...&signature=...`
4. webtermd verifies the signature, spawns a PTY shell
5. Server sends `session` message with an upload token
6. Gateway relays keystrokes and output between browser and webtermd
7. Shell CWD changes are pushed to the client as `cwd` messages
8. On disconnect, the PTY is terminated
