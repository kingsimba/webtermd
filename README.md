# webtermd

> A lightweight edge daemon that brings your terminal to the browser — with an integrated file manager, SSH authentication, and zero-dependency deployment.

<div align="center">

[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?logo=go)](https://go.dev)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

## Quick Start

```bash
# Download the binary (Linux amd64)
curl -LO https://github.com/kingsimba/webtermd/releases/latest/download/webtermd
chmod +x webtermd

# Run in no-auth mode — open http://localhost:8080 and you're in
./webtermd -no-auth
```

> **That's it.** No config files, no dependencies, no setup. Your terminal is live in the browser.

## Architecture

```
[Browser] ← WebSocket → [webtermd] → [PTY shell]
                │                        │
                │  SSH challenge-auth    │  runs as system user
                │  (authorized_keys)     │
```

webtermd runs as a specific Linux user (e.g. via systemd `User=`). It reads that user's `~/.ssh/authorized_keys` and only accepts connections from a client holding the matching private key. Once authenticated, a PTY session is spawned and I/O is relayed over WebSocket.

## Features

### Terminal

- **Full terminal emulation** — built on xterm.js with ANSI color, tab completion, and window resize support
- **Native copy & paste** — `Ctrl+C` and `Ctrl+V` work naturally, no need for `Ctrl+Shift+C` / `Ctrl+Shift+V`
- **Real interactive shell** — PTY-backed sessions support `cd`, `vim`, and other stateful commands
- **Single static binary** — cross-compiles to a self-contained binary for amd64 or arm64 with minimal footprint

### File Manager

- **Live directory sync** — the file list on the right mirrors the terminal's current working directory in real time
- **Folder navigation** — double-click any folder to step into it, or click the parent (`..`) entry to go back
- **Instant preview** — click any file to preview its contents directly in the browser
- **One-click download** — click the download button to save any file to your local machine
- **Drag-and-drop upload** — drag files from your desktop onto the terminal to upload them into the current working directory

### Security

- **SSH key authentication** — reads `~/.ssh/authorized_keys` of the runtime user; no keys baked into the binary
- **Ed25519, ECDSA & RSA** support for modern and legacy key types

## Tech Stack

| Component | Technology                                  |
| --------- | ------------------------------------------- |
| Frontend  | xterm.js + xterm-addon-fit                  |
| Backend   | Go                                          |
| PTY       | [creack/pty](https://github.com/creack/pty) |

## Authentication

webtermd uses SSH challenge-response to authenticate clients before granting terminal access.

1. Client fetches a challenge nonce from `GET /api/challenge`
2. Client signs the nonce with its private key
3. Client opens a WebSocket to `/ws?nonce=...&signature=...`
4. webtermd reads `authorized_keys` and verifies the signature (keys are read per-connection, so changes take effect immediately)
5. On success, a PTY shell is spawned as that user

## WebSocket Communication

- Browser keystrokes are sent to webtermd over WebSocket
- webtermd writes input bytes into the PTY and reads output asynchronously
- PTY output is pushed back to the browser over the same WebSocket
- No framing — raw bytes pass directly between xterm.js and the PTY

## Usage

```
./bin/webtermd [-addr <address>] [-shell <path>] [-static <dir>] [-no-auth]
```

| Flag       | Default       | Description                                     |
| ---------- | ------------- | ----------------------------------------------- |
| `-addr`    | `:8080`       | Listen address (e.g. `:3000`, `127.0.0.1:9090`) |
| `-shell`   | `bash`        | Shell to spawn PTY sessions with                |
| `-no-auth` | `false`       | Disable challenge-response authentication       |
| `-static`  | auto-detected | Path to static files directory                  |

### Examples

```bash
# Default port 8080, bash shell
./bin/webtermd

# Custom port
./bin/webtermd -addr :3000

# ZSH shell on localhost
./bin/webtermd -addr 127.0.0.1:9090 -shell zsh
```

## Development

### Build

```bash
./dev build            # native build (local testing)
./dev build --arm64    # cross-compile for ARM64 deployment
./dev test             # run tests
./dev test -v          # run tests with verbose output
```

## Deployment

1. Create a dedicated system user (e.g. `robot`) and add your public key to `~/.ssh/authorized_keys`
2. Upload the binary and frontend static files
3. Make the binary executable: `chmod +x webtermd`
4. Install as a systemd service with `User=robot` for auto-restart
5. Start the service: `systemctl start webtermd`

## Integrations

webtermd is a self-contained building block. It can be layered with other tools for more complex setups:

- **Reverse proxy** — place webtermd behind nginx or Caddy for TLS termination and path-based routing
- **Tunneling** — pair with FRP, Cloudflare Tunnel, or ngrok to expose devices behind NAT
- **Auth gateway** — front webtermd with a proxy that handles OAuth, LDAP, or SSO before forwarding WebSocket traffic
- **Multi-instance** — run one webtermd per user or per device, with a central router directing connections
