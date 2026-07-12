# Web Terminal (ax-term)

A lightweight edge daemon that exposes a PTY terminal over WebSocket. Paired with a Node.js gateway for user management, it provides browser-based terminal access to remote devices behind NAT.

## Architecture

```
[Browser] → [Node.js Gateway] → [FRP Tunnel] → [ax-term] → [PTY/Bash]
   │              │                                     │
   │   LDAP auth  │  private key                        │  authorized_keys
   │              │  (pre-provisioned)                  │  (of runtime user)
```

- **ax-term** (this project) — runs as a specific Linux user (e.g. via systemd `User=`). Reads that user's `~/.ssh/authorized_keys`. Only a client with a matching private key can open a PTY session.
- **Node.js Gateway** — holds the private key. Handles LDAP user authentication and proxies browser traffic to the correct ax-term instance via FRP.
- **FRP** — configured so each robot only accepts connections from the Node.js gateway IP.

## Key Features

- **Full terminal emulation** — built on xterm.js with ANSI color, tab completion, and window resize support
- **SSH key authentication** — reads `~/.ssh/authorized_keys` of the runtime user; no keys baked into the binary
- **Single static binary** — cross-compiles to a self-contained binary for amd64 (testing) or arm64 (robots) with minimal footprint
- **Real interactive shell** — PTY-backed Bash sessions support `cd`, `vim`, and other stateful commands

## Tech Stack

| Component | Technology                                  |
| --------- | ------------------------------------------- |
| Frontend  | xterm.js + xterm-addon-fit                  |
| Backend   | Go                                          |
| PTY       | [creack/pty](https://github.com/creack/pty) |

## Authentication

ax-term only authenticates the Node.js gateway — not end users. User management (LDAP) is handled entirely by the gateway.

1. Node.js gateway fetches a challenge nonce from `GET /api/challenge`
2. Gateway signs the nonce with its private key
3. Gateway opens a WebSocket to `/ws?nonce=...&signature=...`
4. ax-term reads `authorized_keys` and verifies the signature (keys are read per-connection, so changes take effect immediately)
5. On success, a Bash PTY is spawned as that user

## WebSocket Communication

- Browser keystrokes are relayed by the Node.js gateway to ax-term over WebSocket
- ax-term writes input bytes into the PTY and reads output asynchronously
- PTY output is pushed back to the gateway, which forwards it to the browser
- No framing — raw bytes pass directly between xterm.js and the PTY

## Development

### Build

```bash
./dev build            # native build (local testing)
./dev build --arm64    # cross-compile for ARM64 deployment
./dev test             # run tests
./dev test -v          # run tests with verbose output
```

## Deployment

1. Create a dedicated system user (e.g. `robot`) and add the gateway's public key to `~/.ssh/authorized_keys`
2. Upload the binary and frontend static files
3. Make the binary executable: `chmod +x web-terminal-server`
4. Install as a systemd service with `User=robot` for auto-restart
5. Start the service: `systemctl start ax-term`
