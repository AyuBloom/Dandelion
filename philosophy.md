# Philosophy of Dandelion

![Top-down overview](/assets/diagram.png)

## The `unsafe` layer
Every component inside this layer does not intercept packets safely. Packets are simply throttled and forwarded without checks.

### `engine`

`engine` is the public-facing block of the session saver. Publicly, it handles API REST calls for session metadata (health, creation, deletion) using Elysia and listeners via Bun WebSockets. Internally, it is responsible for managing communication between sessions and their listeners. 
- Packets sent from listeners are throttled and forwarded to the session through this block. Password verification also happens here.
- Packet broadcasting is handled here with a WebSocket server.

#### Links
- `engine` -> `session`: IPC
- `session` -> `listener`: WebSocket / REST

## The `guarded` layer
Contrary to the `unsafe` layer, packets exchanged in this layer are sanitized for safe handling. The sanitization happens between the `guarded` and `unsafe` layers (session <-> engine).

### `session`

`session` holds all states for each connection (chat messages, party data, buildings, etc...). As the component between `engine` and `durable connection`, it also filters out possible harmful packets that may disconnect the connection, while also forwarding important packets to the engine for broadcasting.

#### Links
- `session` -> `engine`: IPC
- `session` -> `durable connection`: IPC