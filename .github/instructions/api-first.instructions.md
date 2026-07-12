---
description: Update API.md before or alongside any code changes that affect the API surface
applyTo: "**/internal/server/*.go, **/API.md"
---

# API documentation first

When implementing features that change the API surface (new HTTP endpoints, WebSocket control messages, protocol changes), **update [API.md](../../API.md) first or alongside the code** — not as an afterthought.

## What belongs in API.md

- New HTTP endpoints (method, path, query params, request/response schemas)
- New WebSocket control messages (direction, JSON schema, field descriptions)
- Changes to existing message schemas
- Protocol flow changes
- Authentication/auth model changes

## API.md structure

The document is organized as:

1. **Authentication Model** — how auth works at a high level
2. **HTTP** — one subsection per endpoint, each with method, params, response schema, error table
3. **WebSocket** — connection details, binary/text message format, then Client → Server and Server → Client subsections
4. **Protocol Flow** — sequence diagrams in ASCII art
5. **Lifecycle** — end-to-end connection flow

Follow existing conventions: JSON examples in code blocks, parameter tables with `| Field | Description |` format.
