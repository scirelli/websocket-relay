package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"
	mqtt "github.com/mochi-mqtt/server/v2"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"websocket-relay/jsonrpc"
	"websocket-relay/mqttx"
)

// server_test.go — integration tests for localhostServer's MQTT
// broker, the JSON-RPC-over-MQTT conventions, the bridge to a
// Remote Server broker, the HTTP asset mux, and the GUI page.

func startBroker(t *testing.T, tcpAddr, wsAddr string) *mqtt.Server {
	t.Helper()
	srv, err := mqttx.NewBroker(tcpAddr, wsAddr)
	require.NoError(t, err)
	go func() { _ = srv.Serve() }()
	t.Cleanup(func() { srv.Close() })
	time.Sleep(150 * time.Millisecond) // let listeners come up
	return srv
}

// pahoConnect returns a connected test client subscribed nowhere;
// messages are delivered to the returned channel as "topic payload".
func pahoConnect(t *testing.T, id, url string) (paho.Client, chan string) {
	t.Helper()
	msgs := make(chan string, 16)
	opts := paho.NewClientOptions().AddBroker(url).SetClientID(id)
	opts.SetDefaultPublishHandler(func(c paho.Client, m paho.Message) {
		msgs <- m.Topic() + " " + string(m.Payload())
	})
	c := paho.NewClient(opts)
	tok := c.Connect()
	require.True(t, tok.WaitTimeout(5*time.Second), "connect timeout")
	require.NoError(t, tok.Error())
	t.Cleanup(func() { c.Disconnect(50) })
	return c, msgs
}

func subscribe(t *testing.T, c paho.Client, filter string) {
	t.Helper()
	tok := c.Subscribe(filter, 0, nil)
	require.True(t, tok.WaitTimeout(5*time.Second), "subscribe timeout")
	require.NoError(t, tok.Error())
}

func awaitMsg(t *testing.T, msgs chan string, wantSubstr string) string {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-msgs:
			if wantSubstr == "" || strings.Contains(m, wantSubstr) {
				return m
			}
		case <-deadline:
			t.Fatalf("timeout waiting for message containing %q", wantSubstr)
			return ""
		}
	}
}

func TestRPCOverMQTTLocalhost(t *testing.T) {
	srv := startBroker(t, "127.0.0.1:18883", "127.0.0.1:18083")
	require.NoError(t, mqttx.RespondRPC(srv, "localhost", jsonrpc.BuildDispatcher()))

	c, msgs := pahoConnect(t, "tester", "tcp://127.0.0.1:18883")
	subscribe(t, c, "shim/clients/tester/rpc")

	req, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "echo", "params": "hello mqtt", "id": 7,
	})
	tok := c.Publish("shim/rpc/localhost/tester", 0, false, req)
	require.True(t, tok.WaitTimeout(5*time.Second))
	require.NoError(t, tok.Error())

	got := awaitMsg(t, msgs, `"id":7`)
	assert.Contains(t, got, `"result":"hello mqtt"`)
}

func TestBridgeChatAndRemoteRPC(t *testing.T) {
	// Remote broker: bare broker + the remote RPC responder.
	remote := startBroker(t, "127.0.0.1:18885", "")
	require.NoError(t, mqttx.RespondRPC(remote, "remote", jsonrpc.BuildDispatcher()))

	// Local broker with the bridge wired to the remote.
	local := startBroker(t, "127.0.0.1:18884", "127.0.0.1:18084")
	hook := &bridgeHook{}
	require.NoError(t, local.AddHook(hook, nil))
	require.NoError(t, mqttx.RespondRPC(local, "localhost", jsonrpc.BuildDispatcher()))
	uplink, err := dialUplink(local, "tcp://127.0.0.1:18885")
	require.NoError(t, err)
	hook.uplink = uplink

	// Chat: a message published locally for chat/remote must
	// arrive at a subscriber on the REMOTE broker, exactly once.
	remoteClient, remoteMsgs := pahoConnect(t, "remote-side", "tcp://127.0.0.1:18885")
	subscribe(t, remoteClient, "chat/remote")
	localClient, localMsgs := pahoConnect(t, "local-side", "tcp://127.0.0.1:18884")
	tok := localClient.Publish("chat/remote", 0, false, mqttx.ChatPayload("steve", "hi via bridge"))
	require.True(t, tok.WaitTimeout(5*time.Second))
	got := awaitMsg(t, remoteMsgs, "hi via bridge")
	assert.Contains(t, got, `"from":"steve"`)
	select {
	case dup := <-remoteMsgs:
		t.Fatalf("duplicate bridged message (loop?): %s", dup)
	case <-time.After(400 * time.Millisecond):
	}

	// Script delivery, back-flow: a script.deliver published on
	// the REMOTE broker must reach a subscriber on the LOCAL one.
	subscribe(t, localClient, "scripts/steve")
	deliver, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "script.deliver",
		"params": map[string]any{
			"from": "muse", "name": "Puppy", "description": "test", "script": "void 0",
		},
	})
	tok = remoteClient.Publish("scripts/steve", 0, false, deliver)
	require.True(t, tok.WaitTimeout(5*time.Second))
	got = awaitMsg(t, localMsgs, "script.deliver")
	assert.Contains(t, got, `"name":"Puppy"`)

	// Assistant, back-flow: a snapshot request published on the
	// REMOTE broker must reach a subscriber on the LOCAL one.
	subscribe(t, localClient, "assistant/steve/request")
	snapReq, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "assistant.snapshot",
		"params": map[string]any{"id": "s1"},
	})
	tok = remoteClient.Publish("assistant/steve/request", 0, false, snapReq)
	require.True(t, tok.WaitTimeout(5*time.Second))
	got = awaitMsg(t, localMsgs, "assistant.snapshot")
	assert.Contains(t, got, `"id":"s1"`)

	// Assistant, out-flow: a snapshot message published locally
	// must arrive at a subscriber on the REMOTE broker.
	subscribe(t, remoteClient, "assistant/steve/snapshot")
	tok = localClient.Publish("assistant/steve/snapshot", 0, false,
		[]byte(`{"id":"s1","kind":"begin","meta":{"url":"http://example.test/"}}`))
	require.True(t, tok.WaitTimeout(5*time.Second))
	got = awaitMsg(t, remoteMsgs, `"kind":"begin"`)
	assert.Contains(t, got, `"url":"http://example.test/"`)

	// RPC to target remote: request published locally must be
	// answered by the remote responder, response bridged back.
	subscribe(t, localClient, "shim/clients/local-side/rpc")
	req, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "ping", "id": 9,
	})
	tok = localClient.Publish("shim/rpc/remote/local-side", 0, false, req)
	require.True(t, tok.WaitTimeout(5*time.Second))
	got = awaitMsg(t, localMsgs, `"id":9`)
	assert.Contains(t, got, `"result":"pong"`)
}

func TestAssetMux(t *testing.T) {
	srv := httptest.NewServer(buildMux())
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/health")
	require.NoError(t, err)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Equal(t, "ok", string(body))

	resp, err = http.Get(srv.URL + "/relay-tool.js")
	require.NoError(t, err)
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, RelayToolVersion, resp.Header.Get("X-Relay-Tool-Version"))
	assert.Contains(t, string(body), "relay-tool")

	resp, err = http.Get(srv.URL + "/mqtt.min.js")
	require.NoError(t, err)
	body, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Greater(t, len(body), 100_000, "vendored MQTT.js should be the full build")
	assert.Contains(t, string(body), "mqtt")
}

func TestFunctionsListOverMQTT(t *testing.T) {
	srv := startBroker(t, "127.0.0.1:18886", "")
	require.NoError(t, mqttx.RespondRPC(srv, "localhost", buildLocalDispatcher()))

	c, msgs := pahoConnect(t, "fn-tester", "tcp://127.0.0.1:18886")
	subscribe(t, c, "shim/clients/fn-tester/rpc")
	req, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": "functions.list", "id": 3,
	})
	tok := c.Publish("shim/rpc/localhost/fn-tester", 0, false, req)
	require.True(t, tok.WaitTimeout(5*time.Second))

	got := awaitMsg(t, msgs, `"id":3`)
	assert.Contains(t, got, `"id":"echo"`)
	assert.Contains(t, got, `"id":"chat"`)
	assert.Contains(t, got, `"id":"inbox"`)
	assert.Contains(t, got, `"script":"/functions/echo.js"`)
	assert.Contains(t, got, `"script":"/functions/chat.js"`)
	assert.Contains(t, got, `"script":"/functions/inbox.js"`)
}

func TestFunctionFilesServed(t *testing.T) {
	srv := httptest.NewServer(buildMux())
	t.Cleanup(srv.Close)

	for _, id := range []string{"echo", "chat", "inbox"} {
		resp, err := http.Get(srv.URL + "/functions/" + id + ".js")
		require.NoError(t, err)
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		assert.Equal(t, http.StatusOK, resp.StatusCode, id)
		assert.Contains(t, string(body), "registerFunction", id)
		assert.Contains(t, string(body), `id: '`+id+`'`, id)
	}

	resp, err := http.Get(srv.URL + "/functions/nope.js")
	require.NoError(t, err)
	resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestGUIServesSnippetWithStamps(t *testing.T) {
	url, err := startGUI("127.0.0.1", "127.0.0.1", 8083, 8765)
	require.NoError(t, err)

	resp, err := http.Get(url + "/")
	require.NoError(t, err)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	page := string(body)
	assert.Contains(t, page, "ws://127.0.0.1:8083", "snippet must carry the live broker URL")
	assert.Contains(t, page, RelayToolVersion)
	for _, ph := range []string{"__BROKER_URL__", "__ASSET_BASE__", "__RELAY_TOOL_VERSION__"} {
		assert.NotContains(t, page, ph, "placeholder %s must be stamped", ph)
	}
}

// getGUIPage fetches a started GUI's page with an explicit Host
// header, as a browser on another machine would send it.
func getGUIPage(t *testing.T, url, host string) string {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url+"/", nil)
	require.NoError(t, err)
	req.Host = host
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return string(body)
}

func TestGUIStampsRequestHostWhenBindIsWildcard(t *testing.T) {
	url, err := startGUI("127.0.0.1", "", 8083, 8765)
	require.NoError(t, err)

	page := getGUIPage(t, url, "192.0.2.10:46139")
	assert.Contains(t, page, "ws://192.0.2.10:8083",
		"with no stamp host, the snippet names the host the browser used")
	assert.Contains(t, page, "http://192.0.2.10:8765")
	assert.NotContains(t, page, "0.0.0.0")
}

func TestGUIStampHostOverridesRequestHost(t *testing.T) {
	url, err := startGUI("127.0.0.1", "203.0.113.7", 8083, 8765)
	require.NoError(t, err)

	page := getGUIPage(t, url, "192.0.2.10:46139")
	assert.Contains(t, page, "ws://203.0.113.7:8083",
		"an explicit stamp host (-public-host) wins over the request Host")
}
