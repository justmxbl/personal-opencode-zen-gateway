# opencode-zen-gateway

A self-contained, OpenAI-compatible local API that serves **OpenCode Zen's free
models** to any client — Cline, Roo Code, Continue, Aider, a custom script, or
anything else that speaks the OpenAI API.

```
OpenAI client ──▶ gateway :8899 ──▶ opencode serve :4096 ──▶ opencode.ai/zen/v1
                  (gateway.js)       (official binary)        (accepts only official TLS)
```

Cross-platform: Windows, macOS and Linux.

## Why the gateway spawns `opencode serve`

Since around 2026-09-18, `https://opencode.ai/zen/v1` rejects every client that
is not the genuine OpenCode client:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

The gate is **below the HTTP layer**. Replaying a captured request byte for byte
— correct `User-Agent`, `x-opencode-*` headers, session IDs, body — still returns
403 (upstream issues #49621, #49723, #49756). The remaining discriminator is the
TLS handshake fingerprint of the official build and/or an embedded secret, which
Node, Python, .NET and curl cannot reproduce.

The official `opencode` binary passes the gate. So this gateway **spawns and
supervises a local `opencode serve` process** and forwards every request through
it. You get the free models without depending on any separate launcher scripts.

## Features

- **Self-contained**: starts, monitors and restarts its own `opencode serve`
  backend. One process to run.
- **Cross-platform**: works on Windows, macOS and Linux (no OS-specific code
  paths in the gateway itself).
- **OpenAI compatible**: `/v1/models` and `/v1/chat/completions`, streaming and
  non-streaming, `reasoning_content`, system prompts, image inputs, multi-turn.
- **Deep health checks**: `/health` probes the backend (not just the port);
  `/ready` runs a real end-to-end completion to verify the upstream gate.
- **Resilience**: automatic backend restart with backoff, event-stream
  reconnection, request timeouts, per-request session cleanup.
- **Alerts**: structured log plus an optional webhook (`ALERT_WEBHOOK`) on
  backend failures, restarts and readiness failures.

## Requirements

- **Node.js 18+**
- The **official `opencode` CLI** installed and on `PATH` (or `OPENCODE_BIN` set)

```sh
npm install -g opencode-ai   # provides the `opencode` binary
opencode --version
```

## Quick start

```sh
# run in the foreground
./start.sh            # macOS / Linux
start.bat             # Windows

# the gateway spawns the backend and prints:
#   [INFO] spawning opencode backend {...}
#   [INFO] listening on http://127.0.0.1:8899
```

Verify:

```sh
curl http://127.0.0.1:8899/health
curl http://127.0.0.1:8899/ready
curl http://127.0.0.1:8899/v1/models
```

### Install as a service

Windows (scheduled task, hidden, auto-restart):

```powershell
powershell -ExecutionPolicy Bypass -File .\install-service.ps1
```

Linux / macOS (systemd user service, `Restart=always`):

```sh
./install-service.sh            # user service
sudo ./install-service.sh --system   # system-wide
```

## Client configuration

```
Base URL: http://127.0.0.1:8899/v1
API Key:  any non-empty string (or leave blank)
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8899/v1", api_key="x")

r = client.chat.completions.create(
    model="mimo-v2.5-free",
    messages=[{"role": "user", "content": "hello"}],
)
print(r.choices[0].message.content)
```

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /v1/models` | Free models with `context_length`, `max_output_tokens`, `capabilities.vision` |
| `POST /v1/chat/completions` | Chat completions, `stream: true` or `false` |
| `GET /health` | Deep health: probes the backend, reports pid/restarts/event-stream. `503` when degraded |
| `GET /ready` | End-to-end probe (real completion). Cached 60s; `?force=1` to refresh. `503` on failure |

Supported OpenAI features:

- `stream: true` (SSE, terminated by `data: [DONE]`)
- `reasoning_content` on assistant messages
- `system` / `developer` messages → opencode `system`
- `image_url` content parts → opencode file parts (vision models only)
- multi-turn history (replayed into a fresh session per request)
- extra fields (`temperature`, `top_p`, `max_tokens`, `stop`, ...) are accepted
  and ignored

## Free models

Discovered live from the backend's `/provider` endpoint; context and output
limits come from the same source.

| Model | Context | Max output | Vision |
|---|---|---|---|
| `mimo-v2.5-free` | 200K | 32K | ✅ |
| `big-pickle` | 200K | 32K | text |
| `ling-3.0-flash-fin-free` | 262K | 32K | text |
| `nemotron-3.5-lightning-free` | 262K | 262K | text |
| `nemotron-3-ultra-free` | 1M | 128K | text |
| `muse-spark-1.2-contributor-free` | 1M | 131K | text |
| `muse-spark-1.3-contributor-free` | 1M | 131K | text |

`deepseek-v4-flash-free` appears and disappears with upstream availability.

## Configuration

All settings are environment variables. See `.env.example`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8899` | Gateway listen port |
| `HOST` | `127.0.0.1` | Gateway bind address |
| `LOCAL_API_KEY` | empty | If set, clients must send `Authorization: Bearer <key>` |
| `OPENCODE_BIN` | auto | Path to the `opencode` binary |
| `OPENCODE_SERVER_PORT` | `4096` | Backend port |
| `OPENCODE_SERVER_PASSWORD` | `zen-gateway-local` | Backend basic-auth password |
| `MANAGE_BACKEND` | `true` | Spawn and supervise `opencode serve`; set `false` to use an external one |
| `OPENCODE_WORKSPACE` | `./workspace` | Sandbox cwd for the backend |
| `OPENCODE_AGENT` | `zen` | Agent used for prompts |
| `READY_MODEL` | auto | Model used by the `/ready` probe |
| `READY_TTL_MS` | `60000` | `/ready` cache TTL |
| `FREE_MODELS_TTL_MS` | `300000` | Model list cache TTL |
| `ALERT_WEBHOOK` | empty | POST JSON alerts here on failures |
| `GATEWAY_LOG` | `./gateway.log` | Log file path |

## Why tools stay enabled

The upstream gate also rejects requests whose tool set has been narrowed. An
agent with `tools: {"*": false}` or any denied permission returns the same 403,
while an agent with all tools enabled works. This was verified against every
built-in agent and several custom ones.

So `gateway-config.json` defines a `zen` agent that **keeps all tools enabled**
but instructs the model to reply directly for normal conversation. The backend
also runs in a dedicated `workspace/` directory so any tool use is confined
there.

## Reliability model

| Layer | Mechanism |
|---|---|
| Backend process | Gateway spawns it, restarts on exit with backoff (2s → 30s) |
| Backend health | `/health` performs an HTTP round-trip; returns `503` when unreachable |
| Upstream gate | `/ready` runs a real completion; cached, and alerted on failure |
| Gateway process | systemd `Restart=always` / Windows task `RestartCount=3` |
| Gateway health | Windows: 5-minute `/health` probe task; Unix: optional cron/timer |
| Event stream | Reconnects automatically after a drop |
| Requests | 300s timeout, per-request session cleanup |

## Caveats

- Requires the official `opencode` CLI. If upstream changes the gate again, this
  is the only component that needs updating.
- Each request creates and deletes an opencode session, adding a few hundred ms.
- Tool calls are executed server-side by the agent; the gateway returns the
  final text. Keep the sandbox `workspace/` in mind.
- This rides the anonymous free tier. It is rate limited and may change at any
  time. It is not affiliated with OpenCode.

## License

MIT
