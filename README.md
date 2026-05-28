# pi-9router-ext

[![npm](https://img.shields.io/npm/v/pi-9router-ext?color=blue)](https://www.npmjs.com/package/pi-9router-ext)

Pi Coding Agent extension for [9router](https://github.com/decolua/9router) — an open-source AI routing proxy.

**Install:** `pi install npm:pi-9router-ext`

Connects Pi to your 9router instance via its OpenAI-compatible API, with dynamic model discovery and interactive configuration.

## Features

- **Auto-discovery** — Fetches available models and combos from 9router on startup
- **Dynamic provider** — Registers 9router as a Pi provider with live model list
- **Pi-native streaming** — Uses Pi's built-in OpenAI completions provider without overriding other providers
- **Status commands** — `/9router-status`, `/9router-models`, `/9router-config`, `/9router-reload`
- **User-wide persistence** — Configuration survives new Pi instances via `~/.pi/agent/9router-config.json`
- **Routing detection** — Captures upstream model info from response headers when available

## Installation

### npm (Recommended)

```bash
pi install npm:pi-9router-ext
```

### Via local path

```bash
# Clone or download this repo
git clone https://github.com/irfansofyana/pi-9router-ext.git

# Install locally
pi install /path/to/pi-9router-ext

# Or try without installing
pi -e /path/to/pi-9router-ext
```

### Manual (copy to extensions)

```bash
cp -r pi-9router-ext/src/index.ts ~/.pi/agent/extensions/pi-9router-ext.ts
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NINE_ROUTER_BASE_URL` | `http://localhost:20128` | Your 9router instance URL |
| `NINE_ROUTER_API_KEY` | — | API key if 9router has `REQUIRE_API_KEY=true` |

Set them in your shell profile or prefix your `pi` command:

```bash
NINE_ROUTER_BASE_URL=http://my-vps:20128 NINE_ROUTER_API_KEY=nr-... pi
```

### Interactive Configuration

Use the `/9router-config` command inside Pi to set base URL and API key interactively. This is saved to `~/.pi/agent/9router-config.json` and is shared by new Pi instances. Environment variables still take precedence when set.

```
/9router-config
```

## Usage

### Selecting a 9router Model

After the extension loads, 9router models are available in Pi's model picker under the dedicated `9router/` provider namespace:

```
/model 9router/cc/claude-opus-4-7
```

Built-in providers remain separate. To use Ollama Cloud, OpenRouter, opencode-go, etc., select their normal provider/model entries (for example `ollama-cloud/...`), not a `9router/...` model.

Or browse interactively:

```
/9router-models
```

### Available Commands

| Command | Description |
|---------|-------------|
| `/9router-status` | Show connection status, model count, and config |
| `/9router-models` | Browse and select from available 9router models |
| `/9router-config` | Interactively configure base URL and API key |
| `/9router-reload` | Refresh model list from 9router |

### Available Tool

The LLM can call `ninerouter_status` to check connection status and list models programmatically.

## How It Works

```
┌─────────┐     OpenAI-compatible      ┌──────────┐     ┌─────────────┐
│   Pi    │ ──────────────────────────▶│ 9router  │ ──▶ │  Providers  │
│         │     /v1/chat/completions   │ (proxy)  │     │ (40+)       │
└─────────┘                            └──────────┘     └─────────────┘
     │
     │ 1. Fetches /v1/models on startup
     │ 2. Registers as provider "9router"
     │ 3. Uses pi-ai's normal OpenAI implementation for only 9router models
     │ 4. Leaves built-in/non-9router model switching untouched
```

## Troubleshooting

**"Failed to discover models from 9router"**
- Check that 9router is running: `curl http://localhost:20128/v1/models`
- Verify `NINE_ROUTER_BASE_URL` points to the correct host/port
- If `REQUIRE_API_KEY=true`, set `NINE_ROUTER_API_KEY`

**"No 9router models discovered"**
- 9router may have no active providers. Open the dashboard and connect a provider.
- Use `/9router-reload` to retry discovery.

**Models not showing in `/model` selector**
- Ensure the extension loaded: check for "9router connected" notification on startup
- Run `/9router-reload` to retry discovery
- Run `/reload` to refresh extensions

**Built-in provider returns 401 after installing this extension**
- Make sure the active model is the built-in provider (`ollama-cloud/...`, `openrouter/...`, etc.), not a `9router/...` route.
- Re-run `/login` for the built-in provider if its subscription token expired.
- This extension only registers provider id `9router`; it does not override built-in providers. If 9router is unreachable, the extension unregisters the `9router` provider instead of leaving an empty/broken provider around.

## Similar Projects

- [omniroute-pi-extension](https://www.npmjs.com/package/omniroute-pi-extension) — Pi extension for OmniRoute (a fork of 9router with additional features)

## License

MIT
