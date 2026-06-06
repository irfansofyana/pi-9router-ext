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
 *   NINE_ROUTER_BASE_URL         - 9router endpoint (default: http://localhost:20128)
 *   NINE_ROUTER_API_KEY          - API key if 9router requires authentication
 *   NINE_ROUTER_ENABLE_REASONING - expose Pi thinking levels and send reasoning_effort
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	defaultRouteForKind,
	fetchWebRoutes,
	registerNineRouterWebTools,
	routesByKind,
	webRoutesSummary,
	type NineRouterWebRoute,
} from "./web.js";

// =============================================================================
// Types
// =============================================================================

interface NineRouterConfig {
	baseUrl: string;
	apiKey: string | undefined;
	enableReasoning: boolean;
	webSearchRoute: string | undefined;
	webFetchRoute: string | undefined;
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
const ENV_ENABLE_REASONING = process.env.NINE_ROUTER_ENABLE_REASONING;
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

function parseBooleanFlag(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
	if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
	return undefined;
}

function applyEnvOverrides(config: NineRouterConfig): NineRouterConfig {
	return {
		baseUrl: normalizeBaseUrl(ENV_BASE_URL || config.baseUrl),
		apiKey: ENV_API_KEY || config.apiKey,
		enableReasoning: parseBooleanFlag(ENV_ENABLE_REASONING) ?? config.enableReasoning,
		webSearchRoute: config.webSearchRoute,
		webFetchRoute: config.webFetchRoute,
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
			enableReasoning: data.enableReasoning === true,
			webSearchRoute: typeof data.webSearchRoute === "string" && data.webSearchRoute.trim()
				? data.webSearchRoute.trim()
				: undefined,
			webFetchRoute: typeof data.webFetchRoute === "string" && data.webFetchRoute.trim()
				? data.webFetchRoute.trim()
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
			`${JSON.stringify({
				baseUrl: config.baseUrl,
				apiKey: config.apiKey,
				enableReasoning: config.enableReasoning,
				webSearchRoute: config.webSearchRoute,
				webFetchRoute: config.webFetchRoute,
			}, null, 2)}\n`,
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
		enableReasoning: false,
		webSearchRoute: undefined,
		webFetchRoute: undefined,
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
					enableReasoning: data.enableReasoning === true,
					webSearchRoute: typeof data.webSearchRoute === "string" ? data.webSearchRoute : undefined,
					webFetchRoute: typeof data.webFetchRoute === "string" ? data.webFetchRoute : undefined,
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
		enableReasoning: config.enableReasoning,
		webSearchRoute: config.webSearchRoute,
		webFetchRoute: config.webFetchRoute,
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

function mapNineRouterModel(model: NineRouterModel, enableReasoning: boolean) {
	const isCombo = model.owned_by === "combo";

	return {
		id: model.id,
		name: isCombo ? `🔀 ${model.id}` : model.id,
		reasoning: enableReasoning,
		...(enableReasoning ? {
			// Pi levels are mapped to 9router's OpenAI-style reasoning_effort field.
			// 9router currently does not expose per-model reasoning capabilities from
			// /v1/models, so this is intentionally controlled by user config.
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			},
		} : {}),
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: {
			// 9router is an OpenAI-compatible proxy. Its translators primarily read
			// max_tokens, and as a proxy it should not receive OpenAI-only store=false
			// unless explicitly known to support it.
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: enableReasoning,
			maxTokensField: "max_tokens" as const,
			thinkingFormat: "openai" as const,
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
		models: models.map((model) => mapNineRouterModel(model, config.enableReasoning)),
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
	let discoveredWebRoutes: NineRouterWebRoute[] = [];
	let lastRoutedModel: string | undefined;
	let activeProvider: string | undefined;
	let isConnected = false;

	async function refreshWebRoutes(signal?: AbortSignal): Promise<NineRouterWebRoute[]> {
		const routes = await fetchWebRoutes(config, signal);
		discoveredWebRoutes = routes;
		return routes;
	}

	registerNineRouterWebTools(
		pi,
		() => config,
		() => discoveredWebRoutes,
	);

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

	try {
		await refreshWebRoutes();
	} catch (err) {
		console.error("[pi-9router-ext] Failed to discover web routes from 9router:", err);
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
				await refreshWebRoutes(ctx.signal).catch((err) => {
					console.error("[pi-9router-ext] Failed to refresh migrated web routes:", err);
				});
			} catch (err) {
				isConnected = false;
				console.error("[pi-9router-ext] Failed to refresh migrated config:", err);
			}
		}

		if (isConnected && discoveredModels.length > 0) {
			ctx.ui.notify(
				`9router connected — ${discoveredModels.length} models, ${routesByKind(discoveredWebRoutes, "webSearch").length} search routes, ${routesByKind(discoveredWebRoutes, "webFetch").length} fetch routes available`,
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
				`Reasoning:   ${config.enableReasoning ? "enabled (manual)" : "disabled"}`,
				`Connection:  ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
				`Models:      ${discoveredModels.length} available`,
				...webRoutesSummary(discoveredWebRoutes, config),
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
		description: "Configure 9router connection, reasoning, and web defaults",
		handler: async (_args, ctx) => {
			while (true) {
				const choice = await ctx.ui.select(
					"9router configuration",
					[
						"Connection",
						"Reasoning",
						"Web defaults",
						"View status/routes",
						"Done",
					],
				);
				if (!choice || choice === "Done") return;

				if (choice === "Connection") {
					const test = await testConnection(config, ctx.signal);
					const currentLines = [
						"Current connection:",
						`  Base URL: ${config.baseUrl}`,
						`  API Key:  ${config.apiKey ? maskApiKey(config.apiKey) : "not set"}`,
						`  Status:   ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
						"",
						"Enter new values (press Enter to keep current):",
					].join("\n");

					const newBaseUrl = await ctx.ui.input(currentLines, config.baseUrl);
					if (newBaseUrl === undefined) continue;

					const newApiKey = await ctx.ui.input(
						"API key (press Enter to keep current; type '-' to remove):",
						config.apiKey ? "current key hidden" : "API Key",
					);
					if (newApiKey === undefined) continue;

					const apiKeyInput = newApiKey.trim();
					config = {
						...config,
						baseUrl: normalizeBaseUrl(newBaseUrl.trim() || config.baseUrl),
						apiKey: apiKeyInput === "-"
							? undefined
							: apiKeyInput || config.apiKey,
					};
					persistConfig(pi, config);

					try {
						const models = await fetchModels(config, ctx.signal);
						discoveredModels = models;
						isConnected = true;
						registerNineRouterProvider(pi, config, models);
						await refreshWebRoutes(ctx.signal).catch((err) => {
							console.error("[pi-9router-ext] Failed to refresh web routes:", err);
						});
						ctx.ui.notify(`9router connection updated — ${models.length} models`, "info");
					} catch (err) {
						isConnected = false;
						unregisterNineRouterProvider(pi);
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to connect: ${msg}`, "error");
					}
				}

				if (choice === "Reasoning") {
					const reasoningChoice = await ctx.ui.select(
						`9router reasoning is currently ${config.enableReasoning ? "enabled" : "disabled"}. Enable only for routes/models that support reasoning.`,
						["Enable reasoning", "Disable reasoning"],
					);
					if (!reasoningChoice) continue;
					config = {
						...config,
						enableReasoning: reasoningChoice === "Enable reasoning",
					};
					persistConfig(pi, config);
					if (discoveredModels.length > 0) {
						registerNineRouterProvider(pi, config, discoveredModels);
					}
					ctx.ui.notify(`9router reasoning ${config.enableReasoning ? "enabled" : "disabled"}`, "info");
				}

				if (choice === "Web defaults") {
					try {
						await refreshWebRoutes(ctx.signal);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`Failed to refresh web routes: ${msg}`, "error");
						continue;
					}

					const searchRoutes = routesByKind(discoveredWebRoutes, "webSearch");
					const fetchRoutes = routesByKind(discoveredWebRoutes, "webFetch");

					if (searchRoutes.length > 0) {
						const searchOptions = ["Auto (first available)", ...searchRoutes.map((route) => route.id)];
						const searchChoice = await ctx.ui.select(
							`Default web search route (current: ${config.webSearchRoute || defaultRouteForKind(discoveredWebRoutes, "webSearch") || "auto"})`,
							searchOptions,
						);
						if (searchChoice) {
							config = {
								...config,
								webSearchRoute: searchChoice === "Auto (first available)" ? undefined : searchChoice,
							};
						}
					} else {
						ctx.ui.notify("No 9router web search routes discovered", "warning");
					}

					if (fetchRoutes.length > 0) {
						const fetchOptions = ["Auto (first available)", ...fetchRoutes.map((route) => route.id)];
						const fetchChoice = await ctx.ui.select(
							`Default web fetch route (current: ${config.webFetchRoute || defaultRouteForKind(discoveredWebRoutes, "webFetch") || "auto"})`,
							fetchOptions,
						);
						if (fetchChoice) {
							config = {
								...config,
								webFetchRoute: fetchChoice === "Auto (first available)" ? undefined : fetchChoice,
							};
						}
					} else {
						ctx.ui.notify("No 9router web fetch routes discovered", "warning");
					}

					persistConfig(pi, config);
					ctx.ui.notify(webRoutesSummary(discoveredWebRoutes, config).join("\n"), "info");
				}

				if (choice === "View status/routes") {
					const test = await testConnection(config, ctx.signal);
					const lines = [
						"🔗 9router Status",
						"",
						`Base URL:    ${config.baseUrl}`,
						`API Key:     ${config.apiKey ? maskApiKey(config.apiKey) : "not set"}`,
						`Reasoning:   ${config.enableReasoning ? "enabled" : "disabled"}`,
						`Connection:  ${test.ok ? "🟢 connected" : `🔴 ${test.error || "disconnected"}`}`,
						`Models:      ${discoveredModels.length} available`,
						...webRoutesSummary(discoveredWebRoutes, config),
						"",
						"Web search routes:",
						...routesByKind(discoveredWebRoutes, "webSearch").map((route) => `  - ${route.id}${route.owned_by === "combo" ? " (combo)" : ""}`),
						"Web fetch routes:",
						...routesByKind(discoveredWebRoutes, "webFetch").map((route) => `  - ${route.id}${route.owned_by === "combo" ? " (combo)" : ""}`),
					];
					ctx.ui.notify(lines.join("\n"), test.ok ? "info" : "warning");
				}
			}
		},
	});

	// ---------------------------------------------------------------------------
	// Command: /9router-reasoning
	// ---------------------------------------------------------------------------
	pi.registerCommand("9router-reasoning", {
		description: "Enable or disable Pi thinking levels for 9router models",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.select(
				`9router reasoning is currently ${config.enableReasoning ? "enabled" : "disabled"}. When enabled, Pi exposes thinking levels and sends reasoning_effort to 9router.`,
				[
					"Enable reasoning",
					"Disable reasoning",
				],
			);
			if (!choice) return;

			config = {
				...config,
				enableReasoning: choice === "Enable reasoning",
			};
			persistConfig(pi, config);

			if (discoveredModels.length > 0) {
				registerNineRouterProvider(pi, config, discoveredModels);
			}

			ctx.ui.notify(
				config.enableReasoning
					? "9router reasoning enabled. Use Pi's thinking controls (Shift+Tab or --thinking) to choose the level."
					: "9router reasoning disabled. 9router models will use thinking level off.",
				"info",
			);
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
				await refreshWebRoutes(ctx.signal).catch((err) => {
					console.error("[pi-9router-ext] Failed to reload web routes:", err);
				});

				ctx.ui.notify(
					`9router reloaded — ${models.length} models, ${routesByKind(discoveredWebRoutes, "webSearch").length} search routes, ${routesByKind(discoveredWebRoutes, "webFetch").length} fetch routes (${config.enableReasoning ? "reasoning enabled" : "reasoning disabled"})`,
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
							`Reasoning: ${config.enableReasoning ? "enabled" : "disabled"}`,
							`Total models: ${discoveredModels.length}`,
							`  Regular: ${regular.length}`,
							`  Combos:  ${combos.length}`,
							...webRoutesSummary(discoveredWebRoutes, config),
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
					enableReasoning: config.enableReasoning,
					modelCount: discoveredModels.length,
					regularCount: regular.length,
					comboCount: combos.length,
					webSearchRoutes: routesByKind(discoveredWebRoutes, "webSearch").map((route) => route.id),
					webFetchRoutes: routesByKind(discoveredWebRoutes, "webFetch").map((route) => route.id),
					webSearchRoute: config.webSearchRoute,
					webFetchRoute: config.webFetchRoute,
					lastRoutedModel,
					models: discoveredModels.map((m) => m.id),
				},
			};
		},
	});
}
