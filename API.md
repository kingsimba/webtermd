# API Reference

ax-term is an edge daemon. Its only client is the Node.js gateway, which holds the private key. End-user authentication (LDAP) happens at the gateway — ax-term does not know or care about users.

## Authentication Model

ax-term reads `~/.ssh/authorized_keys` on each connection attempt. Key changes take effect immediately — no restart needed. The Node.js gateway holds the matching private key. To connect, the gateway proves key possession via challenge-response — the private key never leaves the gateway.

Adding or rotating keys is just `ssh-copy-id` or editing `authorized_keys`. No rebuild needed.

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

The nonce is a base64-encoded random string. It expires after 60 seconds and is single-use.

---

## WebSocket

### WS /ws

Open a PTY session as the ax-term process user.

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

Binary, no framing. Raw bytes flow directly between xterm.js (via the gateway) and the PTY.

| Direction       | Content                        |
| --------------- | ------------------------------ |
| Client → Server | Keystrokes (UTF-8)             |
| Server → Client | Terminal output (ANSI-escaped) |

**Lifecycle**

1. Gateway fetches a challenge from `GET /api/challenge`
2. Gateway signs the nonce with its private key
3. Gateway opens `WS /ws?nonce=...&signature=...`
4. ax-term verifies the signature, spawns a Bash PTY
5. Gateway relays keystrokes and output between browser and ax-term
6. On disconnect, the PTY is terminated
