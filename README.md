# websocket-relay

A relay speaking **MQTT with JSON-RPC 2.0 payloads**: the **Comms Shim**.

- **Servers (localhostServer, Remote Server):** Go, each embedding an
  MQTT broker ([mochi-mqtt/server](https://github.com/mochi-mqtt/server))
- **Client:** a drop-in vanilla-JS snippet for any web page, using
  [MQTT.js](https://github.com/mqttjs/MQTT.js) over WebSocket
- **GUI:** served by localhostServer on a random port (see How to run)

All communication is MQTT (QoS 0) carrying JSON-RPC 2.0: commands
(request/response, correlated by the JSON-RPC `id`) and chat
(notifications). See Protocol for the topic conventions.

Version control: git, hosted on GitHub — canonical repo
`scirelli/websocket-relay`; see `.agents/WORKFLOW.md`.

## Terminology

The names we use for the parts of this system:

- **Comms Shim** — the whole system: MQTT brokers running on the
  user's machines plus a GUI and client snippet, letting a web page
  talk to services on those machines. ("Shim" because it's a thin
  layer dropped between the browser page and the local machine.)
- **localhostServer** — the broker on the user's own machine
  (`src/server/`). It embeds an MQTT broker, answers JSON-RPC
  commands addressed to it, serves the browser assets (Relay Tool,
  MQTT.js), hosts the GUI, and bridges to the Remote Server.
- **Remote Server** — a second broker (`src/remoteserver/`) running
  on another machine. It answers its own JSON-RPC commands and is
  chat user `remote`: an operator-staffed test endpoint whose
  console receives chat messages and replies to them.
- **Bridge** — the link localhostServer initiates to the Remote
  Server's broker: chat messages and commands for the remote
  target are republished there, and replies flow back.
- **Client snippet** — the drop-in JavaScript (`src/client/snippet.js`)
  pasted into a web page or the browser developer console. It is a
  *loader*: it loads MQTT.js, connects the page to localhostServer's
  broker, and loads the Relay Tool. The GUI hands it out minified
  (Closure Compiler; see the Relay Tool section).
- **Relay Tool** — the versioned web-components app the snippet loads
  from localhostServer (`GET /relay-tool.js`). A floating window on
  the host page: a function list on the left, the selected
  function's panel on the right.
- **GUI** — localhostServer's web GUI, reachable at
  `http://localhost:<random port>`. The port is random (chosen at
  startup) and the full link is displayed on the command line when
  the server runs. For now the GUI is one simple page — "here's the
  code snippet to drop in your developer console", with the snippet
  code — and will eventually become a web app built with vanilla
  JS, CSS, HTML and standard web components.

## How to run

### Prerequisites

- The toolchains pinned in `mise.toml`. With
  [mise](https://mise.jdx.dev): run `mise install` in the repo root —
  it installs Go (currently 1.27.4) plus the build-time-only tools
  (Node, Java, Closure Compiler) used to compile the client snippet.
  Without mise, install Go 1.27 or newer from go.dev; the compiled
  snippet is committed, so Go alone is enough unless you edit
  `src/client/snippet.js`. (Older Go versions, e.g. 1.22, produce
  binaries current macOS refuses to run: `dyld: missing LC_UUID`.)
- A clone of this repo

### Build and run localhostServer

The Go module lives in `src/`; all build artifacts go to `build/`.
The Makefile at the repo root wraps both modes (`make help` lists
every target with its description):

```sh
# Debugging — race detector on, optimizations off
make run            # build in memory and run
make build          # or just build: build/debug/ (server + remote-server)

# Production — static (CGO off), trimmed and stripped
make build-release  # build/release/ (server + remote-server)
make run-release    # build it and run it

# localhostServer options (pass to the binary, or after `go run`):
#   -host 127.0.0.1        bind host for the broker, assets and GUI
#   -port 8765             HTTP asset port (/health, /relay-tool.js, /mqtt.min.js)
#   -mqtt-tcp 1883         MQTT broker port (TCP)
#   -mqtt-ws 8083          MQTT broker port (WebSocket)
#   -remote-host ""        Remote Server host — turns the bridge on
#   -remote-mqtt-port 1883 Remote Server MQTT TCP port
./build/release/websocket-relay -remote-host 192.0.2.10
```

Without make, the plain Go commands work from inside `src/`
(e.g. `go run ./server`). `make clean` empties `build/`.

Startup prints the addresses — the GUI port is **random**, chosen
fresh on every run:

```
Comms Shim — localhostServer
  MQTT broker: tcp 127.0.0.1:1883, ws 127.0.0.1:8083
  Assets: http://127.0.0.1:8765 (/relay-tool.js, /mqtt.min.js)
  GUI: http://127.0.0.1:51234        <- example; your port will differ
  Bridge to Remote Server: on -> tcp://192.0.2.10:1883
  methods (target localhost): [echo functions.list ping]
```

Leave it running; Ctrl+C stops it. The bridge connects in the
background and retries until the Remote Server is reachable, so
the two servers can start in any order.

### Use the GUI

1. Open the printed GUI link in a browser on the same machine.
2. The page shows the client snippet (minified) with localhostServer's
   real broker address already filled in. Click **Copy snippet**.
3. On any web page, open the developer console (F12 / Cmd+Option+J)
   and paste. The snippet loads MQTT.js (CDN first, localhostServer's
   vendored copy as fallback), connects, and loads the Relay Tool —
   its window appears on the page. Pick **Echo** or **Chat**. From
   the console, `await wsEcho('hello')` also works.

There is also a demo page, `src/client/demo.html` — open it in a
browser on the same machine while the server runs; it loads the
snippet the same way a console paste does and the Relay Tool
appears.

### Run the Remote Server (for Chat and remote commands)

```sh
make run-remote     # or: ./build/release/remote-server [-port 1883] [-ws-port 8083] [-console <file>]
```

It embeds a broker listening on all interfaces (TCP 1883,
WebSocket 8083), answers commands addressed to target `remote`,
and is chat user `remote`: chat messages addressed to it are
logged, and lines typed on its console are sent back to whoever
wrote last. Run detached, it can take its console from a FIFO
instead: `remote-server -console /tmp/rs-in`, then
`printf 'hello\n' > /tmp/rs-in` sends a line.

For the bridge, start localhostServer with
`-remote-host <Remote Server host>` — or use the make target,
which takes the Remote Server's IP or domain name (and an
optional non-default MQTT port):

```sh
make run-bridge REMOTE_HOST=192.0.2.10              # debug build, via go run
make run-bridge REMOTE_HOST=192.0.2.10 REMOTE_PORT=1883
```

localhostServer binds to loopback (127.0.0.1) by default. To
expose its broker, asset server, and GUI on all interfaces
instead, pass HOST to any run target:

```sh
make run-bridge REMOTE_HOST=192.0.2.10 HOST=0.0.0.0
```

The snippet the GUI hands out must name a host clients can
connect to, so it is never stamped with 0.0.0.0: with
HOST=0.0.0.0 it carries the address the browser used to load
the GUI. To stamp a specific address instead — a LAN IP or a
hostname — pass PUBLIC_HOST as well:

```sh
make run-bridge REMOTE_HOST=192.0.2.10 HOST=0.0.0.0 PUBLIC_HOST=192.0.2.20
```

In the Relay Tool's Chat
panel, the Broker field defaults to localhostServer's broker —
chat then flows over the bridge. The field also accepts the
Remote Server's broker directly (`ws://<host>:8083`): WebSocket
connections are not same-origin bound, so the panel can talk to
either broker.

Known limitation: from an `https` page, a plain `ws://` connection
to a LAN address is blocked as mixed content (loopback addresses
are exempt). Use an `http` page, the demo page, or a loopback
broker address for now; `wss` is future work.

### Run the tests

```sh
make test           # or: cd src && go test ./...
```

Unit tests cover the JSON-RPC dispatcher directly; integration
tests start real brokers and exercise RPC-over-MQTT, the bridge,
the asset routes, and the GUI page. No server needs to be running
first — the tests start their own.

For your own page, the snippet does everything on paste; its API
after loading (see `src/client/snippet.js`):

```js
CommsShim.rpc            // the shared MqttRpc connection
await wsEcho('hello');   // -> "hello"
const rpc = new MqttRpc('ws://127.0.0.1:8083', 'my-client-id');
await rpc.connect();
await rpc.call('echo', 'hello');          // target 'localhost'
await rpc.call('echo', 'hello', 'remote'); // answered by the Remote Server
```

## The Relay Tool

The Relay Tool is a small web-components app served by
localhostServer at `GET /relay-tool.js` (HTTP asset port),
versioned (`X-Relay-Tool-Version` header; the version also shows
in the tool's header). The client snippet — itself just a loader —
fetches and evaluates it; the loader is infrastructure and is not
one of the tool's functions.

Tag names are **version-suffixed** (`relay-tool-v0-7-0`, …): a
custom element name can only be defined once per page, so
versioning the names lets different versions coexist on one page
without colliding. Core tags use the core's version; function
panels use their own function's version, so functions version
independently of the core. The GUI stamps the expected core
version into the snippet it serves (same serve-time rewrite as
the addresses). There is no retry/increment machinery: refresh
the page for a clean slate.

The core ships with **no functions**. A menu bar under the header
holds a **File** menu; its **Settings** item opens a Settings
view that takes over the whole tool body (the function list
hides too) until its × closes it, laid out like an IDE settings
page — a section list on the left, the selected section's
settings on the right. The **Functions** section lists the
functions localhostServer offers. Checking a function adds it to
the function list — grayed out while it loads, live once loaded;
unchecking removes it. The enabled set persists in the host
page's `localStorage` and is restored on the next load.

Switching between functions hides the previous panel rather than
destroying it, so a function's state — a chat connection, a log —
survives switching away and back. Disabling a function destroys
its panel.

How the catalog works: the tool asks localhostServer for the
function list over JSON-RPC (`functions.list`, see Protocol) and
gets metadata per function — `id`, `name`, `version`,
`description`, `script` URL, and `dependencies` (each a
`{type, url}` entry, `script` or `style`). On enable, the loader
fetches the dependencies in declared order, then the function
script; the script defines its panel component and registers it
with the core via `window.RelayTool.registerFunction`. The
loader memoizes by URL, so a dependency shared by several
functions loads once per page; repeat loads across pages are the
HTTP cache's job. There is no separate dependency manager.

Core components (all vanilla custom elements; communication via
custom elements, `data-` attributes, and CustomEvents; animations
in CSS):

- `<relay-tool>` — the floating window: drag by the header,
  resize by the corner (CSS `resize`), close with ×, plus the
  menu bar (File → Settings).
- `<relay-function-list>` — left panel listing the *enabled*
  functions from core state; entries carry a `data-state`
  (`loading` grayed and inert, `error` red, `ready` clickable).
  Clicking a ready entry fires `relay-function-select`.
- `<relay-settings-panel>` — the Settings view: a section list
  (Functions today) and the selected section's settings; the
  Functions section is one checkbox row per catalog function.

Functions (served at `GET /functions/<id>.js`, cataloged in
`src/server/functions.go`):

- **Echo** (`relay-echo-panel`) — text field, a target selector
  (`localhost` / `remote`), Send button, readonly log.
- **Chat** (`relay-chat-panel`) — a broker row (broker URL input,
  connect button, red/yellow/green status light), a "You are /
  Chat with" row naming the two chat users, an IRC-style message
  log, and a message composer. The panel owns its own broker
  connection, independent of the shared one.
- **Inbox** (`relay-inbox-panel`) — one inbox for everything
  that arrives for the user to review and allow or deny, on a
  single broker connection. Two kinds of item share the list:
  delivered scripts and **Read Page** requests. Scripts arrive
  as `script.deliver` notifications on `scripts/<username>`;
  the list shows each item's state (scripts: unread, read,
  run, denied — crossed out; page requests: new, sent,
  denied), and the detail pane shows a script's name, sender,
  description, and full source, or what a page request will
  send. **Accept** executes a script on the page (once) or
  answers a page request; **Deny** refuses it. Both channels
  are QoS 0: if the function is not enabled and connected, an
  item is lost. The panel also hooks the page's console
  (`log`/`info`/`warn`/`error`, `window.onerror`, unhandled
  promise rejections) into a local buffer, deduplicated by
  fingerprint (level + text + source) with repeat counts, so a
  broken page cannot flood it. Nothing leaves the page on its
  own: a page snapshot is sent only when a request arrives
  (`assistant.snapshot` on `assistant/<username>/request`)
  **and the user Accepts it in the panel** — the panel then
  answers on `assistant/<username>/snapshot` with the page URL
  and title, screen/viewport metrics, the full DOM (chunked),
  and the console buffer. A **Stream console** checkbox at the
  top of the panel instead sends each new distinct entry live
  on `assistant/<username>/console`. The Remote Server
  collects snapshots to a JSON file (`-assistant-file`) and
  streamed entries to a log (`-assistant-log`), so the operator
  side can answer questions about the page. Denying a page
  request sends a one-line `denied` notice instead, so a
  refusal is not mistaken for a lost message. The request
  channel takes snapshot requests only — no eval.

Adding a function = one script in `src/client/functions/` plus
one entry in the server catalog — no snippet or core redeploy,
the same Registry pattern as the server's method Dispatcher.

**Snippet compilation:** the GUI hands out the snippet compiled by
Google Closure Compiler (`src/client/snippet.min.js`, committed).
`make` recompiles it when `snippet.js` changes, via the mise task
`build-snippet`; if the compiler isn't installed at that point,
make stops and asks you to run `mise install`.

## Protocol

MQTT (QoS 0) carrying JSON-RPC 2.0 payloads. Chat messages are not
retained: a client that isn't connected misses them.

Topics:

| Topic | Direction | Payload |
|---|---|---|
| `shim/rpc/<target>/<clientId>` | client → server | JSON-RPC request or notification; `<target>` is `localhost` or `remote` |
| `shim/clients/<clientId>/rpc` | server → client | JSON-RPC response |
| `chat/<username>` | anyone → that user | `chat.message` notification |
| `scripts/<username>` | anyone → that user | `script.deliver` notification |
| `assistant/<username>/request` | operator → Inbox | `assistant.snapshot` notification |
| `assistant/<username>/snapshot` | Inbox → operator | snapshot sequence: `begin` (metadata), `dom` chunks, `console`, `end` — or a `denied` notice |
| `assistant/<username>/console` | Inbox → operator | one streamed console entry (JSON) |

Request:
```json
{"jsonrpc": "2.0", "method": "echo", "params": "hello", "id": 1}
```
Success response:
```json
{"jsonrpc": "2.0", "result": "hello", "id": 1}
```
Error response (e.g. unknown method):
```json
{"jsonrpc": "2.0", "error": {"code": -32601, "message": "Method not found: …"}, "id": 1}
```
Chat message (a notification — no `id`, no response):
```json
{"jsonrpc": "2.0", "method": "chat.message", "params": {"from": "steve", "text": "hi"}}
```
Script delivery (also a notification):
```json
{"jsonrpc": "2.0", "method": "script.deliver", "params": {"from": "muse", "name": "Puppy", "description": "Centers a puppy photo", "script": "…"}}
```

Methods (via their target):

| Method | Params | Result |
|---|---|---|
| `echo` | anything | params, verbatim |
| `ping` | — | `"pong"` |
| `functions.list` | — | the function catalog (localhostServer only) |

`functions.list` returns an array of function metadata objects:

```json
[{"id": "echo", "name": "Echo", "version": "1.0.0",
  "description": "Send a message, get it echoed back",
  "script": "/functions/echo.js", "dependencies": []}]
```

Notifications get no response, per spec. Batch requests are
supported. The bridge forwards `chat/<user>`, `scripts/<user>`,
`assistant/<user>/…` and `shim/rpc/remote/<clientId>` from
localhostServer's broker to the Remote Server's, and `chat/+`,
`scripts/+`, `assistant/#` and `shim/clients/+/rpc` back; it
never re-forwards messages the broker injected itself, which
keeps it loop-free.

## Talking to pages from your own program

Everything a page can receive arrives as an MQTT message on
one of the topics under Protocol, and everything it sends
leaves the same way. A program that wants to talk to pages —
an operator console, a test harness, a server of your own —
only needs an MQTT client connected to a broker the pages
use. It does not need to be written in Go or use this repo's
packages.

### Joining a broker

Connect as an ordinary MQTT client (QoS 0 throughout):

- **TCP** (`tcp://<host>:1883`) for native programs, or
  **WebSocket** (`ws://<host>:8083`) from browser code.
- The embedded brokers have **no authentication**. Run them
  on networks you trust (a LAN, a tailnet); do not
  port-forward them to the internet.
- Pick any unique client ID. There is no registry of users:
  a "username" is just the last topic segment, chosen by the
  user in the Relay Tool panels (default `steve`) and by you
  in the `from` field of what you send.

Which broker? Pages connect to localhostServer's broker (the
snippet is stamped with its address). A program on another
machine usually connects to the Remote Server's broker
instead; the bridge carries `chat/+`, `scripts/+`,
`assistant/#` and the RPC replies between the two brokers,
so a message published to either one reaches the pages.
Start localhostServer with `-remote-host` to turn the bridge
on (see How to run).

### Answering commands from pages

Pages call JSON-RPC methods on a *target* (`localhost` or
`remote`). To provide a target yourself:

1. Subscribe to `shim/rpc/<target>/+`. The topic's last
   segment is the caller's client ID.
2. Parse the payload as a JSON-RPC request; dispatch on
   `method`.
3. Publish the response — same `id` — to
   `shim/clients/<clientId>/rpc`.

The two servers in this repo do exactly this (the `jsonrpc`
package is the dispatcher; `mqttx` wires it to a broker), and
their method set is the table under Protocol. A program in
any language with an MQTT client can implement the same
pattern.

### Sending to a page

Pages take no generic RPC calls; you reach them through
three notification channels. All are fire-and-forget
(QoS 0): if the user's function is not enabled and connected
at that moment, the message is gone.

**Chat.** Publish a `chat.message` notification to
`chat/<username>` (payload under Protocol). Subscribe to
`chat/<your-name>` to receive. The Chat function and the
Remote Server (chat user `remote`) both work this way.

**Deliver a script.** Publish a `script.deliver` notification
to `scripts/<username>` (payload under Protocol). The script
lands in the user's Inbox; nothing runs until the user
reviews it and clicks Accept, which executes it on the page
once.

**Ask for a page snapshot.** Subscribe to
`assistant/<username>/snapshot` *before* asking, then publish
an `assistant.snapshot` notification to
`assistant/<username>/request`:

```json
{"jsonrpc": "2.0", "method": "assistant.snapshot", "params": {"id": "req-1", "from": "operator"}}
```

If the user Accepts the request in the Inbox, the answer is
a sequence of messages on the snapshot topic, all carrying
your `id`: `begin` (page metadata), `dom` chunks
(`seq`/`total`, in order), `console` (the console buffer),
`end`. If the user denies it, the answer is a single
`{"id": "req-1", "kind": "denied"}`. If the user has
**Stream console** on in the Inbox, new console entries also
arrive live, one per message, on
`assistant/<username>/console`. The Remote Server's
collector (`src/remoteserver/assistant.go`) is a working
reference: it reassembles snapshots to a JSON file and
appends streamed entries to a log.

### Example

A minimal operator program in Go, using the same MQTT
client library as the bridge
(`github.com/eclipse/paho.mqtt.golang`). It connects to a
broker, subscribes for snapshot answers, then sends a chat
message and a snapshot request:

```go
package main

import (
	"fmt"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"
)

func main() {
	opts := paho.NewClientOptions().
		AddBroker("tcp://127.0.0.1:1883").
		SetClientID("operator-example")
	client := paho.NewClient(opts)
	if tok := client.Connect(); tok.Wait() && tok.Error() != nil {
		panic(tok.Error())
	}

	// Subscribe before asking: QoS 0 messages are not stored.
	client.Subscribe("assistant/steve/snapshot", 0,
		func(_ paho.Client, msg paho.Message) {
			fmt.Printf("snapshot: %s\n", msg.Payload())
		})

	pub := func(topic, payload string) {
		tok := client.Publish(topic, 0, false, payload)
		tok.Wait()
	}
	pub("chat/steve",
		`{"jsonrpc":"2.0","method":"chat.message","params":{"from":"operator","text":"hello"}}`)
	pub("assistant/steve/request",
		`{"jsonrpc":"2.0","method":"assistant.snapshot","params":{"id":"req-1","from":"operator"}}`)

	time.Sleep(10 * time.Second) // give the user time to Accept
	client.Disconnect(250)
}
```

The same program in another language is a translation
exercise: connect, subscribe, publish the JSON above.

## Layout

```
Makefile        — build/run/test entry points (debug + production); `make help` documents them
mise.toml       — pinned tools (Go; Node/Java/Closure for the snippet build) + mise tasks
src/            — the Go module
  go.mod, go.sum
  assets.go     — module-root package embedding the client files
  jsonrpc/      — JSON-RPC 2.0 Dispatcher (Strategy registry) + echo/ping
  mqttx/        — MQTT wiring: embedded broker factory, RPC responder, chat helpers, topic conventions
  server/
    main.go       — entry point: broker, asset mux, GUI, startup banner
    bridge.go     — bridge to the Remote Server's broker (hook + uplink client)
    gui.go        — GUI listener (random port) + snippet page
    relaytool.go  — serves the Relay Tool at /relay-tool.js (versioned)
    functions.go  — the function catalog: functions.list RPC + /functions/<id>.js
    server_test.go — broker/RPC/bridge/assets/GUI integration tests
  remoteserver/
    main.go       — the Remote Server: broker + RPC responder + chat user "remote" + operator console
    assistant.go  — snapshot collector: reassembles snapshots to -assistant-file, streams console entries to -assistant-log
  client/
    snippet.js      — the loader snippet (source): MqttRpc + CommsShim loader
    snippet.min.js  — snippet compiled by Closure Compiler (committed; rebuilt by make)
    relay-tool.js   — the Relay Tool core (menu bar, function list, Settings view, loader)
    functions/      — loadable function scripts, one per function (echo.js, chat.js, inbox.js)
    mqtt.min.js     — vendored MQTT.js browser build (fallback for the CDN copy)
    demo.html       — demo page: loads the snippet like a console paste
build/          — build artifacts and executables (generated, gitignored)
  debug/          make build
  release/        make build-release
```

Dependencies: the brokers and bridge use
`github.com/mochi-mqtt/server/v2` and
`github.com/eclipse/paho.mqtt.golang`; tests use
`github.com/stretchr/testify`. The browser client is MQTT.js
(vendored, MIT licensed).

Design notes: the Dispatcher is transport-independent — the same
registry answers commands on either server. Adding a method is one
`Register(name, handler)` call. Dispatch is O(1) per method
lookup, O(n) in message size; pending-call lookup in the client
is O(1).

## Roadmap

- [x] Echo over JSON-RPC 2.0
- [x] GUI on a random port (link printed at startup); page shows the
      client snippet to drop into the dev console
- [x] Snippet compiled with Closure Compiler (mise task); GUI hands
      out the minified form
- [x] Relay Tool (versioned): web-components window served by
      localhostServer, loaded by the snippet; Echo panel
- [x] Chat function with an operator-staffed Remote Server
- [x] MQTT migration: all comms are MQTT + JSON-RPC 2.0; both
      servers embed brokers; localhostServer bridges to the
      Remote Server
- [ ] GUI grows into a full web app (vanilla JS/CSS/HTML + standard
      web components)
- [x] Loadable Relay Tool functions: the core ships empty;
      File → Settings enables functions from
      localhostServer's catalog (functions.list) — no redeploy
- [ ] More Relay Tool functions
- [ ] Chat users and presence (beyond the two-user test setup)
- [ ] `wss` for the brokers (mixed-content-safe from https pages)
