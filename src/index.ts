/**
 * pi-9router-ext
 *
 * Pi Coding Agent extension for 9router — an open-source AI routing proxy.
 * Connects Pi to your 9router instance via its OpenAI-compatible API.
 *
 * Features:
 * - Auto-discovers models and combos from 9router on startup
 * - Registers 9router as a Pi provider with dynamic base URL and API key
 * - Status commands to view connection info and available models
 * - User-persisted configuration shared by all Pi instances
 *
 * Environment variables:
 *   NINE_ROUTER_BASE_URL - 9router endpoint (default: http://localhost:20128)
 *   NINE_ROUTER_API_KEY  - API key if 9router requires authentication
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// =============================================================================
// Types
// =============================================================================

interface NineRouterConfig {
	baseUrl: string;
	apiKey: string | undefined;
}

interface NineRouterModel {
	id: string;
	object: string;
	owned_by?: string;
	kind?: string;
}

interface NineRouterModelsResponse {
	object: string;
	data: NineRouterModel[];
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BASE_URL = "http://localhost:20128";
const ENV_BASE_URL = process.env.NINE_ROUTER_BASE_URL;
const ENV_API_KEY = process.env.NINE_ROUTER_API_KEY;
const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router-config.json");

const CUSTOM_TYPE_CONFIG = "9router-config";
const CUSTOM_TYPE_LAST_ROUTE = "9router-last-route";

// Headers that may indicate the actual upstream model used
const ROUTING_HEADERS = [
	"x-9router-model",
	"x-routed-model",
	"x-actual-model",
	"x-upstream-model",
	"x-provider-model",
];

// =============================================================================
// Config Helpers
// =============================================================================

function normalizeBaseUrl(url: string): string {
	return url.replace(/\/$/, "");
}

function maskApiKey(key: string): string {
	if (key.length <= 8) return "●".repeat(key.length);
	return key.slice(0, 4) + "●".repeat(Math.max(0, key.length - 8)) + key.slice(-4);
}

function applyEnvOverrides(config: NineRouterConfig): NineRouterConfig {
	return {
		baseUrl: normalizeBaseUrl(ENV_BASE_URL || config.baseUrl),
		apiKey: ENV_API_KEY || config.apiKey,
	};
}

function loadConfigFromDisk(): NineRouterConfig | null {
	try {
		if (!existsSync(CONFIG_PATH)) return null;
		const data = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<NineRouterConfig>;
		if (!data.baseUrl || typeof data.baseUrl !== "string") return null;
		return {
			baseUrl: normalizeBaseUrl(data.baseUrl),
			apiKey: typeof data.apiKey === "string" && data.apiKey.trim()
				? data.apiKey.trim()
				: undefined,
		};
	} catch (err) {
		console.error("[pi-9router-ext] Failed to load persisted config:", err);
		return null;
	}
}

function saveConfigToDisk(config: NineRouterConfig) {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(
			CONFIG_PATH,
			`${JSON.stringify({ baseUrl: config.baseUrl, apiKey: config.apiKey }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} catch (err) {
		console.error("[pi-9router-ext] Failed to persist config:", err);
	}
}

function getInitialConfig(): NineRouterConfig {
	return applyEnvOverrides(loadConfigFromDisk() || {
		baseUrl: DEFAULT_BASE_URL,
		apiKey: undefined,
	});
}

function loadConfigFromSession(ctx: ExtensionContext): NineRouterConfig | null {
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "custom" && entry.customType === CUSTOM_TYPE_CONFIG) {
			const data = entry.data as Partial<NineRouterConfig> | undefined;
			if (data?.baseUrl) {
				return applyEnvOverrides({
					baseUrl: normalizeBaseUrl(data.baseUrl),
					apiKey: data.apiKey,
				});
			}
		}
	}
	return null;
}

function persistConfig(pi: ExtensionAPI, config: NineRouterConfig) {
	saveConfigToDisk(config);
	pi.appendEntry(CUSTOM_TYPE_CONFIG, {
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
	});
}

// =============================================================================
// 9router API Client
// =============================================================================

async function fetchModels(
	config: NineRouterConfig,
	signal?: AbortSignal,
): Promise<NineRouterModel[]> {
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}

	const response = await fetch(`${config.baseUrl}/v1/models`, {
		method: "GET",
		headers,
		signal,
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(
			`9router returned ${response.status}: ${text || response.statusText}`,
		);
	}

	const payload = (await response.json()) as NineRouterModelsResponse;
	return payload.data || [];
}

async function testConnection(
	config: NineRouterConfig,
	signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const headers: Record<string, string> = {};
		if (config.apiKey) {
			headers.Authorization = `Bearer ${config.apiKey}`;
		}

		const response = await fetch(`${config.baseUrl}/v1/models`, {
			method: "GET",
			headers,
			signal,
		});

		if (response.ok) {
			return { ok: true };
		}
		return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// =============================================================================
// Model Mapping
// =============================================================================

function mapNineRouterModel(model: NineRouterModel) {
	const isCombo = model.owned_by === "combo";

	return {
		id: model.id,
		name: isCombo ? `🔀 ${model.id}` : model.id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: {
			// 9router is an OpenAI-compatible proxy; keep requests conservative so
			// using this extension does not force built-in-provider-specific features.
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
		},
	};
}

// =============================================================================
// Provider Registration
// =============================================================================

function registerNineRouterProvider(
	pi: ExtensionAPI,
	config: NineRouterConfig,
	models: NineRouterModel[],
) {
	// Always use a dedicated provider id ("9router") and never override built-in
	// providers like ollama-cloud/openrouter. Pi requires apiKey for custom
	// providers with models; 9router receives the real key only when configured,
	// otherwise a harmless placeholder is scoped to the 9router provider.
	pi.registerProvider("9router", {
		name: "9router",
		baseUrl: `${config.baseUrl}/v1`,
		apiKey: config.apiKey || "9router-no-api-key",
		api: "openai-completions",
		models: models.map(mapNineRouterModel),
	});
}

function unregisterNineRouterProvider(pi: ExtensionAPI) {
	pi.unregisterProvider("9router");
}

// =============================================================================
// Extension Factory
// =============================================================================

export default async function (pi: ExtensionAPI) {
	// ---------------------------------------------------------------------------
	// Load configuration (env vars are defaults; session config applied later)
	// ---------------------------------------------------------------------------
	let config: NineRouterConfig = getInitialConfig();

	// State that survives across the extension lifetime
	let discoveredModels: NineRouterModel[] = [];
	let lastRoutedModel: string | undefined;
	let activeProvider: string | undefined;
	let isConnected = false;

	// ---------------------------------------------------------------------------
	// Provider registration (async factory = models available immediately)
	// ---------------------------------------------------------------------------
	try {
		const models = await fetchModels(config);
		discoveredModels = models;
		isConnected = true;
		registerNineRouterProvider(pi, config, models);
	} catch (err) {
		console.error(
			"[pi-9router-ext] Failed to discover models from 9router:",
			err,
		);
		// Do not register an empty/broken provider on startup. Leaving the provider
		// absent is safer for built-in Pi providers and model selection. Commands
		// remain available so the user can configure/reload 9router later.
		unregisterNineRouterProvider(pi);
	}

	// ---------------------------------------------------------------------------
	// Session start: rehydrate config from session
	// ---------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const restored = loadConfigFromSession(ctx);
		if (!loadConfigFromDisk() && restored) {
			// Migrate old session-persisted config to the new user-wide config file.
			config = restored;
			persistConfig(pi, config);
			try {
				const models = await fetchModels(config, ctx.signal);
				discoveredModels = models;
				isConnected = true;
				registerNineRouterProvider(pi, config, models);
			} catch (err) {
				isConnected = false;
				console.error("[pi-9router-ext] Failed to refresh migrated config:", err);
			}
		}

		if (isConnected && discoveredModels.length > 0) {
			ctx.ui.notify(
				`9router connected — ${discoveredModels.length} models available`,
				"info",
			);
		} else {
			ctx.ui.notify(
				`9router not connected — check ${config.baseUrl}`,
				"warning",
			);
		}
	});

	// ---------------------------------------------------------------------------
	// Detect routed model from response headers
	// ---------------------------------------------------------------------------
	pi.on("after_provider_response", (event) => {
		if (event.status >= 400 || activeProvider !== "9router") {
			return;
		}

		for (const header of ROUTING_HEADERS) {
			const value = event.headers[header];
			if (value && typeof value === "string") {
				lastRoutedModel = value;
				pi.appendEntry(CUSTOM_TYPE_LAST_ROUTE, {
					model: value,
					timestamp: Date.now(),
				});
				break;
			}
		}
	});

	// ---------------------------------------------------------------------------
	// Clear routing info when model changes
	// ---------------------------------------------------------------------------
	pi.on("model_select", async (event) => {
		activeProvider = event.model.provider;
		if (event.model.provider !== "9router") {
			lastRoutedModel = undefined;
		}
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-status
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-status", {
		description: "Show 9router connection status and configuration",
		handler: async (_args, ctx) => {
			const test = await testConnection(config, ctx.signal);
			const lines: string[] = [
				`🔗 9router Status`,
				``,
				`Base URL:    ${config.baseUrl}`,
				`API Key:     ${config.apiKey ? maskApiKey(config.apiKey) : "not set"}`,
				`Connection:  ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
				`Models:      ${discoveredModels.length} available`,
			];

			if (lastRoutedModel) {
				lines.push(`Last routed: ${lastRoutedModel}`);
			}

			const combos = discoveredModels.filter((m) => m.owned_by === "combo");
			const regular = discoveredModels.filter((m) => m.owned_by !== "combo");
			if (regular.length > 0) {
				lines.push(``, `Regular models: ${regular.length}`);
			}
			if (combos.length > 0) {
				lines.push(`Combos:         ${combos.length}`);
			}

			ctx.ui.notify(lines.join("\n"), test.ok ? "info" : "warning");
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-models
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-models", {
		description: "Browse 9router available models and combos",
		handler: async (_args, ctx) => {
			if (discoveredModels.length === 0) {
				ctx.ui.notify(
					"No 9router models discovered. Check connection with /9router-status",
					"warning",
				);
				return;
			}

			const items = discoveredModels.map((m) => {
				const isCombo = m.owned_by === "combo";
				return {
					value: m.id,
					label: isCombo ? `🔀 ${m.id}` : m.id,
				};
			});

			const selected = await ctx.ui.select(
				"Select a 9router model to use:",
				items.map((i) => i.label),
			);
			if (!selected) return;

			const modelId = items.find((i) => i.label === selected)?.value;
			if (!modelId) return;

			const fullModelId = `9router/${modelId}`;
			ctx.ui.notify(`Switching to ${fullModelId}...`, "info");
			pi.sendUserMessage(`/model ${fullModelId}`, { deliverAs: "followUp" });
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-config
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-config", {
		description: "Configure 9router base URL and API key",
		handler: async (_args, ctx) => {
			// Show current config first
			const test = await testConnection(config, ctx.signal);
			const currentStatus = test.ok ? "🟢 connected" : "🔴 disconnected";
			const currentApiKeyDisplay = config.apiKey ? "●●●●●●●● (set)" : "not set";

			const currentLines = [
				"Current config:",
				`  Base URL:  ${config.baseUrl}`,
				`  API Key:   ${config.apiKey ? maskApiKey(config.apiKey) : "not set"}`,
				`  Status:    ${currentStatus}`,
				"",
				"Enter new values (press Enter to keep current):",
			].join("\n");

			const newBaseUrl = await ctx.ui.input(
				currentLines,
				"Base URL",
				config.baseUrl,
			);
			if (newBaseUrl === undefined) return; // cancelled

			const newApiKey = await ctx.ui.input(
				"API key (press Enter to keep current, leave blank to remove):",
				"API Key",
				config.apiKey || "",
			);
			if (newApiKey === undefined) return; // cancelled

			config = {
				baseUrl: normalizeBaseUrl(newBaseUrl),
				apiKey: newApiKey.trim() || undefined,
			};

			persistConfig(pi, config);

			// Try to refresh models and re-register provider
			try {
				const models = await fetchModels(config, ctx.signal);
				discoveredModels = models;
				isConnected = true;

				registerNineRouterProvider(pi, config, models);

				ctx.ui.notify(
					`9router updated — ${models.length} models at ${config.baseUrl}`,
					"info",
				);
			} catch (err) {
				isConnected = false;
				unregisterNineRouterProvider(pi);
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to connect: ${msg}`, "error");
			}
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-reload
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-reload", {
		description: "Reload models from 9router",
		handler: async (_args, ctx) => {
			try {
				const models = await fetchModels(config, ctx.signal);
				discoveredModels = models;
				isConnected = true;

				registerNineRouterProvider(pi, config, models);

				ctx.ui.notify(
					`9router reloaded — ${models.length} models`,
					"info",
				);
			} catch (err) {
				isConnected = false;
				unregisterNineRouterProvider(pi);
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Reload failed: ${msg}`, "error");
			}
		},
	});

	// ---------------------------------------------------------------------------
	// Tool: ninerouter_status
	// ---------------------------------------------------------------------------
	pi.registerTool({
		name: "ninerouter_status",
		label: "9router Status",
		description:
			"Check 9router connection status and list available models",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const test = await testConnection(config, ctx.signal);
			const combos = discoveredModels.filter((m) => m.owned_by === "combo");
			const regular = discoveredModels.filter((m) => m.owned_by !== "combo");

			return {
				content: [
					{
						type: "text",
						text: [
							`9router: ${test.ok ? "connected" : `disconnected (${test.error})`}`,
							`Base URL: ${config.baseUrl}`,
							`Total models: ${discoveredModels.length}`,
							`  Regular: ${regular.length}`,
							`  Combos:  ${combos.length}`,
							lastRoutedModel
								? `Last routed model: ${lastRoutedModel}`
								: "",
						]
							.filter(Boolean)
							.join("\n"),
					},
				],
				details: {
					connected: test.ok,
					baseUrl: config.baseUrl,
					modelCount: discoveredModels.length,
					regularCount: regular.length,
					comboCount: combos.length,
					lastRoutedModel,
					models: discoveredModels.map((m) => m.id),
				},
			};
		},
	});
}
