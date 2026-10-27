/**
 * Load only in the selected OMP launch:
 *   omp --resume <session-id-or-path> --extension /absolute/path/to/omp-untitled/extensions/quota-resume/index.ts
 * Run /quota-resume on, then submit your task. Use /quota-resume status or off.
 * Keep OMP running and the computer awake. This does not survive process exit.
 *
 * Core retry keeps control while it is active. After a terminal quota failure,
 * this extension sends a new continuation, not a replay of the original prompt.
 * Without provider reset timing, it makes a recovery attempt every 60 seconds.
 * Attempts can incur provider charges. Success stops attempts; the watcher stays
 * armed for later tasks. New input or Escape cancels the pending recovery.
 * A session switch, branch, tree navigation, or shutdown disarms the watcher.
 * No settings, credentials, or usage-reset credits are changed.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isUsageLimit } from "@oh-my-pi/pi-ai/error";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";
import { matchesKey } from "@oh-my-pi/pi-tui";
import continuation from "./quota-resume-prompt.md" with { type: "text" };

export default function quotaResume(pi: ExtensionAPI): void {
	// Factories are bound separately for main and child sessions. Never share state.
	const probeIntervalMs = 60_000;
	const maxTimerMs = 2_147_483_647;
	let armedSession: string | undefined;
	let timer: Timer | undefined;
	let timerContext: ExtensionContext | undefined;
	let nextRetryAt: number | undefined;
	let timingSource: string | undefined;
	let generation = 0;
	let coreRetryActive = false;
	let suppressCurrentTurn = false;
	let lastProbeAt: number | undefined;
	let lastFailure: { timestamp: number; provider: string; model: string; error: string } | undefined;
	let removeTerminalListener: (() => void) | undefined;

	function isPinned(ctx: ExtensionContext): boolean {
		return ctx.agent.kind === "main" && armedSession === ctx.sessionManager.getSessionId();
	}

	function showStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"quota-resume",
			armedSession === undefined
				? undefined
				: nextRetryAt === undefined
					? "Quota resume: on"
					: `Quota resume: ${new Date(nextRetryAt).toISOString()}`,
		);
	}

	function cancelPending(ctx: ExtensionContext): void {
		generation++;
		if (timer !== undefined) timerContext?.clearTimer(timer);
		timer = undefined;
		timerContext = undefined;
		nextRetryAt = undefined;
		timingSource = undefined;
		showStatus(ctx);
	}

	function disarm(ctx: ExtensionContext): void {
		armedSession = undefined;
		cancelPending(ctx);
		removeTerminalListener?.();
		removeTerminalListener = undefined;
		coreRetryActive = false;
		suppressCurrentTurn = true;
		lastFailure = undefined;
		lastProbeAt = undefined;
	}

	function schedule(ctx: ExtensionContext, provider: string, model: string, error: string): void {
		cancelPending(ctx);
		const hint = extractProviderRetryHint(provider, error);
		const hasHint = hint !== undefined && Number.isFinite(hint) && hint >= 0;
		// A past reset must not turn a still-exhausted proxy into a tight loop.
		const delayMs = hasHint && hint > 0 ? Math.ceil(hint) : probeIntervalMs;
		nextRetryAt = Math.max(Date.now() + delayMs, (lastProbeAt ?? 0) + probeIntervalMs);
		timingSource = hasHint && hint > 0 ? "provider retry timing" : "60-second recovery probe; reset time is not known";
		const deadline = nextRetryAt;
		const scheduledGeneration = generation;
		showStatus(ctx);
		ctx.ui.notify(`Quota resume: next attempt at ${new Date(deadline).toISOString()} (${timingSource}).`, "info");

		function wake(): void {
			timer = undefined;
			if (scheduledGeneration !== generation) return;
			if (!isPinned(ctx)) {
				disarm(ctx);
				return;
			}
			if (
				suppressCurrentTurn || coreRetryActive || !ctx.isIdle() || ctx.hasPendingMessages() ||
				ctx.model?.provider !== provider || ctx.model?.id !== model
			) {
				cancelPending(ctx);
				return;
			}
			const remaining = deadline - Date.now();
			if (remaining > 0) {
				timer = ctx.setTimeout(wake, Math.min(remaining, maxTimerMs));
				return;
			}
			// Consume this scheduled attempt before dispatch. A new terminal failure
			// must pass agent_end again before another attempt can be scheduled.
			cancelPending(ctx);
			lastProbeAt = Date.now();
			ctx.ui.notify("Quota resume: continuing the unfinished task.", "info");
			// No deliverAs: explicit followUp would only queue while idle.
			pi.sendUserMessage(continuation);
		}
		timerContext = ctx;
		timer = ctx.setTimeout(wake, Math.min(Math.max(1, deadline - Date.now()), maxTimerMs));
	}

	pi.registerCommand("quota-resume", {
		description: "Resume after terminal quota failures: on | off | status",
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main") {
				ctx.ui.notify("Quota resume is available only in the main session.", "warning");
				return;
			}
			const command = args.trim().toLowerCase() || "status";
			if (command === "off") {
				disarm(ctx);
				ctx.ui.notify("Quota resume: off. Pending recovery cancelled.", "info");
				return;
			}
			if (command === "on") {
				if (!isPinned(ctx)) {
					disarm(ctx);
					armedSession = ctx.sessionManager.getSessionId();
					suppressCurrentTurn = false;
					if (ctx.hasUI) {
						removeTerminalListener = ctx.ui.onTerminalInput(data => {
							if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
								suppressCurrentTurn = true;
								cancelPending(ctx);
							}
							return undefined; // Never consume the user's abort key.
						});
					}
				}
				showStatus(ctx);
				ctx.ui.notify(
					"Quota resume: on for this session. Submit your task. Core retry is unchanged. If a terminal quota error has no reset time, recovery attempts use a 60-second interval. Keep OMP running and the computer awake.",
					"info",
				);
				return;
			}
			if (command === "status") {
				if (armedSession !== undefined && !isPinned(ctx)) disarm(ctx);
				const next = nextRetryAt === undefined
					? "No recovery attempt is scheduled."
					: `Next attempt: ${new Date(nextRetryAt).toISOString()} (${timingSource}).`;
				ctx.ui.notify(
					armedSession === undefined
						? "Quota resume: off."
						: `Quota resume: on. Session: ${armedSession}. ${next}${coreRetryActive ? " Core retry is active." : ""}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Use /quota-resume on, /quota-resume off, or /quota-resume status.", "warning");
		},
	});

	pi.on("input", (_event, ctx) => {
		if (!isPinned(ctx)) return;
		cancelPending(ctx);
		// Do not let the interrupted old turn schedule work before the new one starts.
		suppressCurrentTurn = true;
	});
	pi.on("agent_start", (_event, ctx) => {
		if (!isPinned(ctx)) return;
		cancelPending(ctx);
		suppressCurrentTurn = false;
		lastFailure = undefined;
	});
	pi.on("auto_retry_start", (_event, ctx) => {
		if (!isPinned(ctx)) return;
		coreRetryActive = true;
		cancelPending(ctx);
	});
	pi.on("auto_retry_end", (event, ctx) => {
		if (!isPinned(ctx)) return;
		coreRetryActive = false;
		if (event.success || /\b(?:abort(?:ed)?|cancelled|canceled|interrupted)\b/i.test(event.finalError ?? "")) {
			cancelPending(ctx);
			if (!event.success) suppressCurrentTurn = true;
		}
	});
	pi.on("agent_end", (event, ctx) => {
		if (!isPinned(ctx) || event.willContinue) return;
		// Inspect only the newest assistant in this turn, never an older error
		// behind a newer user prompt, successful answer, or aborted assistant.
		let assistant: Extract<(typeof event.messages)[number], { role: "assistant" }> | undefined;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message.role === "user") break;
			if (message.role === "assistant") {
				assistant = message;
				break;
			}
		}
		if (
			!assistant || assistant.stopReason !== "error" || !isUsageLimit(assistant, assistant.api)
		) {
			cancelPending(ctx);
			return;
		}
		if (suppressCurrentTurn || coreRetryActive || ctx.hasPendingMessages()) return;
		const error = assistant.errorMessage ?? "";
		if (
			lastFailure?.timestamp === assistant.timestamp && lastFailure.provider === assistant.provider &&
			lastFailure.model === assistant.model && lastFailure.error === error
		) return;
		lastFailure = { timestamp: assistant.timestamp, provider: assistant.provider, model: assistant.model, error };
		schedule(ctx, assistant.provider, assistant.model, error);
	});

	// Cancel before transitions, so a due timer cannot race a new transcript.
	pi.on("session_before_switch", (_event, ctx) => disarm(ctx));
	pi.on("session_switch", (_event, ctx) => disarm(ctx));
	pi.on("session_before_branch", (_event, ctx) => disarm(ctx));
	pi.on("session_branch", (_event, ctx) => disarm(ctx));
	pi.on("session_before_tree", (_event, ctx) => disarm(ctx));
	pi.on("session_tree", (_event, ctx) => disarm(ctx));
	pi.on("session_shutdown", (_event, ctx) => disarm(ctx));
}
