# Dandelion User Guide

Dandelion keeps a ZOMBS.io player connected after a normal game tab closes. You
manage saved sessions over HTTP and attach a ZOMBS-compatible client over a
binary WebSocket.

This guide uses `http://127.0.0.1:50000` as the API URL.

## 1. Prerequisites

- [Bun](https://bun.sh/) installed and available as `bun`.
- A ZOMBS.io server id, hostname, and IPv4 address. The id looks like `v1007`,
  the hostname looks like `zombs-2d4ca620-0.eggs.gg`, and the port is always
  `443`.
- Network access to the selected game server on port `443`.
- `curl` for the HTTP examples.

Dandelion does not discover ZOMBS.io servers for you. Get the id, hostname, and
IPv4 address from the server information used by your ZOMBS.io client.

## 2. Install and start Dandelion

Run all commands from the project root. Session child processes use paths that
are relative to this directory.

```bash
cd /path/to/Dandelion
bun install --frozen-lockfile
bun run src/index.ts
```

The API listens on port `50000` by default. To use another port:

```bash
API_PORT=8080 bun run src/index.ts
```

Keep this terminal and the API process running. In another terminal, set a
convenient base URL and confirm the API responds:

```bash
BASE_URL=http://127.0.0.1:50000
curl --fail-with-body --silent --show-error "$BASE_URL/get-sessions"
```

A new installation returns `[]`.

> **Important:** stop active sessions through the API when you are done with
> them. If only the API process is restarted, Dandelion reattaches live detached
> session processes from the local session registry.

## 3. Create a session

Create a public session by replacing the server fields with a real ZOMBS.io
server id, hostname, and IPv4 address:

```bash
curl --fail-with-body --silent --show-error \
  --request POST "$BASE_URL/create-session" \
  --header 'content-type: application/json' \
  --data '{
    "sessionName": "My saved session",
    "id": "v1007",
    "hostname": "zombs-2d4ca620-0.eggs.gg",
    "ipAddress": "45.76.166.32",
    "automations": []
  }'
```

A successful request returns HTTP `202`:

```json
{
  "ok": true,
  "sessionId": "8ec0eabe-7e5b-4bbb-8777-e9d5b2ca81af"
}
```

Save the `sessionId`; all later operations use it.

The request fields are:

| Field | Required | Rules | Purpose |
| --- | --- | --- | --- |
| `sessionName` | Yes | At most 29 characters | The ZOMBS.io display name and session label |
| `id` | Yes | `v` followed by 4 digits | The ZOMBS.io server id |
| `hostname` | Yes | `zombs-[a-z0-9]+-0.eggs.gg` | The hostname used for the WebSocket |
| `ipAddress` | Yes | IPv4 address | The IP address passed into the solver |
| `automations` | Yes | Array | Automation IDs to enable for this session; use `[]` to start with all disabled |
| `psk` | No | Exactly 20 ASCII letters | Automatically joins that party share key after entering the world |
| `password` | No | 8 to 32 characters | Protects attachment, automation management, and deletion |
| `eventPassword` | No | String | Appended to the game server's opcode `4` enter-world request for password-gated events |

For example, a protected session that joins an existing party is created with:

```bash
curl --fail-with-body --silent --show-error \
  --request POST "$BASE_URL/create-session" \
  --header 'content-type: application/json' \
  --data '{
    "sessionName": "Protected saver",
    "id": "v1007",
    "hostname": "zombs-2d4ca620-0.eggs.gg",
    "ipAddress": "45.76.166.32",
    "automations": [],
    "psk": "abcdefghijklmnopqrst",
    "password": "replace-this-password"
  }'
```

### Normal and event starter scripts

Dandelion provides two Tampermonkey userscripts in `client/`:

| Script | Use it for | Enter-world behavior |
| --- | --- | --- |
| [`starter-script.user.js`](client/starter-script.user.js) | Normal ZOMBS.io servers | Sends the standard opcode `4` request without an event password |
| [`event-starter-script.user.js`](client/event-starter-script.user.js) | Password-gated event servers | Adds an **Event password** field and appends its value to opcode `4` with `writeVString` |

The event script otherwise has the same session, host, attachment, and
automation controls as the normal script. Its **Session password** and **Event
password** fields have different purposes:

- **Session password** is optional and protects the saved Dandelion session,
  including attachment, automation management, and deletion. It becomes the
  API's `password` field.
- **Event password** is sent to the selected ZOMBS.io game server only while
  entering the world. It becomes the API's `eventPassword` field and is not
  remembered by the userscript.

Leave **Event password** empty when the selected server does not require it.
Enable only one starter userscript at a time; both scripts install the same
Dandelion overlay and are intended as alternatives.

HTTP `202` means the session process was started. It does not guarantee that the
game server will admit the player. Check the session status next.

## 4. Check session status

List every active session:

```bash
curl --fail-with-body --silent --show-error "$BASE_URL/get-sessions"
```

Filter by an exact server id, hostname, or IPv4 address:

```bash
curl --fail-with-body --silent --show-error \
  "$BASE_URL/get-sessions?server=v1007"
```

An active entry looks like:

```json
{
  "sessionId": "8ec0eabe-7e5b-4bbb-8777-e9d5b2ca81af",
  "durableConnectionId": "214225c1-9891-43d0-bc7e-31f6b0741920",
  "sessionName": "My saved session",
  "createdAt": "2026-06-19T01:00:00.000Z",
  "lastSeenAt": "2026-06-19T01:00:05.000Z",
  "serverId": "v1007",
  "hostname": "zombs-2d4ca620-0.eggs.gg",
  "ipAddress": "45.76.166.32",
  "status": "in-world",
  "ping": 42
}
```

Common status values are:

| Status | Meaning |
| --- | --- |
| `booting` | The session process is starting |
| `connecting` | Connecting to the ZOMBS.io server |
| `waiting-pre-enter` | Waiting for the first entry challenge |
| `waiting-enter-world` | Waiting for the server to admit the player |
| `in-world` | Ready and being kept alive |
| `closing` | Graceful shutdown has started |

Wait for `in-world` before attaching a client. A failed or closed session is
removed from the active list; inspect the Dandelion terminal for the reason.

## 5. Authenticate a protected session

Public sessions do not need authentication. For a password-protected session,
exchange the password for a token:

```bash
SESSION_ID=8ec0eabe-7e5b-4bbb-8777-e9d5b2ca81af

curl --fail-with-body --silent --show-error \
  --request POST "$BASE_URL/sessions/$SESSION_ID/auth" \
  --header 'content-type: application/json' \
  --data '{"password":"replace-this-password"}'
```

The response contains a 64-character token:

```json
{
  "ok": true,
  "token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

A token:

- expires after 60 seconds;
- is consumed by one WebSocket attachment, automation request, or delete request;
- is invalidated when another token is successfully issued for the same
  session.

Request a fresh token for each protected operation. Five failed password
attempts from one client within 60 seconds temporarily produce HTTP `429`.

## 6. Manage session automations

Read the automation catalog and current state for a public session:

```bash
curl --fail-with-body --silent --show-error \
  "$BASE_URL/sessions/$SESSION_ID/automations"
```

Enable AHRC and change one setting while the session is running:

```bash
curl --fail-with-body --silent --show-error \
  --request PATCH "$BASE_URL/sessions/$SESSION_ID/automations/ahrc" \
  --header 'content-type: application/json' \
  --data '{"enabled":true,"settings":{"collect":false}}'
```

Available automations and their default settings are:

- `ahrc`: `collect` and `harvest`, both `true`;
- `autoAim`: `players`, `zombies`, and `npcs`, all `true`;
- `autoBow`: no additional settings.

Every automation starts disabled unless its ID is included in the
`automations` creation field. Settings apply immediately, remain active without
listeners, and are owned by the session process. AHRC reacts to entity updates
and services every Harvester owned by the session player's party. Auto Bow
releases and presses the bow input on every entity update. AutoAim is a
session-owned automation: it aims at the nearest enabled target within 550
world units without firing automatically. Auto Rebuilder captures the current
base when enabled, rebuilds missing structures, and restores their captured
tiers for the lifetime of the session process. Auto Upgrader prioritizes the
Gold Stash before upgrading other structures. AULHT upgrades owned structures
other than the Gold Stash when their health reaches 20% or lower.

Protected sessions require a fresh one-time token in `?token=...` for every GET
or PATCH request.

## 7. Attach a game client

The listener address for a public session is:

```text
ws://127.0.0.1:50000/sessions/<sessionId>
```

For a protected session, request a fresh token and include it once:

```text
ws://127.0.0.1:50000/sessions/<sessionId>?token=<token>
```

This is a binary ZOMBS protocol endpoint, not a web page or JSON WebSocket API.
A normal browser tab cannot render the saved game. A compatible client must:

1. Open the WebSocket and use `arraybuffer` binary messages.
2. Send a binary `PACKET_ENTER_WORLD` frame (opcode `4`) to request a snapshot.
3. Decode the returned enter-world packet, cached RPC state, entity snapshot,
   and subsequent live game packets with a ZOMBS-compatible codec.
4. Send normal binary input, ping, and RPC packets when controlling the session.

You can perform a connection-only smoke test from the project root. Replace the
session ID and add `?token=...` when testing a protected session:

```bash
bun -e '
const ws = new WebSocket(
  "ws://127.0.0.1:50000/sessions/8ec0eabe-7e5b-4bbb-8777-e9d5b2ca81af",
);
ws.binaryType = "arraybuffer";
ws.onopen = () => {
  console.log("connected; requesting snapshot");
  ws.send(Uint8Array.of(4));
};
ws.onmessage = ({ data }) => {
  const bytes = new Uint8Array(data);
  console.log("received opcode", bytes[0], "bytes", bytes.byteLength);
};
ws.onclose = ({ code }) => console.log("closed", code);
'
```

Press `Ctrl-C` to stop this smoke-test client. That does not stop the saved
session.

Listener packet rules:

| Opcode | Packet | Behavior |
| --- | --- | --- |
| `3` | Input | Accepted after snapshot sync; validated and forwarded immediately |
| `4` | Enter world | Requests the initial snapshot once |
| `7` | Ping | Replied to by Dandelion |
| `9` | RPC | Accepted after snapshot sync, up to 256 bytes |
| `6`, `10` | Entry/blend compatibility packets | Ignored without disconnecting |
| Any other opcode | Unsupported | Listener is closed with code `1008` |

Send binary frames only. Text frames are closed with code `1003`, and listener
frames larger than 1024 bytes are rejected. The 256-byte RPC limit mirrors the
ZOMBS.io disconnection constraint documented by the
[zombs.io Wiki](https://ayubloom.github.io/zombsWiki/gameplay/scripts/fundamentals/dc_triggers.html).

Multiple listeners may watch and control the same public session. Valid input
and RPC packets from every live listener are forwarded immediately.

## 8. Stop a session safely

Stop a public session:

```bash
curl --fail-with-body --silent --show-error \
  --request DELETE "$BASE_URL/sessions/$SESSION_ID"
```

For a protected session, request a new token and use it in the delete request:

```bash
TOKEN=replace-with-a-fresh-token

curl --fail-with-body --silent --show-error \
  --request DELETE "$BASE_URL/sessions/$SESSION_ID?token=$TOKEN"
```

A successful request returns HTTP `202` with `{"ok":true}`. This means the
graceful stop signal was accepted. Confirm the session disappears from
`GET /get-sessions` before stopping the Dandelion API.

Do not delete files from `.sessions/`, `.session-auth/`, or
`.session-control/` to stop a session. Those directories contain internal
health, password-hash, and local reattachment state; use the API to stop
sessions.

## Troubleshooting

- **`Invalid server`:** pass a valid `id`, `hostname`, and `ipAddress`.
- **Session disappears while starting:** the game server rejected or lost the
  connection. Check the API terminal; a full server is one possible cause.
- **WebSocket closes with `1008` immediately:** the session ID is inactive, the
  token is missing/invalid/expired, or an unsupported opcode was sent.
- **WebSocket closes with `1003`:** the client sent a text frame instead of a
  binary frame.
- **Connected but no world state:** send opcode `4` once and wait until the
  session itself reports `in-world`.
- **Protected delete returns `401`:** obtain a fresh token. A token used to open
  a WebSocket cannot be reused to delete the session.
- **Auth returns `404`:** the session is not active or it was not created with a
  password.

For protocol details, see the zombs.io Wiki pages for the
[network packet flow](https://ayubloom.github.io/zombsWiki/architecture/engine/main/network/network.html)
and [binary codec](https://ayubloom.github.io/zombsWiki/architecture/engine/main/network/BinCodec.html).
