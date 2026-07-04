![Banner](/assets/dandelion_banner.png)

## Introduction

Dandelion is a project aimed at creating a standardized & stable Session Saver for ZOMBS.io.

## Installation
### For MacOS / Linux
Install with one command:
```bash
curl -fsSL https://raw.githubusercontent.com/AyuBloom/Dandelion/main/install.sh | bash
```
If you already have the repository checked out, run the installer from the project root:
```bash
./install.sh
```
Use `./install.sh --verify` to install dependencies, run TypeScript checking, and run the root `tests/` suite.
### For Windows
Currently, a one-liner installer isn't available, stay tuned!

## API
- `POST /create-session` returns `202` with `{ ok: true, sessionId }`.
- `POST /sessions/:id/auth` exchanges a password for a one-time, 60-second token.
- `DELETE /sessions/:id?token=...` gracefully stops a session. Protected sessions require a token.
- `WS /sessions/:id?token=...` attaches a listener. Protected sessions require a token.
