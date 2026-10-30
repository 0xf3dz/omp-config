import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const HOME = process.env.HOME ?? "";
const UNTITLED_RELAY_ENV = HOME ? `${HOME}/Library/Application Support/Untitled Router/config/relay.env` : "";
const DEFAULT_ROUTE_LOG = HOME ? `${HOME}/Library/Application Support/Untitled Router Data/subscription.jsonl` : "";
const ROUTE_LOG_PATH = resolveRouteLogPath();
const ROUTE_READ_LIMIT = 8 * 1024 * 1024;
const ROUTE_MATCH_WINDOW_MS = 120_000;
const STATUS_KEY = "untitled-metrics";
const DETAILS_KEY = "untitled-metrics-details";
const OUTPUT_KEY = "untitled-output-model";
const RUN_KEY = "untitled-run-model";
const UNKNOWN_MODEL = "unknown";
const UNKNOWN_LABEL = "unknown actual model";
const SETTLE_DELAY_MS = 1_500;
const FLUSH_RETRY_MS = 250;
const RESOLVE_ATTEMPTS = 6;
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

interface RunOutput {
	key: string;
	model: string | null;
	tools: string[];
}

interface RunSummary {
	key: string;
	outputs: RunOutput[];
}

function modelIdentity(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const model = value.trim().replace(/[\u0000-\u001f\u007f]/g, "");
	if (!model || /(^|[/:_-])(untitled|router|auto)($|[/:_-])/i.test(model)) return null;
	return model;
}

function isUntitled(message: Record<string, unknown>): boolean {
	return [message.model, message.provider].some(value => typeof value === "string" && /untitled/i.test(value)) ||
		normalizeModel(message.upstreamModel) !== null;
}

function outputKey(message: Record<string, unknown>): string {
	return Bun.hash(JSON.stringify([
		message.provider, message.model, message.timestamp, message.responseId, message.content,
	])).toString(16);
}

function joinCounts(counts: Map<string, number>, fallback: string): string {
	if (counts.size === 0) return fallback;
	return [...counts.entries()]
		.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
		.map(([name, count]) => `${name} ×${count}`)
		.join(", ");
}

function countBy(values: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

function runLine(run: RunSummary): string {
	if (run.outputs.length === 0) return "Untitled run: no routed output";
	const models = countBy(run.outputs.map(output => output.model ?? UNKNOWN_MODEL));
	const parts = [...models].map(([model, count]) => {
		const outputs = run.outputs.filter(output => (output.model ?? UNKNOWN_MODEL) === model);
		const tools = joinCounts(countBy(outputs.flatMap(output => output.tools)), "");
		return `${model} ×${count} for ${count === 1 ? "1 turn" : `${count} turns`}${tools ? ` for ${tools}` : ""}`;
	});
	return `Untitled routed to ${parts.join(", ")}`;
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
		upstreamModel: modelIdentity(record.upstreamModel),
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
			const model = modelIdentity(record.actual_model) ?? modelIdentity(record.routed_model);
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
	const models = new Set<string>();
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
		if (timeDifference > ROUTE_MATCH_WINDOW_MS) continue;
		models.add(event.model);
		if (timeDifference < smallestTimeDifference) {
			match = event;
			smallestTimeDifference = timeDifference;
		}
	}
	return models.size === 1 ? match : null;
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
	model: string | null,
): boolean {
	const usage = assistantUsage(message);
	if (!usage) return false;
	const label = model ?? UNKNOWN_LABEL;
	metrics.requests += 1;
	metrics.inputTokens += usage.inputTokens;
	metrics.cachedInputTokens += usage.cachedInputTokens;
	metrics.cacheWriteTokens += usage.cacheWriteTokens;
	metrics.outputTokens += usage.outputTokens;
	metrics.reasoningTokens += usage.reasoningTokens;
	metrics.models.set(label, (metrics.models.get(label) ?? 0) + 1);

	const rate = model ? MODEL_RATES[normalizeModel(model) ?? ""] : undefined;
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

function relabelAssistantMessage(metrics: SessionMetrics, usage: AssistantUsage, model: string): void {
	const count = metrics.models.get(UNKNOWN_LABEL) ?? 0;
	if (count <= 1) metrics.models.delete(UNKNOWN_LABEL);
	else metrics.models.set(UNKNOWN_LABEL, count - 1);
	metrics.models.set(model, (metrics.models.get(model) ?? 0) + 1);
	const rate = MODEL_RATES[normalizeModel(model) ?? ""];
	if (!rate || !SOL_RATE) return;
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
	const leaf = model.split("/").pop() ?? model;
	const short = leaf.replace(/^(gpt-5\.6-|deepseek-)/i, "");
	const capped = short.length > 18 ? `${short.slice(0, 17)}…` : short;
	return capped.charAt(0).toUpperCase() + capped.slice(1);
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
	let routeEvents: RouteEvent[] = [];
	let visible = true;
	let detailsVisible = false;
	let seen = new Set<string>();
	let runs = new Map<string, RunSummary>();
	let currentRun: RunSummary | null = null;
	let pendingRuns = new Set<string>();
	let pendingUsage = new Map<string, AssistantUsage>();
	let sealed = false;
	let hiddenRuns = new Map<string, number>();
	pi.registerMessageRenderer(RUN_KEY, (message, _options, theme) => {
		const run = message.details as RunSummary | undefined;
		if (run && run.outputs.length <= (hiddenRuns.get(run.key) ?? -1)) {
			return { render: () => [], describe: () => ({ k: "col" as const, p: { hidden: true } }) };
		}
		const text = run?.outputs ? runLine(run) : String(message.content);
		return {
			render(width: number) {
				const inside = Math.max(1, width - 4);
				const lines: string[] = [];
				let remaining = text;
				while (remaining.length > inside) {
					const breakAt = remaining.lastIndexOf(" ", inside);
					const length = breakAt > 0 ? breakAt : inside;
					lines.push(remaining.slice(0, length));
					remaining = remaining.slice(length).trimStart();
				}
				lines.push(remaining);
				const border = theme.fg("dim", `╭${"─".repeat(inside + 2)}╮`);
				return [border, ...lines.map(line =>
					`${theme.fg("dim", "│ ")}${theme.fg("muted", line.padEnd(inside))}${theme.fg("dim", " │")}`),
					theme.fg("dim", `╰${"─".repeat(inside + 2)}╯`)];
			},
			describe() {
				return {
					k: "card" as const,
					p: { role: "omp.custom" },
					c: [{ k: "text" as const, p: { spans: [{ t: text, s: "muted" }] } }],
				};
			},
		};
	});
	let loading = false;
	let generation = 0;
	let observing = 0;
	let settleAttempts = 0;
	let settleTimer: NodeJS.Timeout | undefined;
	let settling = false;

	function cancelSettle(): void {
		clearTimeout(settleTimer);
		settleTimer = undefined;
	}

	function hasUnresolved(): boolean {
		for (const key of pendingRuns) {
			const run = runs.get(key);
			if (run?.outputs.some(output => output.model === null)) return true;
		}
		return false;
	}

	function armSettle(ctx: ExtensionContext, delayMs: number, restart = false): void {
		if (pendingRuns.size === 0) return;
		if (settleTimer !== undefined) {
			if (!restart) return;
			cancelSettle();
		}
		const scheduledGeneration = generation;
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			if (scheduledGeneration !== generation) return;
			void settle(ctx);
		}, delayMs);
	}

	function flush(ctx: ExtensionContext): boolean {
		// A message_end read may still be in flight; its output belongs to this row.
		if (!ctx.isIdle() || observing > 0) return false;
		for (const key of pendingRuns) {
			const run = runs.get(key);
			if (!run || run.outputs.length === 0) continue;
			pi.sendMessage({
				customType: RUN_KEY,
				content: runLine(run),
				display: true,
				details: run,
			}, { triggerTurn: false });
			for (const output of run.outputs) pendingUsage.delete(output.key);
		}
		if (currentRun && pendingRuns.has(currentRun.key)) {
			currentRun = null;
			sealed = true;
		}
		pendingRuns.clear();
		return true;
	}

	async function refreshRouteEvents(): Promise<void> {
		const readGeneration = generation;
		const events = await readRouteEvents();
		if (readGeneration !== generation) return;
		routeEvents = events;
	}

	async function resolvePending(): Promise<void> {
		for (const key of pendingRuns) {
			const run = runs.get(key);
			if (!run) continue;
			for (const output of run.outputs) {
				if (output.model) continue;
				const usage = pendingUsage.get(output.key);
				if (!usage) continue;
				const matched = matchRouteEvent(usage, routeEvents, usedEventIds);
				if (!matched) continue;
				usedEventIds.add(matched.eventId);
				output.model = matched.model;
				pendingUsage.delete(output.key);
				relabelAssistantMessage(metrics, usage, matched.model);
			}
		}
	}

	async function settle(ctx: ExtensionContext): Promise<void> {
		if (settling || pendingRuns.size === 0) return;
		settling = true;
		const settleGeneration = generation;
		try {
			// Let the prompt unwind before checking idle state or route telemetry.
			if (!ctx.isIdle() || observing > 0) {
				armSettle(ctx, FLUSH_RETRY_MS);
				return;
			}
			if (hasUnresolved() && settleAttempts < RESOLVE_ATTEMPTS) {
				settleAttempts += 1;
				await refreshRouteEvents();
				if (settleGeneration !== generation || pendingRuns.size === 0) return;
				await resolvePending();
				render(ctx);
				if (!ctx.isIdle() || observing > 0 || (hasUnresolved() && settleAttempts < RESOLVE_ATTEMPTS)) {
					armSettle(ctx, FLUSH_RETRY_MS);
					return;
				}
			}
			if (!flush(ctx)) {
				armSettle(ctx, FLUSH_RETRY_MS);
				return;
			}
			settleAttempts = 0;
			render(ctx);
		} finally {
			settling = false;
		}
	}

	async function settleForShutdown(ctx: ExtensionContext): Promise<void> {
		const deadline = Date.now() + SETTLE_DELAY_MS;
		while (settling || observing > 0 || !ctx.isIdle()) {
			if (Date.now() >= deadline) break;
			await Bun.sleep(FLUSH_RETRY_MS);
		}
		if (currentRun?.outputs.length) pendingRuns.add(currentRun.key);
		if (pendingRuns.size === 0 || !ctx.isIdle() || observing > 0) return;
		if (hasUnresolved()) {
			await refreshRouteEvents();
			await resolvePending();
		}
		if (flush(ctx)) render(ctx);
	}

	function observe(message: unknown, saved?: { model: string | null }): void {
		if (!message || typeof message !== "object") return;
		const record = message as Record<string, unknown>;
		if (record.role !== "assistant") return;
		const key = outputKey(record);
		if (seen.has(key)) return;
		const usage = assistantUsage(message);
		// An aborted or empty placeholder has no usage; it is not a routed output.
		if (!usage) return;
		const matched = matchRouteEvent(usage, routeEvents, usedEventIds);
		if (!saved && !isUntitled(record) && !matched) return;
		seen.add(key);
		const upstream = modelIdentity(record.upstreamModel);
		const model = upstream ?? saved?.model ?? matched?.model ?? null;
		const event = matched && (!upstream || upstream === matched.model) ? matched : null;
		if (event) usedEventIds.add(event.eventId);
		const tools = Array.isArray(record.content)
			? record.content.filter(block => block?.type === "toolCall").map(block => String(block.name))
			: [];
		if (sealed || !currentRun) {
			currentRun = { key, outputs: [] };
			runs.set(key, currentRun);
			sealed = false;
		}
		currentRun.outputs.push({ key, model, tools });
		if (!model) pendingUsage.set(key, usage);
		recordAssistantMessage(metrics, message, model);
	}

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
		cancelSettle();
		const loadGeneration = ++generation;
		const events = await readRouteEvents();
		if (loadGeneration !== generation) return;
		routeEvents = events;
		metrics = emptySessionMetrics();
		usedEventIds = new Set();
		seen = new Set();
		runs = new Map();
		pendingUsage = new Map();
		currentRun = null;
		pendingRuns = new Set();
		hiddenRuns = new Map();
		sealed = false;
		observing = 0;
		settleAttempts = 0;
		const branch = ctx.sessionManager.getBranch();
		const savedModels = new Map<string, string | null>();
		const coveredRuns = new Set<string>();
		const savedRuns: RunSummary[] = [];
		for (const entry of branch) {
			if (entry.type !== "custom_message") continue;
			const details = entry.details as Record<string, unknown> | undefined;
			if (!details) continue;
			if (entry.customType === RUN_KEY) {
				const run = details as unknown as RunSummary;
				if (typeof run.key !== "string" || !Array.isArray(run.outputs)) continue;
				coveredRuns.add(run.key);
				for (const output of run.outputs) {
					if (output && typeof output.key === "string") savedModels.set(output.key, output.model ?? null);
				}
				savedRuns.push(run);
			} else if (entry.customType === OUTPUT_KEY) {
				const key = details.outputKey;
				if (typeof key !== "string") continue;
				coveredRuns.add(key);
				savedModels.set(key, typeof details.model === "string" ? details.model : null);
			}
		}
		for (const earlier of savedRuns) {
			if (savedRuns.some(later => later !== earlier && later.outputs.length > earlier.outputs.length &&
				earlier.outputs.every(output => later.outputs.some(item => item.key === output.key)))) {
				hiddenRuns.set(earlier.key, Math.max(hiddenRuns.get(earlier.key) ?? 0, earlier.outputs.length));
			}
		}
		loading = true;
		for (const entry of branch) {
			if (entry.type !== "message") continue;
			const message = entry.message as unknown as Record<string, unknown>;
			if (message.role === "user") {
				currentRun = null;
				continue;
			}
			const key = outputKey(message);
			observe(entry.message, savedModels.has(key) ? { model: savedModels.get(key) ?? null } : undefined);
		}
		loading = false;
		visible = true;
		detailsVisible = false;
		// Runs with an existing row stay as they are; the others get one summary row.
		for (const run of runs.values()) {
			if (run.outputs.some(output => coveredRuns.has(output.key))) continue;
			pendingRuns.add(run.key);
		}
		currentRun = null;
		sealed = true;
		render(ctx);
		armSettle(ctx, 0);
	}

	pi.registerCommand("untitled", {
		description: "Toggle Untitled session metrics; use /untitled details for the panel",
		handler: async (args, ctx) => {
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

	pi.on("session_branch", async (_event, ctx) => {
		await loadSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await loadSession(ctx);
	});

	pi.on("context", event => ({
		messages: event.messages.filter(message =>
			!("customType" in message && (message.customType === RUN_KEY || message.customType === OUTPUT_KEY))),
	}));

	pi.on("agent_start", (_event, ctx) => {
		// A new prompt closes the prior run, including a run with tool calls.
		if (currentRun && currentRun.outputs.length > 0) pendingRuns.add(currentRun.key);
		currentRun = null;
		sealed = true;
		settleAttempts = 0;
		armSettle(ctx, SETTLE_DELAY_MS, true);
	});

	// Observation only. The prompt is not finished between tool turns, so no flush here.
	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const observedGeneration = generation;
		observing += 1;
		try {
			await refreshRouteEvents();
			if (observedGeneration !== generation) return;
			observe(event.message);
		} finally {
			observing -= 1;
		}
		if (observedGeneration !== generation) return;
		render(ctx);
		// A final answer can arrive after agent_end notification; close this run here as well.
		if (event.message.stopReason === "stop" && currentRun?.outputs.length) {
			pendingRuns.add(currentRun.key);
			settleAttempts = 0;
			armSettle(ctx, SETTLE_DELAY_MS, true);
		} else if (currentRun && pendingRuns.has(currentRun.key)) {
			armSettle(ctx, SETTLE_DELAY_MS, true);
		}
	});

	pi.on("agent_end", (event, ctx) => {
		// Tool calls can continue this prompt after agent_end.
		if (event.willContinue) return;
		if (currentRun && currentRun.outputs.length > 0) pendingRuns.add(currentRun.key);
		settleAttempts = 0;
		armSettle(ctx, SETTLE_DELAY_MS, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cancelSettle();
		await settleForShutdown(ctx);
		generation += 1;
		cancelSettle();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(DETAILS_KEY, undefined);
	});
}
