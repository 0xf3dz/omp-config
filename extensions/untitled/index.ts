import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const HOME = process.env.HOME ?? "";
const UNTITLED_RELAY_ENV = HOME ? `${HOME}/Library/Application Support/Untitled Router/config/relay.env` : "";
const DEFAULT_ROUTE_LOG = HOME ? `${HOME}/Library/Application Support/Untitled Router Data/subscription.jsonl` : "";
const ROUTE_LOG_PATH = resolveRouteLogPath();
const ROUTE_READ_LIMIT = 8 * 1024 * 1024;
const ROUTE_MATCH_WINDOW_MS = 120_000;
const STATUS_KEY = "untitled-metrics";
const DETAILS_KEY = "untitled-metrics-details";
const LONG_CONTEXT_THRESHOLD = 272_000;

interface ModelRate {
	input: number;
	cachedInput: number;
	output: number;
}

const MODEL_RATES: Record<string, ModelRate> = {
	"gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
	"gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
	"gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
};
const SOL_RATE = MODEL_RATES["gpt-5.6-sol"];

interface RouteEvent {
	eventId: string;
	model: string;
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	completedAt: number;
}

interface SessionMetrics {
	requests: number;
	pricedRequests: number;
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	routedCost: number;
	solEquivalentCost: number;
	models: Map<string, number>;
}

interface CalculatedMetrics {
	workloadSavingsPercent: number | null;
	capacityMultiplier: number | null;
}

interface AssistantUsage {
	inputTokens: number;
	cachedInputTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	completedAt: number;
	upstreamModel: string | null;
}

function emptySessionMetrics(): SessionMetrics {
	return {
		requests: 0,
		pricedRequests: 0,
		inputTokens: 0,
		cachedInputTokens: 0,
		cacheWriteTokens: 0,
		outputTokens: 0,
		reasoningTokens: 0,
		routedCost: 0,
		solEquivalentCost: 0,
		models: new Map(),
	};
}

function tokenValue(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
	return value;
}

function normalizeModel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().replace(/^openai\//, "");
	return normalized in MODEL_RATES ? normalized : null;
}

function assistantUsage(message: unknown): AssistantUsage | null {
	if (!message || typeof message !== "object") return null;
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant" || !record.usage || typeof record.usage !== "object") return null;
	const usage = record.usage as Record<string, unknown>;
	const inputTokens = tokenValue(usage.input);
	const cachedInputTokens = tokenValue(usage.cacheRead);
	const cacheWriteTokens = tokenValue(usage.cacheWrite);
	const outputTokens = tokenValue(usage.output);
	if (inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens === 0) return null;
	const timestamp = tokenValue(record.timestamp);
	const duration = tokenValue(record.duration);
	return {
		inputTokens,
		cachedInputTokens,
		cacheWriteTokens,
		outputTokens,
		reasoningTokens: tokenValue(usage.reasoningTokens),
		completedAt: timestamp + duration,
		upstreamModel: normalizeModel(record.upstreamModel),
	};
}

function decodeRelayEnvValue(raw: string): string {
	let value = raw.trim();
	if (
		value.length >= 2 &&
		((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
	) {
		value = value.slice(1, -1);
	}
	value = value.replace(/\\(.)/g, "$1");
	if (HOME && (value === "~" || value.startsWith("~/"))) value = `${HOME}${value.slice(1)}`;
	if (HOME && value.startsWith("${HOME}")) value = `${HOME}${value.slice(7)}`;
	if (HOME && value.startsWith("$HOME")) value = `${HOME}${value.slice(5)}`;
	return value;
}

async function resolveRouteLogPath(): Promise<string | null> {
	const inherited = process.env.UNTITLED_SUBSCRIPTION_LOCAL_LOG;
	if (inherited) return decodeRelayEnvValue(inherited);
	let configured = "";
	if (UNTITLED_RELAY_ENV) {
		const envFile = Bun.file(UNTITLED_RELAY_ENV);
		if (await envFile.exists()) {
			for (const line of (await envFile.text()).split("\n")) {
				const match = line.match(/^UNTITLED_SUBSCRIPTION_LOCAL_LOG=(.*)$/);
				if (match) configured = decodeRelayEnvValue(match[1] ?? "");
			}
		}
	}
	return configured || DEFAULT_ROUTE_LOG || null;
}

async function readRouteEvents(): Promise<RouteEvent[]> {
	const routeLog = await ROUTE_LOG_PATH;
	if (!routeLog) return [];
	const file = Bun.file(routeLog);
	if (!(await file.exists())) return [];
	const start = Math.max(0, file.size - ROUTE_READ_LIMIT);
	const lines = (await file.slice(start).text()).split("\n");
	const events: RouteEvent[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line) as Record<string, unknown>;
			const model = normalizeModel(record.actual_model ?? record.routed_model);
			const eventId = typeof record.event_id === "string" ? record.event_id : "";
			const completedAt = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
			if (
				record.http_status !== 200 ||
				record.event_kind !== "serving" ||
				!model ||
				!eventId ||
				!Number.isFinite(completedAt)
			) {
				continue;
			}
			events.push({
				eventId,
				model,
				inputTokens: tokenValue(record.input_tokens),
				cachedInputTokens: tokenValue(record.cached_input_tokens),
				outputTokens: tokenValue(record.output_tokens),
				completedAt,
			});
		} catch {
			continue;
		}
	}
	return events;
}

function matchRouteEvent(
	usage: AssistantUsage,
	events: RouteEvent[],
	usedEventIds: Set<string>,
): RouteEvent | null {
	const totalInputTokens = usage.inputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
	let match: RouteEvent | null = null;
	let smallestTimeDifference = Number.POSITIVE_INFINITY;
	for (const event of events) {
		if (
			usedEventIds.has(event.eventId) ||
			event.inputTokens !== totalInputTokens ||
			event.cachedInputTokens !== usage.cachedInputTokens ||
			event.outputTokens !== usage.outputTokens
		) {
			continue;
		}
		const timeDifference = Math.abs(event.completedAt - usage.completedAt);
		if (timeDifference <= ROUTE_MATCH_WINDOW_MS && timeDifference < smallestTimeDifference) {
			match = event;
			smallestTimeDifference = timeDifference;
		}
	}
	return match;
}

function requestCost(
	rate: ModelRate,
	inputTokens: number,
	cachedInputTokens: number,
	cacheWriteTokens: number,
	outputTokens: number,
): number {
	const totalInputTokens = inputTokens + cachedInputTokens + cacheWriteTokens;
	const inputMultiplier = totalInputTokens > LONG_CONTEXT_THRESHOLD ? 2 : 1;
	const outputMultiplier = totalInputTokens > LONG_CONTEXT_THRESHOLD ? 1.5 : 1;
	return (
		(inputTokens * rate.input * inputMultiplier +
			cachedInputTokens * rate.cachedInput * inputMultiplier +
			cacheWriteTokens * rate.input * 1.25 * inputMultiplier +
			outputTokens * rate.output * outputMultiplier) /
		1_000_000
	);
}

function recordAssistantMessage(
	metrics: SessionMetrics,
	message: unknown,
	events: RouteEvent[],
	usedEventIds: Set<string>,
): boolean {
	const usage = assistantUsage(message);
	if (!usage) return false;
	const matchedEvent = matchRouteEvent(usage, events, usedEventIds);
	const model = usage.upstreamModel ?? matchedEvent?.model ?? null;
	if (!model) return false;
	if (matchedEvent) usedEventIds.add(matchedEvent.eventId);

	metrics.requests += 1;
	metrics.inputTokens += usage.inputTokens;
	metrics.cachedInputTokens += usage.cachedInputTokens;
	metrics.cacheWriteTokens += usage.cacheWriteTokens;
	metrics.outputTokens += usage.outputTokens;
	metrics.reasoningTokens += usage.reasoningTokens;
	metrics.models.set(model, (metrics.models.get(model) ?? 0) + 1);

	const rate = MODEL_RATES[model];
	if (rate && SOL_RATE) {
		metrics.pricedRequests += 1;
		metrics.routedCost += requestCost(
			rate,
			usage.inputTokens,
			usage.cachedInputTokens,
			usage.cacheWriteTokens,
			usage.outputTokens,
		);
		metrics.solEquivalentCost += requestCost(
			SOL_RATE,
			usage.inputTokens,
			usage.cachedInputTokens,
			usage.cacheWriteTokens,
			usage.outputTokens,
		);
	}
	return true;
}

function calculate(metrics: SessionMetrics): CalculatedMetrics {
	if (
		metrics.requests === 0 ||
		metrics.pricedRequests !== metrics.requests ||
		metrics.solEquivalentCost <= 0 ||
		metrics.routedCost <= 0
	) {
		return { workloadSavingsPercent: null, capacityMultiplier: null };
	}
	const workloadSavingsPercent =
		((metrics.solEquivalentCost - metrics.routedCost) / metrics.solEquivalentCost) * 100;
	return {
		workloadSavingsPercent,
		capacityMultiplier: metrics.solEquivalentCost / metrics.routedCost,
	};
}

function percent(value: number | null): string {
	if (value === null) return "—";
	return `${value.toFixed(1)}%`;
}

function multiplier(value: number | null): string {
	if (value === null) return "—";
	return `${value.toFixed(2)}x`;
}

function modelSummary(metrics: SessionMetrics): string {
	if (metrics.models.size === 0) return "No Untitled requests yet";
	return [...metrics.models.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([model, count]) => `${model} × ${count.toLocaleString("en-US")}`)
		.join(", ");
}

function shortModel(metrics: SessionMetrics): string {
	if (metrics.models.size === 0) return "idle";
	if (metrics.models.size > 1) return "mixed";
	const model = metrics.models.keys().next().value as string;
	const short = model.replace(/^gpt-5\.6-/, "");
	return short.charAt(0).toUpperCase() + short.slice(1);
}

function detailLines(ctx: ExtensionContext, metrics: SessionMetrics): string[] {
	const calculated = calculate(metrics);
	return [
		ctx.ui.theme.fg("accent", "Untitled Auto session metrics"),
		`Models: ${modelSummary(metrics)}`,
		"Tokens saved: — (requires a paired Sol comparison)",
		`Workload usage saved: ${percent(calculated.workloadSavingsPercent)}`,
		`Estimated subscription extension: ${multiplier(calculated.capacityMultiplier)}`,
		`Session requests: ${metrics.requests.toLocaleString("en-US")}`,
		`Session tokens: ${metrics.inputTokens.toLocaleString("en-US")} input, ${metrics.cachedInputTokens.toLocaleString("en-US")} cached, ${metrics.cacheWriteTokens.toLocaleString("en-US")} cache write, ${metrics.outputTokens.toLocaleString("en-US")} output`,
		`Reasoning tokens: ${metrics.reasoningTokens.toLocaleString("en-US")}`,
		"Scope: current OMP session transcript",
	];
}

export default function untitledMetrics(pi: ExtensionAPI): void {
	let metrics = emptySessionMetrics();
	let usedEventIds = new Set<string>();
	let visible = true;
	let detailsVisible = false;

	function render(ctx: ExtensionContext): void {
		if (!visible) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			ctx.ui.setWidget(DETAILS_KEY, undefined);
			return;
		}
		const calculated = calculate(metrics);
		const status = [
			`UT ${shortModel(metrics)}`,
			`${metrics.requests.toLocaleString("en-US")}r`,
			percent(calculated.workloadSavingsPercent),
			multiplier(calculated.capacityMultiplier),
		].join(" ");
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", status));
		ctx.ui.setWidget(DETAILS_KEY, detailsVisible ? detailLines(ctx, metrics) : undefined);
	}

	async function loadSession(ctx: ExtensionContext): Promise<void> {
		metrics = emptySessionMetrics();
		usedEventIds = new Set();
		const events = await readRouteEvents();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message") recordAssistantMessage(metrics, entry.message, events, usedEventIds);
		}
		visible = true;
		detailsVisible = false;
		render(ctx);
	}

	pi.registerCommand("untitled", {
		description: "Toggle Untitled session metrics; use /untitled details for the panel",
		handler: (args, ctx) => {
			if (args.trim().toLowerCase() === "details") {
				visible = true;
				detailsVisible = !detailsVisible;
			} else {
				visible = !visible;
				if (!visible) detailsVisible = false;
			}
			render(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await loadSession(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		await loadSession(ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		const events = await readRouteEvents();
		if (recordAssistantMessage(metrics, event.message, events, usedEventIds)) render(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(DETAILS_KEY, undefined);
	});
}
