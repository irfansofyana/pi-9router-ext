import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type NineRouterWebKind = "webSearch" | "webFetch";

export interface NineRouterWebConfig {
	baseUrl: string;
	apiKey: string | undefined;
	webSearchRoute?: string;
	webFetchRoute?: string;
}

export interface NineRouterWebRoute {
	id: string;
	object: string;
	owned_by?: string;
	kind?: NineRouterWebKind | string;
}

interface NineRouterWebRoutesResponse {
	object: string;
	data: NineRouterWebRoute[];
}

interface SearchParams {
	query: string;
	route?: string;
	max_results?: number;
	search_type?: string;
	country?: string;
	language?: string;
	time_range?: string;
	offset?: number;
	domain_filter?: string[];
	content_options?: Record<string, unknown>;
	provider_options?: Record<string, unknown>;
}

interface FetchParams {
	url: string;
	route?: string;
	format?: string;
	max_characters?: number;
}

const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 20;
const DEFAULT_FETCH_CHARACTERS = 12000;
const MAX_FETCH_CHARACTERS = 50000;
const REQUEST_TIMEOUT_MS = 30_000;

function authHeaders(config: NineRouterWebConfig): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
	};
	if (config.apiKey) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	}
	return headers;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return {
		text: `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`,
		truncated: true,
	};
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	const text = await response.text();
	try {
		return JSON.parse(text);
	} catch {
		return { text };
	}
}

function createTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, timeoutMs);

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

async function postJson(
	config: NineRouterWebConfig,
	path: string,
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<unknown> {
	const response = await fetchWithTimeout(`${config.baseUrl}${path}`, {
		method: "POST",
		headers: authHeaders(config),
		body: JSON.stringify(body),
	}, signal);

	const payload = await parseJsonResponse(response);
	if (!response.ok) {
		const message = typeof payload === "object" && payload && "error" in payload
			? JSON.stringify((payload as { error: unknown }).error)
			: JSON.stringify(payload);
		throw new Error(`9router ${path} returned ${response.status}: ${message}`);
	}
	return payload;
}

export async function fetchWebRoutes(
	config: NineRouterWebConfig,
	signal?: AbortSignal,
): Promise<NineRouterWebRoute[]> {
	const response = await fetchWithTimeout(`${config.baseUrl}/v1/models/web`, {
		method: "GET",
		headers: authHeaders(config),
	}, signal);

	const payload = await parseJsonResponse(response);
	if (!response.ok) {
		throw new Error(`9router /v1/models/web returned ${response.status}: ${JSON.stringify(payload)}`);
	}

	const data = (payload as NineRouterWebRoutesResponse).data || [];
	return data.filter((route) => route.kind === "webSearch" || route.kind === "webFetch");
}

export function routesByKind(routes: NineRouterWebRoute[], kind: NineRouterWebKind): NineRouterWebRoute[] {
	return routes.filter((route) => route.kind === kind);
}

export function defaultRouteForKind(
	routes: NineRouterWebRoute[],
	kind: NineRouterWebKind,
	preferredRoute?: string,
): string | undefined {
	const compatible = routesByKind(routes, kind);
	if (preferredRoute && compatible.some((route) => route.id === preferredRoute)) {
		return preferredRoute;
	}
	return compatible[0]?.id;
}

export function routeMissing(
	routes: NineRouterWebRoute[],
	kind: NineRouterWebKind,
	preferredRoute?: string,
): boolean {
	if (!preferredRoute) return false;
	return !routesByKind(routes, kind).some((route) => route.id === preferredRoute);
}

function routeToApiModel(route: string, kind: NineRouterWebKind, routes: NineRouterWebRoute[]): string {
	const discovered = routes.find((entry) => entry.id === route && entry.kind === kind);
	if (discovered?.owned_by === "combo") return route;
	if (kind === "webSearch" && route.endsWith("/search")) return route.slice(0, -"/search".length);
	if (kind === "webFetch" && route.endsWith("/fetch")) return route.slice(0, -"/fetch".length);
	return route;
}

function resolveRoute(
	paramsRoute: string | undefined,
	defaultRoute: string | undefined,
	routes: NineRouterWebRoute[],
	kind: NineRouterWebKind,
): { route?: string; apiModel?: string; usingFallback: boolean; configuredMissing: boolean; overrideUnknown: boolean } {
	if (paramsRoute?.trim()) {
		const route = paramsRoute.trim();
		return {
			route,
			apiModel: routeToApiModel(route, kind, routes),
			usingFallback: false,
			configuredMissing: false,
			overrideUnknown: !routesByKind(routes, kind).some((entry) => entry.id === route),
		};
	}

	const compatibleRoutes = routesByKind(routes, kind);
	const route = compatibleRoutes.length === 0 && defaultRoute
		? defaultRoute
		: defaultRouteForKind(routes, kind, defaultRoute);
	return {
		route,
		apiModel: route ? routeToApiModel(route, kind, routes) : undefined,
		usingFallback: !!defaultRoute && route !== defaultRoute,
		configuredMissing: compatibleRoutes.length > 0 && routeMissing(routes, kind, defaultRoute),
		overrideUnknown: false,
	};
}

function resultUrl(result: Record<string, unknown>): string {
	return typeof result.url === "string" ? result.url : "";
}

function formatSearchResponse(query: string, route: string, payload: unknown): string {
	const response = payload as { results?: Record<string, unknown>[]; answer?: unknown; provider?: unknown; errors?: unknown[] };
	const results = Array.isArray(response.results) ? response.results : [];
	const lines = [
		`9router web search: ${query}`,
		`Route: ${route}${response.provider ? ` (provider: ${String(response.provider)})` : ""}`,
	];
	if (typeof response.answer === "string" && response.answer.trim()) {
		lines.push("", `Answer: ${response.answer.trim()}`);
	}
	if (results.length === 0) {
		lines.push("", "No results returned.");
	} else {
		lines.push("", "Results:");
		results.forEach((result, index) => {
			const title = typeof result.title === "string" ? result.title : "Untitled";
			const url = resultUrl(result);
			const snippet = typeof result.snippet === "string" ? result.snippet : "";
			lines.push(`${index + 1}. ${title}`);
			if (url) lines.push(`   ${url}`);
			if (snippet) lines.push(`   ${snippet}`);
		});
	}
	if (Array.isArray(response.errors) && response.errors.length > 0) {
		lines.push("", `Errors: ${JSON.stringify(response.errors)}`);
	}
	return lines.join("\n");
}

function formatFetchResponse(route: string, payload: unknown, maxCharacters: number): { text: string; truncated: boolean } {
	const response = payload as {
		url?: unknown;
		title?: unknown;
		provider?: unknown;
		content?: { text?: unknown; format?: unknown; length?: unknown };
	};
	const contentText = typeof response.content?.text === "string" ? response.content.text : "";
	const truncated = truncateText(contentText, maxCharacters);
	const lines = [
		`9router web fetch: ${typeof response.url === "string" ? response.url : ""}`,
		`Route: ${route}${response.provider ? ` (provider: ${String(response.provider)})` : ""}`,
	];
	if (typeof response.title === "string" && response.title.trim()) {
		lines.push(`Title: ${response.title.trim()}`);
	}
	if (response.content?.format) {
		lines.push(`Format: ${String(response.content.format)}`);
	}
	lines.push("", truncated.text || "No content returned.");
	return { text: lines.join("\n"), truncated: truncated.truncated };
}

export function webRoutesSummary(routes: NineRouterWebRoute[], config: NineRouterWebConfig): string[] {
	const searchRoutes = routesByKind(routes, "webSearch");
	const fetchRoutes = routesByKind(routes, "webFetch");
	const effectiveSearch = searchRoutes.length === 0 && config.webSearchRoute
		? config.webSearchRoute
		: defaultRouteForKind(routes, "webSearch", config.webSearchRoute);
	const effectiveFetch = fetchRoutes.length === 0 && config.webFetchRoute
		? config.webFetchRoute
		: defaultRouteForKind(routes, "webFetch", config.webFetchRoute);
	return [
		`Web routes:  ${searchRoutes.length} search, ${fetchRoutes.length} fetch`,
		`Search route: ${config.webSearchRoute || effectiveSearch || "not set"}${searchRoutes.length > 0 && routeMissing(routes, "webSearch", config.webSearchRoute) ? ` (missing, using ${effectiveSearch || "none"})` : ""}`,
		`Fetch route:  ${config.webFetchRoute || effectiveFetch || "not set"}${fetchRoutes.length > 0 && routeMissing(routes, "webFetch", config.webFetchRoute) ? ` (missing, using ${effectiveFetch || "none"})` : ""}`,
	];
}

export function registerNineRouterWebTools(
	pi: ExtensionAPI,
	getConfig: () => NineRouterWebConfig,
	getRoutes: () => NineRouterWebRoute[],
) {
	pi.registerTool({
		name: "ninerouter_web_search",
		label: "9router Web Search",
		description: "Search the web through your configured 9router instance. Sends the query to 9router and its upstream web-search provider or combo.",
		promptSnippet: "Search the web using 9router web search routes.",
		promptGuidelines: [
			"Use ninerouter_web_search when current or external web information is needed and the user has not requested a different web-search tool.",
			"The route parameter is optional; omit it to use the configured 9router default search route.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query." }),
			route: Type.Optional(Type.String({ description: "Optional 9router web search route, provider alias, or combo name. Examples: brave/search, tavily/search, my-search-combo." })),
			max_results: Type.Optional(Type.Number({ description: `Maximum results to return, capped at ${MAX_SEARCH_RESULTS}. Defaults to ${DEFAULT_SEARCH_RESULTS}.`, minimum: 1, maximum: MAX_SEARCH_RESULTS })),
			search_type: Type.Optional(Type.String({ description: "9router search_type, forwarded as-is. Examples depend on provider (web, news, images)." })),
			country: Type.Optional(Type.String({ description: "Optional country/region hint forwarded to 9router." })),
			language: Type.Optional(Type.String({ description: "Optional language hint forwarded to 9router, e.g. en." })),
			time_range: Type.Optional(Type.String({ description: "Optional recency filter forwarded to 9router, e.g. day, week, month, year." })),
			offset: Type.Optional(Type.Number({ description: "Optional result offset for providers that support pagination.", minimum: 0 })),
			domain_filter: Type.Optional(Type.Array(Type.String(), { description: "Optional domain filters. Some providers support negative entries like -example.com." })),
			content_options: Type.Optional(Type.Object({}, { description: "Advanced 9router content_options forwarded as-is.", additionalProperties: true })),
			provider_options: Type.Optional(Type.Object({}, { description: "Advanced provider_options forwarded as-is to 9router/upstream provider.", additionalProperties: true })),
		}),
		async execute(_toolCallId, params: SearchParams, signal, onUpdate) {
			const config = getConfig();
			const routes = getRoutes();
			const resolved = resolveRoute(params.route, config.webSearchRoute, routes, "webSearch");
			if (!resolved.route || !resolved.apiModel) {
				return {
					content: [{ type: "text", text: "No 9router web search route is configured or discovered. Open /9router-config and configure Web defaults after adding a web search provider/combo in 9router." }],
					details: { ok: false, reason: "no_web_search_route", routes },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Searching via 9router route ${resolved.route}...` }],
				details: { partial: true, route: resolved.route },
			});
			const maxResults = clampNumber(params.max_results, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS);
			const body: Record<string, unknown> = {
				model: resolved.apiModel,
				query: params.query,
				max_results: maxResults,
			};
			for (const key of ["search_type", "country", "language", "time_range", "offset", "domain_filter", "content_options", "provider_options"] as const) {
				if (params[key] !== undefined) body[key] = params[key];
			}

			const payload = await postJson(config, "/v1/search", body, signal);
			return {
				content: [{ type: "text", text: formatSearchResponse(params.query, resolved.route, payload) }],
				details: {
					ok: true,
					route: resolved.route,
					apiModel: resolved.apiModel,
					usingFallback: resolved.usingFallback,
					configuredMissing: resolved.configuredMissing,
					overrideUnknown: resolved.overrideUnknown,
					request: body,
					response: payload,
				},
			};
		},
	});

	pi.registerTool({
		name: "ninerouter_web_fetch",
		label: "9router Web Fetch",
		description: "Fetch and extract a URL through your configured 9router instance. Sends the URL to 9router and its upstream web-fetch provider or combo.",
		promptSnippet: "Fetch/extract URL content using 9router web fetch routes.",
		promptGuidelines: [
			"Use ninerouter_web_fetch when the user asks to read, fetch, extract, or summarize a specific URL through 9router.",
			"The route parameter is optional; omit it to use the configured 9router default fetch route.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch and extract." }),
			route: Type.Optional(Type.String({ description: "Optional 9router web fetch route, provider alias, or combo name. Examples: tavily/fetch, jina-reader/fetch, my-fetch-combo." })),
			format: Type.Optional(Type.String({ description: "Output format requested from 9router. Common values: markdown, text, html." })),
			max_characters: Type.Optional(Type.Number({ description: `Maximum characters to return, capped at ${MAX_FETCH_CHARACTERS}. Defaults to ${DEFAULT_FETCH_CHARACTERS}.`, minimum: 1, maximum: MAX_FETCH_CHARACTERS })),
		}),
		async execute(_toolCallId, params: FetchParams, signal, onUpdate) {
			const config = getConfig();
			const routes = getRoutes();
			const resolved = resolveRoute(params.route, config.webFetchRoute, routes, "webFetch");
			if (!resolved.route || !resolved.apiModel) {
				return {
					content: [{ type: "text", text: "No 9router web fetch route is configured or discovered. Open /9router-config and configure Web defaults after adding a web fetch provider/combo in 9router." }],
					details: { ok: false, reason: "no_web_fetch_route", routes },
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Fetching URL via 9router route ${resolved.route}...` }],
				details: { partial: true, route: resolved.route },
			});
			const maxCharacters = clampNumber(params.max_characters, DEFAULT_FETCH_CHARACTERS, 1, MAX_FETCH_CHARACTERS);
			const body: Record<string, unknown> = {
				model: resolved.apiModel,
				url: params.url,
				format: params.format || "markdown",
				max_characters: maxCharacters,
			};

			const payload = await postJson(config, "/v1/web/fetch", body, signal);
			const formatted = formatFetchResponse(resolved.route, payload, maxCharacters);
			return {
				content: [{ type: "text", text: formatted.text }],
				details: {
					ok: true,
					route: resolved.route,
					apiModel: resolved.apiModel,
					usingFallback: resolved.usingFallback,
					configuredMissing: resolved.configuredMissing,
					overrideUnknown: resolved.overrideUnknown,
					truncated: formatted.truncated,
					request: body,
					response: payload,
				},
			};
		},
	});
}
