# pi-9router-ext

[![npm](https://img.shields.io/npm/v/pi-9router-ext?color=blue)](https://www.npmjs.com/package/pi-9router-ext)

Pi Coding Agent extension for [9router](https://github.com/decolua/9router) — an open-source AI routing proxy.

**Install:** `pi install npm:pi-9router-ext`

Connects Pi to your 9router instance via its OpenAI-compatible API, with dynamic model discovery and interactive configuration.

## Features

- **Auto-discovery** — Fetches available models and combos from 9router on startup
- **Dynamic provider** — Registers 9router as a Pi provider with live model list
- **Model metadata fallback** — Uses live router metadata when present, then cached models.dev metadata for context windows, output limits, and modalities
- **Graceful startup** — Loads commands/tools immediately and discovers 9router models in the background so Pi remains usable before API keys or routes are configured
- **Pi-native streaming** — Uses Pi's built-in OpenAI completions provider without overriding other providers
- **Status commands** — `/9router-status`, `/9router-models`, `/9router-config`, `/9router-reasoning`, `/9router-reload`
- **Manual reasoning toggle** — Optionally expose Pi thinking levels and send `reasoning_effort` to 9router
- **Web tools** — Exposes 9router web search/fetch routes as LLM-callable Pi tools
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

### Manual / development install

Prefer installing the package directory instead of copying individual source files. The extension may include multiple files, tools, commands, and helper modules; installing the directory lets Pi read the package manifest and load everything declared there.

```bash
# Clone or update the repo
git clone https://github.com/irfansofyana/pi-9router-ext.git
cd pi-9router-ext

# Install this working tree into Pi
pi install "$PWD"

# Reload Pi, then use /9router-config
```

Avoid copying only `src/index.ts` into `~/.pi/agent/extensions`. That bypasses `package.json` metadata and can miss companion files added by future features.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NINE_ROUTER_BASE_URL` | `http://localhost:20128` | Your 9router instance URL |
| `NINE_ROUTER_API_KEY` | — | API key if 9router has `REQUIRE_API_KEY=true` |
| `NINE_ROUTER_ENABLE_REASONING` | `false` | Set to `true`/`1`/`on` to expose Pi thinking levels for 9router models |

Set them in your shell profile or prefix your `pi` command:

```bash
NINE_ROUTER_BASE_URL=http://my-vps:20128 NINE_ROUTER_API_KEY=nr-... pi
```

### Interactive Configuration

Use the `/9router-config` command inside Pi to open a configuration menu for connection settings, reasoning, web defaults, and status/routes. This is saved to `~/.pi/agent/9router-config.json` and is shared by new Pi instances. Environment variables still take precedence when set.

```
/9router-config
```

Use `/9router-reasoning` to quickly enable or disable reasoning without changing the base URL or API key.

Web search/fetch defaults are configured from discovered `GET /v1/models/web` routes inside `/9router-config`. Direct provider routes such as `brave/search` and `tavily/fetch` are supported, as are 9router web combos.

### Model Limits and Metadata

9router-compatible `/v1/models` responses may only include `id`, `object`, and `owned_by`. When context/output limits are absent, the extension fills them from cached models.dev metadata at `~/.cache/pi/9router-model-metadata.json` (or `$XDG_CACHE_HOME/pi/9router-model-metadata.json`). Router-provided fields still take priority when available. If neither source has metadata, safe defaults are used: `128000` context tokens and a conservative `4096` output tokens.

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

### Reasoning / Thinking Levels

9router's `/v1/models` endpoint does not currently expose reliable per-model reasoning capability metadata. For safety, this extension keeps reasoning disabled by default.

If your selected 9router route/model supports reasoning, enable the manual toggle:

```
/9router-reasoning
```

When enabled, Pi treats 9router models as reasoning-capable. Use Pi's normal thinking controls such as Shift+Tab, `--thinking high`, or model suffixes like `9router/cx/gpt-5.3-codex:high`. Pi sends OpenAI-style `reasoning_effort` values to 9router (`off → none`, `low`, `medium`, `high`, `xhigh`).

### Web Search / Fetch Tools

If 9router exposes web routes from `GET /v1/models/web`, this extension lets the LLM call them through Pi tools:

- `ninerouter_web_search` — calls `POST /v1/search`
- `ninerouter_web_fetch` — calls `POST /v1/web/fetch`

Tools are always registered. If no matching web route is configured or discovered, they fail with an actionable message telling you to configure web defaults in `/9router-config`.

Search supports all generic fields exposed by 9router:

```json
{
  "query": "latest pi coding agent extension docs",
  "route": "brave/search",
  "max_results": 5,
  "search_type": "web",
  "country": "US",
  "language": "en",
  "time_range": "week",
  "offset": 0,
  "domain_filter": ["github.com"],
  "content_options": {},
  "provider_options": {}
}
```

Fetch supports:

```json
{
  "url": "https://example.com",
  "route": "tavily/fetch",
  "format": "markdown",
  "max_characters": 12000
}
```

`route` is optional. If omitted, the configured default route is used; if that route disappears, the extension falls back to the first discovered compatible route and records that in tool details/status. Per-call route overrides can be direct routes (`brave/search`, `tavily/fetch`) or combo names.

### Available Commands

| Command | Description |
|---------|-------------|
| `/9router-status` | Show connection status, model count, web route count, and config |
| `/9router-models` | Browse and select from available 9router models |
| `/9router-config` | Menu for connection, reasoning, web defaults, and status/routes |
| `/9router-reasoning` | Enable or disable Pi thinking levels for 9router models |
| `/9router-reload` | Refresh model list and web routes from 9router |

### Available Tools

The LLM can call:

- `ninerouter_status` — check connection status, model list, and web route defaults
- `ninerouter_web_search` — search the web through 9router
- `ninerouter_web_fetch` — fetch/extract URL content through 9router

## How It Works

```
┌─────────┐     OpenAI-compatible      ┌──────────┐     ┌─────────────┐
│   Pi    │ ──────────────────────────▶│ 9router  │ ──▶ │  Providers  │
│         │     /v1/chat/completions   │ (proxy)  │     │ (40+)       │
└─────────┘                            └──────────┘     └─────────────┘
     │
     │ 1. Fetches /v1/models and /v1/models/web on startup
     │ 2. Registers as provider "9router"
     │ 3. Uses pi-ai's normal OpenAI implementation for only 9router models
     │ 4. Registers web search/fetch as Pi tools
     │ 5. Leaves built-in/non-9router model switching untouched
```

## Troubleshooting

**"9router not configured" or no 9router models after install**
- This is expected before 9router is reachable or before an API key is configured.
- Pi remains usable; the extension discovers models in the background and registers the `9router` provider only after discovery succeeds.
- Run `/9router-config` to set connection details, then `/9router-reload`.

**"Failed to discover models from 9router"**
- Check that 9router is running: `curl http://localhost:20128/v1/models`
- Verify `NINE_ROUTER_BASE_URL` points to the correct host/port
- If `REQUIRE_API_KEY=true`, set `NINE_ROUTER_API_KEY`

**"No 9router models discovered"**
- 9router may have no active providers. Open the dashboard and connect a provider.
- Use `/9router-reload` to retry discovery.

**"No 9router web search/fetch route is configured or discovered"**
- Open the 9router dashboard and connect a web provider such as Brave, Tavily, Exa, or a web combo.
- Run `/9router-reload` or open `/9router-config` → `Web defaults` to refresh `/v1/models/web`.
- Pick separate default routes for search and fetch if more than one route exists.

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
