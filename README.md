![Banner](/assets/dandelion_banner.png)

## Introduction

Dandelion is a project aimed at creating a standardized & stable Session Saver for ZOMBS.io.

## Installation
### For macOS / Linux
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
Install with one command from PowerShell:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/AyuBloom/Dandelion/main/install.ps1 | iex"
```
If you already have the repository checked out, run the installer from the project root:
```powershell
.\install.ps1
```
Use `.\install.ps1 -Verify` to install dependencies, run TypeScript checking, and run the root `tests/` suite.

## API
- `POST /create-session` returns `202` with `{ ok: true, sessionId }`.
- `POST /sessions/:id/auth` exchanges a password for a one-time, 60-second token.
- `GET /sessions/:id/automations?token=...` reads per-session automation state.
- `PATCH /sessions/:id/automations/:automationId?token=...` updates it in flight.
- `DELETE /sessions/:id?token=...` gracefully stops a session. Protected sessions require a token.
- `WS /sessions/:id?token=...` attaches a listener. Protected sessions require a token.
