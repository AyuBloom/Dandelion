![Banner](/assets/dandelion_banner.png)

## Introduction

Dandelion is a project aimed at creating a standardized & stable Session Saver for ZOMBS.io.

## Installation

An installation script is coming soon once the project takes shape. Stay tuned!

## API

- `POST /create-session` returns `202` with `{ ok: true, sessionId }`.
- `POST /sessions/:id/auth` exchanges a password for a one-time, 60-second token.
- `DELETE /sessions/:id?token=...` gracefully stops a session. Protected sessions require a token.
- `WS /sessions/:id?token=...` attaches a listener. Protected sessions require a token.

Listener WebSockets accept ZOMBS opcodes `3`, `4`, `7`, and `9`. Opcodes `6` and `10` are discarded without disconnecting the listener.
