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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
	contextWindow?: unknown;
	context_window?: unknown;
	contextLength?: unknown;
	context_length?: unknown;
	maxTokens?: unknown;
	max_tokens?: unknown;
	maxOutputTokens?: unknown;
	max_output_tokens?: unknown;
	maxCompletionTokens?: unknown;
	max_completion_tokens?: unknown;
	maxInputTokens?: unknown;
	max_input_tokens?: unknown;
	maxModelLen?: unknown;
	max_model_len?: unknown;
	metadata?: Record<string, unknown>;
	limits?: Record<string, unknown>;
	capabilities?: Record<string, unknown>;
	top_provider?: Record<string, unknown>;
	[key: string]: unknown;
}

interface NineRouterModelsResponse {
	object: string;
	data: NineRouterModel[];
}

interface ConfigIdentity {
	baseUrl: string;
	apiKeyHash: string;
}

interface NineRouterDiscoveryCache {
	baseUrl: string;
	apiKeyHash?: string;
	ts: number;
	models: NineRouterModel[];
	webRoutes?: NineRouterWebRoute[];
}

interface ModelMetadata {
	id: string;
	name?: string;
	reasoning?: unknown;
	modalities?: { input?: unknown; output?: unknown };
	limit?: { context?: unknown; output?: unknown };
	cost?: Record<string, unknown>;
	[key: string]: unknown;
}

type ModelMetadataApi = Record<string, { models?: Record<string, ModelMetadata> }>;
type ModelMetadataIndex = Map<string, ModelMetadata>;
type DiscoveryStatus = "idle" | "discovering" | "connected" | "not_configured" | "disconnected";

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_BASE_URL = "http://localhost:20128";
const ENV_BASE_URL = process.env.NINE_ROUTER_BASE_URL;
const ENV_API_KEY = process.env.NINE_ROUTER_API_KEY;
const ENV_ENABLE_REASONING = process.env.NINE_ROUTER_ENABLE_REASONING;
const CONFIG_PATH = join(homedir(), ".pi", "agent", "9router-config.json");
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi");
const MODEL_METADATA_CACHE_PATH = join(CACHE_DIR, "9router-model-metadata.json");
const DISCOVERY_CACHE_PATH = join(CACHE_DIR, "9router-discovery-cache.json");
const MODEL_METADATA_URL = "https://models.dev/api.json";
const MODEL_METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const STARTUP_DISCOVERY_TIMEOUT_MS = 5_000;

const CUSTOM_TYPE_CONFIG = "9router-config";
const CUSTOM_TYPE_LAST_ROUTE = "9router-last-route";
const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 4096;

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
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
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

function isCachedModel(value: unknown): value is NineRouterModel {
	return isRecord(value) && typeof value.id === "string" && value.id.trim().length > 0;
}

function apiKeyHash(apiKey: string | undefined): string {
	return apiKey
		? `sha256:${createHash("sha256").update(apiKey).digest("hex")}`
		: "none";
}

function configIdentity(config: NineRouterConfig): ConfigIdentity {
	return {
		baseUrl: config.baseUrl,
		apiKeyHash: apiKeyHash(config.apiKey),
	};
}

function sameConfigIdentity(identity: ConfigIdentity | undefined, config: NineRouterConfig): boolean {
	if (!identity) return false;
	const current = configIdentity(config);
	return identity.baseUrl === current.baseUrl && identity.apiKeyHash === current.apiKeyHash;
}

function cacheMatchesConfig(cache: Partial<NineRouterDiscoveryCache>, config: NineRouterConfig): boolean {
	if (normalizeBaseUrl(String(cache.baseUrl || "")) !== config.baseUrl) return false;
	// Legacy caches did not store a credential fingerprint. Trust them only for
	// unauthenticated routers; authenticated caches must be tied to the apiKey
	// hash so rotating/removing credentials does not reuse old verified models.
	if (typeof cache.apiKeyHash !== "string") return !config.apiKey;
	return cache.apiKeyHash === apiKeyHash(config.apiKey);
}

function readDiscoveryCache(config: NineRouterConfig): NineRouterDiscoveryCache | undefined {
	try {
		if (!existsSync(DISCOVERY_CACHE_PATH)) return undefined;
		const cache = JSON.parse(readFileSync(DISCOVERY_CACHE_PATH, "utf8")) as Partial<NineRouterDiscoveryCache>;
		if (!cacheMatchesConfig(cache, config)) return undefined;
		if (!Array.isArray(cache.models) || cache.models.length === 0) return undefined;
		return {
			baseUrl: config.baseUrl,
			apiKeyHash: apiKeyHash(config.apiKey),
			ts: typeof cache.ts === "number" ? cache.ts : 0,
			models: cache.models.filter(isCachedModel),
			webRoutes: Array.isArray(cache.webRoutes) ? cache.webRoutes : undefined,
		};
	} catch (err) {
		console.warn(`[pi-9router-ext] Failed to load discovery cache: ${errorMessage(err)}`);
		return undefined;
	}
}

function writeDiscoveryCache(
	config: NineRouterConfig,
	models: NineRouterModel[],
	webRoutes?: NineRouterWebRoute[],
) {
	if (models.length === 0) return;
	try {
		const existing = readDiscoveryCache(config);
		mkdirSync(dirname(DISCOVERY_CACHE_PATH), { recursive: true });
		writeFileSync(
			DISCOVERY_CACHE_PATH,
			`${JSON.stringify({
				baseUrl: config.baseUrl,
				apiKeyHash: apiKeyHash(config.apiKey),
				ts: Date.now(),
				models,
				webRoutes: webRoutes ?? existing?.webRoutes,
			}, null, 2)}\n`,
			{ mode: 0o600 },
		);
	} catch (err) {
		console.warn(`[pi-9router-ext] Failed to persist discovery cache: ${errorMessage(err)}`);
	}
}

function clearDiscoveryCache(config: NineRouterConfig) {
	try {
		if (!existsSync(DISCOVERY_CACHE_PATH)) return;
		const cache = JSON.parse(readFileSync(DISCOVERY_CACHE_PATH, "utf8")) as Partial<NineRouterDiscoveryCache>;
		if (cacheMatchesConfig(cache, config)) {
			unlinkSync(DISCOVERY_CACHE_PATH);
		}
	} catch (err) {
		console.warn(`[pi-9router-ext] Failed to clear discovery cache: ${errorMessage(err)}`);
	}
}

// =============================================================================
// Fetch Helpers
// =============================================================================

function createTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, timeoutMs);
	timer.unref?.();

	if (signal?.aborted) {
		abort();
	} else {
		signal?.addEventListener("abort", abort, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		},
	};
}

async function fetchWithTimeout(
	url: string,
	init: RequestInit = {},
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
	const timeout = createTimeoutSignal(signal, timeoutMs);
	try {
		return await fetch(url, { ...init, signal: timeout.signal });
	} finally {
		timeout.cleanup();
	}
}

async function fetchWithTimedBody<T>(
	url: string,
	init: RequestInit = {},
	signal: AbortSignal | undefined,
	timeoutMs: number,
	consume: (response: Response) => Promise<T>,
): Promise<T> {
	const timeout = createTimeoutSignal(signal, timeoutMs);
	try {
		const response = await fetch(url, { ...init, signal: timeout.signal });
		return await consume(response);
	} finally {
		timeout.cleanup();
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAuthError(err: unknown): boolean {
	const message = errorMessage(err).toLowerCase();
	return message.includes("401")
		|| message.includes("403")
		|| message.includes("unauthorized")
		|| message.includes("forbidden")
		|| message.includes("api key")
		|| message.includes("auth");
}

function connectionFailureStatus(err: unknown): DiscoveryStatus {
	return isAuthError(err) ? "not_configured" : "disconnected";
}

function conciseConnectionMessage(err: unknown): string {
	const message = errorMessage(err);
	if (isAuthError(err)) return `auth required (${message})`;
	return message;
}

function staleDiscoveryError(): Error {
	const err = new Error("stale discovery result");
	err.name = "StaleDiscoveryError";
	return err;
}

function isStaleDiscoveryError(err: unknown): boolean {
	return err instanceof Error && err.name === "StaleDiscoveryError";
}

// =============================================================================
// Model Metadata
// =============================================================================

function readMetadataCache(): { ts: number; data: unknown } | undefined {
	try {
		if (!existsSync(MODEL_METADATA_CACHE_PATH)) return undefined;
		const cache = JSON.parse(readFileSync(MODEL_METADATA_CACHE_PATH, "utf8")) as { ts?: unknown; data?: unknown };
		if (typeof cache.ts !== "number") return undefined;
		return { ts: cache.ts, data: cache.data };
	} catch {
		return undefined;
	}
}

function writeMetadataCache(data: unknown) {
	try {
		mkdirSync(dirname(MODEL_METADATA_CACHE_PATH), { recursive: true });
		writeFileSync(MODEL_METADATA_CACHE_PATH, JSON.stringify({ ts: Date.now(), data }), { mode: 0o600 });
	} catch (err) {
		console.error("[pi-9router-ext] Failed to persist model metadata cache:", err);
	}
}

function normalizeModelId(id: string): string {
	return id
		.toLowerCase()
		// Keep namespace colons such as `hf:org/model`; only strip known route variants.
		.replace(/:(free)$/i, "")
		.replace(/-\d{8}$/, "");
}

function hasColonNamespace(id: string): boolean {
	const colon = id.indexOf(":");
	if (colon < 0) return false;
	const slash = id.indexOf("/");
	return slash < 0 || colon < slash;
}

function stripModelPrefix(id: string): string {
	const slash = id.lastIndexOf("/");
	return slash >= 0 ? id.slice(slash + 1) : id;
}

function stripModelPrefixForLookup(id: string): string {
	return hasColonNamespace(id) ? id : stripModelPrefix(id);
}

function addMetadataIndexEntry(index: ModelMetadataIndex, key: string, model: ModelMetadata) {
	if (!key) return;
	if (!index.has(key)) index.set(key, model);
	const normalized = normalizeModelId(key);
	if (!index.has(normalized)) index.set(normalized, model);
}

function buildModelMetadataIndex(api: ModelMetadataApi): ModelMetadataIndex {
	const index: ModelMetadataIndex = new Map();
	for (const provider of Object.values(api)) {
		if (!provider?.models) continue;
		for (const [modelId, model] of Object.entries(provider.models)) {
			const indexedModel = { ...model, id: model.id || modelId };
			addMetadataIndexEntry(index, modelId, indexedModel);
			addMetadataIndexEntry(index, indexedModel.id, indexedModel);
			addMetadataIndexEntry(index, stripModelPrefixForLookup(modelId), indexedModel);
			addMetadataIndexEntry(index, stripModelPrefixForLookup(indexedModel.id), indexedModel);
		}
	}
	return index;
}

function lookupModelMetadata(id: string, index: ModelMetadataIndex): ModelMetadata | undefined {
	const stripped = stripModelPrefixForLookup(id);
	const candidates = [id, stripped, normalizeModelId(id), normalizeModelId(stripped)];
	for (const candidate of candidates) {
		const match = index.get(candidate);
		if (match) return match;
	}

	const normalized = normalizeModelId(stripped);
	for (const [key, model] of index) {
		const normalizedKey = normalizeModelId(key);
		if (normalizedKey.startsWith(normalized) || normalized.startsWith(normalizedKey)) {
			return model;
		}
	}
	return undefined;
}

function readCachedModelMetadataIndex(): ModelMetadataIndex {
	const cached = readMetadataCache();
	return cached ? buildModelMetadataIndex((cached.data as ModelMetadataApi) || {}) : new Map();
}

async function fetchModelMetadataIndex(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ModelMetadataIndex> {
	const cached = readMetadataCache();
	if (cached && Date.now() - cached.ts < MODEL_METADATA_TTL_MS) {
		return buildModelMetadataIndex((cached.data as ModelMetadataApi) || {});
	}

	try {
		const payload = await fetchWithTimedBody(
			MODEL_METADATA_URL,
			{ method: "GET", headers: { Accept: "application/json" } },
			signal,
			timeoutMs,
			async (response) => {
				if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
				return (await response.json()) as ModelMetadataApi;
			},
		);
		writeMetadataCache(payload);
		return buildModelMetadataIndex(payload);
	} catch (err) {
		if (cached) {
			console.warn(`[pi-9router-ext] Failed to refresh model metadata, using stale cache: ${errorMessage(err)}`);
			return buildModelMetadataIndex((cached.data as ModelMetadataApi) || {});
		}
		console.warn(`[pi-9router-ext] Failed to fetch model metadata: ${errorMessage(err)}`);
		return new Map();
	}
}

// =============================================================================
// 9router API Client
// =============================================================================

async function fetchModels(
	config: NineRouterConfig,
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<NineRouterModel[]> {
	const headers: Record<string, string> = {
		Accept: "application/json",
	};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}

	return await fetchWithTimedBody(
		`${config.baseUrl}/v1/models`,
		{
			method: "GET",
			headers,
		},
		signal,
		timeoutMs,
		async (response) => {
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(
					`9router returned ${response.status}: ${text || response.statusText}`,
				);
			}

			const payload = (await response.json()) as NineRouterModelsResponse;
			return payload.data || [];
		},
	);
}

async function testConnection(
	config: NineRouterConfig,
	signal?: AbortSignal,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const headers: Record<string, string> = {};
		if (config.apiKey) {
			headers.Authorization = `Bearer ${config.apiKey}`;
		}

		return await fetchWithTimedBody(
			`${config.baseUrl}/v1/models`,
			{
				method: "GET",
				headers,
			},
			signal,
			timeoutMs,
			async (response) => {
				const text = await response.text().catch(() => "");
				if (response.ok) {
					return { ok: true };
				}
				return { ok: false, error: `HTTP ${response.status}: ${text || response.statusText}` };
			},
		);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

// =============================================================================
// Model Mapping
// =============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTokenCount(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	if (typeof value !== "string") return undefined;

	const normalized = value.trim().replace(/,/g, "").toLowerCase();
	const match = normalized.match(/^(\d+(?:\.\d+)?)([km])?$/);
	if (!match) return undefined;

	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount <= 0) return undefined;
	const multiplier = match[2] === "m" ? 1_000_000 : match[2] === "k" ? 1_000 : 1;
	return Math.floor(amount * multiplier);
}

function readPath(record: Record<string, unknown>, path: readonly string[]): unknown {
	let current: unknown = record;
	for (const segment of path) {
		if (!isRecord(current)) return undefined;
		current = current[segment];
	}
	return current;
}

function firstTokenCount(record: Record<string, unknown>, paths: readonly (readonly string[])[]): number | undefined {
	for (const path of paths) {
		const value = readPath(record, path);
		const parsed = parseTokenCount(value);
		if (parsed !== undefined) return parsed;
	}
	return undefined;
}

type LimitSource = "router" | "metadata" | "fallback";

interface LimitInfo {
	value: number;
	source: LimitSource;
}

const ROUTER_CONTEXT_PATHS = [
	["contextWindow"],
	["context_window"],
	["contextLength"],
	["context_length"],
	["maxContextWindow"],
	["max_context_window"],
	["maxContextLength"],
	["max_context_length"],
	["maxInputTokens"],
	["max_input_tokens"],
	["maxModelLen"],
	["max_model_len"],
	["inputTokenLimit"],
	["input_token_limit"],
	["totalTokenLimit"],
	["total_token_limit"],
	["tokenLimit"],
	["token_limit"],
	["n_ctx"],
	["ctx_size"],
	["top_provider", "context_length"],
	["metadata", "contextWindow"],
	["metadata", "context_window"],
	["metadata", "context_length"],
	["metadata", "maxInputTokens"],
	["metadata", "max_input_tokens"],
	["metadata", "maxModelLen"],
	["metadata", "max_model_len"],
	["limits", "contextWindow"],
	["limits", "context_window"],
	["limits", "context_length"],
	["limits", "maxInputTokens"],
	["limits", "max_input_tokens"],
	["limits", "maxModelLen"],
	["limits", "max_model_len"],
	["capabilities", "contextWindow"],
	["capabilities", "context_window"],
	["capabilities", "context_length"],
	["capabilities", "maxInputTokens"],
	["capabilities", "max_input_tokens"],
	["capabilities", "maxModelLen"],
	["capabilities", "max_model_len"],
] as const;

const ROUTER_OUTPUT_PATHS = [
	["maxOutputTokens"],
	["max_output_tokens"],
	["maxCompletionTokens"],
	["max_completion_tokens"],
	["outputTokenLimit"],
	["output_token_limit"],
	["maxNewTokens"],
	["max_new_tokens"],
	["n_predict"],
	["top_provider", "max_completion_tokens"],
	["metadata", "maxOutputTokens"],
	["metadata", "max_output_tokens"],
	["metadata", "maxCompletionTokens"],
	["metadata", "max_completion_tokens"],
	["metadata", "maxNewTokens"],
	["metadata", "max_new_tokens"],
	["limits", "maxOutputTokens"],
	["limits", "max_output_tokens"],
	["limits", "maxCompletionTokens"],
	["limits", "max_completion_tokens"],
	["limits", "maxNewTokens"],
	["limits", "max_new_tokens"],
	["capabilities", "maxOutputTokens"],
	["capabilities", "max_output_tokens"],
	["capabilities", "maxCompletionTokens"],
	["capabilities", "max_completion_tokens"],
	["capabilities", "maxNewTokens"],
	["capabilities", "max_new_tokens"],
	["maxTokens"],
	["max_tokens"],
	["metadata", "maxTokens"],
	["metadata", "max_tokens"],
	["limits", "maxTokens"],
	["limits", "max_tokens"],
	["capabilities", "maxTokens"],
	["capabilities", "max_tokens"],
] as const;

const METADATA_CONTEXT_PATHS = [
	["limit", "context"],
	["limits", "context"],
	["contextWindow"],
	["context_window"],
	["contextLength"],
	["context_length"],
	["maxInputTokens"],
	["max_input_tokens"],
] as const;

const METADATA_OUTPUT_PATHS = [
	["limit", "output"],
	["limits", "output"],
	["maxOutputTokens"],
	["max_output_tokens"],
	["maxCompletionTokens"],
	["max_completion_tokens"],
	["maxTokens"],
	["max_tokens"],
] as const;

function modelContextWindowInfo(model: NineRouterModel, metadata?: ModelMetadata): LimitInfo {
	const routerValue = firstTokenCount(model, ROUTER_CONTEXT_PATHS);
	if (routerValue !== undefined) return { value: routerValue, source: "router" };

	const metadataValue = metadata ? firstTokenCount(metadata, METADATA_CONTEXT_PATHS) : undefined;
	if (metadataValue !== undefined) return { value: metadataValue, source: "metadata" };

	return { value: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
}

function modelMaxTokensInfo(model: NineRouterModel, metadata: ModelMetadata | undefined, contextWindow: number): LimitInfo {
	const routerValue = firstTokenCount(model, ROUTER_OUTPUT_PATHS);
	if (routerValue !== undefined) return { value: Math.min(routerValue, contextWindow), source: "router" };

	const metadataValue = metadata ? firstTokenCount(metadata, METADATA_OUTPUT_PATHS) : undefined;
	if (metadataValue !== undefined) return { value: Math.min(metadataValue, contextWindow), source: "metadata" };

	return { value: Math.min(FALLBACK_MAX_TOKENS, contextWindow), source: "fallback" };
}

function modelContextWindow(model: NineRouterModel, metadata?: ModelMetadata): number {
	return modelContextWindowInfo(model, metadata).value;
}

function modelMaxTokens(model: NineRouterModel, metadata?: ModelMetadata, contextWindow = modelContextWindow(model, metadata)): number {
	return modelMaxTokensInfo(model, metadata, contextWindow).value;
}

function modelInputTypes(metadata?: ModelMetadata): ("text" | "image")[] {
	const input = metadata?.modalities?.input;
	if (Array.isArray(input)) {
		const types = input.filter((item): item is "text" | "image" => item === "text" || item === "image");
		if (types.length > 0) return types;
	}
	return ["text"];
}

function formatTokenCount(tokens: number): string {
	return tokens >= 1000 && tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens);
}

function modelLimitSummary(model: NineRouterModel, metadata?: ModelMetadata): string {
	const context = modelContextWindowInfo(model, metadata);
	const output = modelMaxTokensInfo(model, metadata, context.value);
	return `${formatTokenCount(context.value)} ctx / ${formatTokenCount(output.value)} out (${context.source}/${output.source})`;
}

function mapNineRouterModel(model: NineRouterModel, enableReasoning: boolean, metadata?: ModelMetadata) {
	const isCombo = model.owned_by === "combo";
	const contextWindow = modelContextWindow(model, metadata);
	const maxTokens = modelMaxTokens(model, metadata, contextWindow);

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
		input: modelInputTypes(metadata),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
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
	metadataIndex: ModelMetadataIndex,
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
		models: models.map((model) => mapNineRouterModel(
			model,
			config.enableReasoning,
			lookupModelMetadata(model.id, metadataIndex),
		)),
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
	let modelMetadataIndex: ModelMetadataIndex = new Map();
	let discoveredWebRoutes: NineRouterWebRoute[] = [];
	let discoveredWebRoutesIdentity: ConfigIdentity | undefined;
	let lastRoutedModel: string | undefined;
	let activeProvider: string | undefined;
	let isConnected = false;
	let discoveryStatus: DiscoveryStatus = "idle";
	let lastDiscoveryError: string | undefined;
	let isDiscovering = false;
	let providerRegistration: { baseUrl: string; apiKey: string | undefined } | undefined;
	let discoveryGeneration = 0;
	let webRouteGeneration = 0;

	function beginDiscovery() {
		discoveryGeneration += 1;
		webRouteGeneration += 1;
		if (!sameConfigIdentity(discoveredWebRoutesIdentity, config)) {
			discoveredWebRoutes = [];
			discoveredWebRoutesIdentity = undefined;
		}
		isDiscovering = true;
		discoveryStatus = "discovering";
		return {
			generation: discoveryGeneration,
			config: { ...config },
		};
	}

	function setProviderRegistration(discoveryConfig: NineRouterConfig) {
		providerRegistration = {
			baseUrl: discoveryConfig.baseUrl,
			apiKey: discoveryConfig.apiKey,
		};
	}

	function beginWebRouteRefresh(discoveryConfig: NineRouterConfig = config) {
		webRouteGeneration += 1;
		return {
			generation: webRouteGeneration,
			config: { ...discoveryConfig },
		};
	}

	function isCurrentDiscovery(generation: number): boolean {
		return generation === discoveryGeneration;
	}

	function isCurrentWebRouteRefresh(generation: number): boolean {
		return generation === webRouteGeneration;
	}

	function finishDiscovery(generation: number) {
		if (isCurrentDiscovery(generation)) {
			isDiscovering = false;
		}
	}

	function markDiscoveryFailure(err: unknown, context: string, generation: number) {
		if (!isCurrentDiscovery(generation)) return;
		isConnected = false;
		discoveryStatus = connectionFailureStatus(err);
		lastDiscoveryError = conciseConnectionMessage(err);
		// Auth failures mean the current credential is known unusable, even if it
		// matches a cached or previously successful registration. Do not keep
		// offering scoped 9router models backed by credentials the router rejects.
		// Non-auth failures keep the previous provider only when the baseUrl/apiKey
		// identity did not change, so transient outages do not break saved scopes.
		const authFailure = isAuthError(err);
		const registrationChanged = !providerRegistration
			|| providerRegistration.baseUrl !== config.baseUrl
			|| providerRegistration.apiKey !== config.apiKey;
		if (authFailure || discoveredModels.length === 0 || registrationChanged) {
			unregisterNineRouterProvider(pi);
			providerRegistration = undefined;
			if (authFailure) {
				discoveredModels = [];
				modelMetadataIndex = new Map();
				discoveredWebRoutes = [];
				discoveredWebRoutesIdentity = undefined;
				clearDiscoveryCache(config);
			}
		}
		console.warn(`[pi-9router-ext] ${context}: ${lastDiscoveryError}`);
	}

	async function refreshWebRoutes(discoveryConfig: NineRouterConfig, generation: number, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<NineRouterWebRoute[]> {
		const routes = await fetchWebRoutes(discoveryConfig, signal, timeoutMs);
		if (isCurrentWebRouteRefresh(generation)) {
			discoveredWebRoutes = routes;
			discoveredWebRoutesIdentity = configIdentity(discoveryConfig);
			writeDiscoveryCache(discoveryConfig, discoveredModels, routes);
		}
		return routes;
	}

	async function refreshModels(discoveryConfig: NineRouterConfig, generation: number, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<NineRouterModel[]> {
		try {
			const [models, metadataIndex] = await Promise.all([
				fetchModels(discoveryConfig, signal, timeoutMs),
				fetchModelMetadataIndex(signal, timeoutMs),
			]);
			if (models.length === 0) {
				throw new Error("no models returned by /v1/models");
			}
			if (!isCurrentDiscovery(generation)) {
				throw staleDiscoveryError();
			}
			discoveredModels = models;
			modelMetadataIndex = metadataIndex;
			isConnected = true;
			discoveryStatus = "connected";
			lastDiscoveryError = undefined;
			registerNineRouterProvider(pi, { ...discoveryConfig, enableReasoning: config.enableReasoning }, models, metadataIndex);
			setProviderRegistration(discoveryConfig);
			writeDiscoveryCache(
				discoveryConfig,
				models,
				sameConfigIdentity(discoveredWebRoutesIdentity, discoveryConfig) ? discoveredWebRoutes : undefined,
			);
			return models;
		} finally {
			finishDiscovery(generation);
		}
	}

	function startBackgroundDiscovery(reason: string) {
		const discovery = beginDiscovery();
		void (async () => {
			try {
				await refreshModels(discovery.config, discovery.generation, undefined, STARTUP_DISCOVERY_TIMEOUT_MS);
			} catch (err) {
				if (isStaleDiscoveryError(err)) return;
				markDiscoveryFailure(err, `${reason} model discovery skipped`, discovery.generation);
				return;
			}

			const webRefresh = beginWebRouteRefresh(discovery.config);
			try {
				await refreshWebRoutes(webRefresh.config, webRefresh.generation, undefined, STARTUP_DISCOVERY_TIMEOUT_MS);
			} catch (err) {
				if (isCurrentWebRouteRefresh(webRefresh.generation)) {
					console.warn(`[pi-9router-ext] ${reason} web route discovery skipped: ${conciseConnectionMessage(err)}`);
				}
			}
		})();
	}

	function discoveryStatusLine(): string {
		if (isDiscovering) return "discovering";
		if (discoveryStatus === "connected") return "connected";
		if (discoveryStatus === "not_configured") return `not configured${lastDiscoveryError ? ` — ${lastDiscoveryError}` : ""}`;
		if (discoveryStatus === "disconnected") return `disconnected${lastDiscoveryError ? ` — ${lastDiscoveryError}` : ""}`;
		return "idle";
	}

	registerNineRouterWebTools(
		pi,
		() => config,
		() => discoveredWebRoutes,
	);

	const cachedDiscovery = readDiscoveryCache(config);
	if (cachedDiscovery && cachedDiscovery.models.length > 0) {
		discoveredModels = cachedDiscovery.models;
		discoveredWebRoutes = cachedDiscovery.webRoutes ?? [];
		discoveredWebRoutesIdentity = Array.isArray(cachedDiscovery.webRoutes) ? configIdentity(config) : undefined;
		modelMetadataIndex = readCachedModelMetadataIndex();
		registerNineRouterProvider(pi, config, discoveredModels, modelMetadataIndex);
		setProviderRegistration(config);
		startBackgroundDiscovery("startup");
	} else {
		const discovery = beginDiscovery();
		try {
			await refreshModels(discovery.config, discovery.generation, undefined, STARTUP_DISCOVERY_TIMEOUT_MS);
			const webRefresh = beginWebRouteRefresh(discovery.config);
			void refreshWebRoutes(webRefresh.config, webRefresh.generation, undefined, STARTUP_DISCOVERY_TIMEOUT_MS).catch((err) => {
				if (isCurrentWebRouteRefresh(webRefresh.generation)) {
					console.warn(`[pi-9router-ext] startup web route discovery skipped: ${conciseConnectionMessage(err)}`);
				}
			});
		} catch (err) {
			if (!isStaleDiscoveryError(err)) {
				markDiscoveryFailure(err, "startup model discovery skipped", discovery.generation);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Models are registered before Pi resolves saved scoped models. Cached models
	// keep startup fast; first run waits briefly so Ctrl+S scopes can persist.
	// ---------------------------------------------------------------------------

	// ---------------------------------------------------------------------------
	// Session start: rehydrate config from session
	// ---------------------------------------------------------------------------
	pi.on("session_start", async (_event, ctx) => {
		const restored = loadConfigFromSession(ctx);
		if (!loadConfigFromDisk() && restored) {
			// Migrate old session-persisted config to the new user-wide config file.
			config = restored;
			persistConfig(pi, config);
			startBackgroundDiscovery("migrated config");
		}

		if (isConnected && discoveredModels.length > 0) {
			ctx.ui.notify(
				`9router connected — ${discoveredModels.length} models, ${routesByKind(discoveredWebRoutes, "webSearch").length} search routes, ${routesByKind(discoveredWebRoutes, "webFetch").length} fetch routes available`,
				"info",
			);
		} else if (isDiscovering) {
			ctx.ui.notify("9router discovery running in background", "info");
		} else {
			ctx.ui.notify(
				`9router ${discoveryStatusLine()} — use /9router-config to configure or /9router-reload to retry`,
				discoveryStatus === "not_configured" ? "warning" : "info",
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
				`Discovery:   ${discoveryStatusLine()}`,
				`Models:      ${discoveredModels.length} available`,
				`Metadata:    ${modelMetadataIndex.size > 0 ? `${modelMetadataIndex.size} index keys cached` : "unavailable"}`,
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
				const metadata = lookupModelMetadata(m.id, modelMetadataIndex);
				return {
					value: m.id,
					label: `${isCombo ? `🔀 ${m.id}` : m.id} (${modelLimitSummary(m, metadata)})`,
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

					const discovery = beginDiscovery();
					try {
						const models = await refreshModels(discovery.config, discovery.generation, ctx.signal);
						const webRefresh = beginWebRouteRefresh(discovery.config);
						await refreshWebRoutes(webRefresh.config, webRefresh.generation, ctx.signal).catch((err) => {
							if (isCurrentWebRouteRefresh(webRefresh.generation)) {
								console.warn(`[pi-9router-ext] Failed to refresh web routes: ${conciseConnectionMessage(err)}`);
							}
						});
						ctx.ui.notify(`9router connection updated — ${models.length} models`, "info");
					} catch (err) {
						if (isStaleDiscoveryError(err)) continue;
						markDiscoveryFailure(err, "connection update failed", discovery.generation);
						ctx.ui.notify(`Failed to connect: ${discoveryStatusLine()}`, isAuthError(err) ? "warning" : "error");
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
						registerNineRouterProvider(pi, config, discoveredModels, modelMetadataIndex);
						setProviderRegistration(config);
					}
					ctx.ui.notify(`9router reasoning ${config.enableReasoning ? "enabled" : "disabled"}`, "info");
				}

				if (choice === "Web defaults") {
					const webRefresh = beginWebRouteRefresh();
					try {
						await refreshWebRoutes(webRefresh.config, webRefresh.generation, ctx.signal);
					} catch (err) {
						ctx.ui.notify(`Failed to refresh web routes: ${conciseConnectionMessage(err)}`, isAuthError(err) ? "warning" : "error");
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
						`Discovery:   ${discoveryStatusLine()}`,
						`Models:      ${discoveredModels.length} available`,
						`Metadata:    ${modelMetadataIndex.size > 0 ? `${modelMetadataIndex.size} index keys cached` : "unavailable"}`,
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
				registerNineRouterProvider(pi, config, discoveredModels, modelMetadataIndex);
				setProviderRegistration(config);
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
			const discovery = beginDiscovery();
			try {
				const models = await refreshModels(discovery.config, discovery.generation, ctx.signal);

				const webRefresh = beginWebRouteRefresh(discovery.config);
				await refreshWebRoutes(webRefresh.config, webRefresh.generation, ctx.signal).catch((err) => {
					if (isCurrentWebRouteRefresh(webRefresh.generation)) {
						console.warn(`[pi-9router-ext] Failed to reload web routes: ${conciseConnectionMessage(err)}`);
					}
				});

				ctx.ui.notify(
					`9router reloaded — ${models.length} models, ${routesByKind(discoveredWebRoutes, "webSearch").length} search routes, ${routesByKind(discoveredWebRoutes, "webFetch").length} fetch routes (${config.enableReasoning ? "reasoning enabled" : "reasoning disabled"})`,
					"info",
				);
			} catch (err) {
				if (isStaleDiscoveryError(err)) return;
				markDiscoveryFailure(err, "reload failed", discovery.generation);
				ctx.ui.notify(`Reload failed: ${discoveryStatusLine()}`, isAuthError(err) ? "warning" : "error");
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
							`Discovery: ${discoveryStatusLine()}`,
							`Total models: ${discoveredModels.length}`,
							`  Regular: ${regular.length}`,
							`  Combos:  ${combos.length}`,
							`Metadata: ${modelMetadataIndex.size > 0 ? `${modelMetadataIndex.size} index keys cached` : "unavailable"}`,
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
					discoveryStatus,
					isDiscovering,
					lastDiscoveryError,
					baseUrl: config.baseUrl,
					enableReasoning: config.enableReasoning,
					modelCount: discoveredModels.length,
					regularCount: regular.length,
					comboCount: combos.length,
					metadataIndexSize: modelMetadataIndex.size,
					modelLimits: discoveredModels.map((model) => {
						const metadata = lookupModelMetadata(model.id, modelMetadataIndex);
						const context = modelContextWindowInfo(model, metadata);
						const output = modelMaxTokensInfo(model, metadata, context.value);
						return {
							id: model.id,
							contextWindow: context.value,
							contextWindowSource: context.source,
							maxTokens: output.value,
							maxTokensSource: output.source,
						};
					}),
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
