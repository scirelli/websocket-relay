// functions.go — the catalog of loadable Relay Tool functions.
//
// localhostServer serves each function's script at
// /functions/<id>.js and describes the whole catalog over
// JSON-RPC (method functions.list). The Relay Tool's Settings
// panel renders the catalog; enabling a function makes the tool
// load its dependencies (in order) and then its script, which
// registers the function's panel with the tool core.
//
// Adding a function = one script in src/client/functions/ plus
// one entry in functionCatalog. No client redeploy: the snippet
// and the tool core don't change.
package main

import (
	"encoding/json"
	"net/http"
	"path"
	"strings"

	relay "websocket-relay"
)

// FunctionDep is one dependency of a function: a script or style
// the loader must fetch (in declared order) before the function's
// own script. URLs are asset-server paths ("/…") or absolute URLs.
type FunctionDep struct {
	Type string `json:"type"` // "script" | "style"
	URL  string `json:"url"`
}

// FunctionMeta describes one loadable function to the Relay Tool.
type FunctionMeta struct {
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Version      string        `json:"version"`
	Description  string        `json:"description"`
	Script       string        `json:"script"`
	Dependencies []FunctionDep `json:"dependencies"`
}

// functionCatalog is the server's source of truth for loadable
// functions. Keep versions in step with VERSION in each script.
var functionCatalog = []FunctionMeta{
	{
		ID:           "echo",
		Name:         "Echo",
		Version:      "1.0.1",
		Description:  "Send a message, get it echoed back — pick which server answers.",
		Script:       "/functions/echo.js",
		Dependencies: []FunctionDep{},
	},
	{
		ID:           "chat",
		Name:         "Chat",
		Version:      "1.0.0",
		Description:  "MQTT chat between users (chat.message on chat/<username>).",
		Script:       "/functions/chat.js",
		Dependencies: []FunctionDep{},
	},
	{
		ID:           "inbox",
		Name:         "Inbox",
		Version:      "1.0.0",
		Description:  "One inbox for everything to review and allow or deny: delivered scripts (script.deliver on scripts/<username>) to Accept and run, and Read Page requests (assistant.snapshot on assistant/<username>/request) to Accept and answer with the page's DOM, metrics, and console buffer. Also buffers the page's console (deduplicated) and can stream it live.",
		Script:       "/functions/inbox.js",
		Dependencies: []FunctionDep{},
	},
}

// functionsListHandler answers the functions.list RPC method with
// the catalog.
func functionsListHandler(params json.RawMessage) (json.RawMessage, error) {
	return json.Marshal(functionCatalog)
}

// functionFileHandler serves GET /functions/<id>.js from the
// embedded client files. Only catalog functions are served.
func functionFileHandler(w http.ResponseWriter, r *http.Request) {
	name := path.Base(r.URL.Path)
	id := strings.TrimSuffix(name, ".js")
	for _, meta := range functionCatalog {
		if meta.ID == id && path.Base(meta.Script) == name {
			body, ok := relay.FunctionFile(name)
			if !ok {
				break
			}
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(body)
			return
		}
	}
	http.NotFound(w, r)
}
