/**
 * Auto-nudge for OMP.
 *
 * Install (session-only):
 *   omp --resume --extension /absolute/path/to/omp-config/extensions/auto-nudge/index.ts
 *
 * Or copy this file to ~/.omp/agent/extensions/auto-nudge.ts so OMP loads it
 * in each session.
 *
 * Use:
 *   Restart OMP, run /auto-nudge on, then submit your task.
 *   /auto-nudge status shows the next attempt. /auto-nudge off cancels it.
 *
 * This extension sends a new continuation after a provider quota error ends a
 * turn. It keeps the conversation and the completed tool results. It does not
 * replay the original prompt. OMP's native retry keeps control while it is
 * active. The provider reset time is used when the error supplies it. Without
 * reset timing, the extension probes every 60 seconds. Probes can incur
 * provider charges. Keep OMP running and the computer awake. This does not
 * survive process exit. No settings, credentials, or usage-reset credits are
 * changed.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isUsageLimit } from "@oh-my-pi/pi-ai/error";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";

const VERSION = "1.1.0";
const PROBE_INTERVAL_MS = 60_000;
const MAX_TIMER_MS = 2_147_483_647;
const CONTINUATION =
	"The previous turn stopped because the provider quota was exhausted. Continue the unfinished task from the current conversation and recorded tool results. Preserve completed work. Do not replay the original prompt or repeat completed actions. If the task is already complete, report that and stop.";

export default function autoNudge(pi: ExtensionAPI): void {
	// Factories are bound separately for main and child sessions. Never share state.
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
			"auto-nudge",
			armedSession === undefined
				? undefined
				: nextRetryAt === undefined
					? "Auto-nudge: on"
					: `Auto-nudge: ${new Date(nextRetryAt).toISOString()}`,
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
		const delayMs = hasHint && hint > 0 ? Math.ceil(hint) : PROBE_INTERVAL_MS;
		nextRetryAt = Math.max(Date.now() + delayMs, (lastProbeAt ?? 0) + PROBE_INTERVAL_MS);
		timingSource = hasHint && hint > 0 ? "provider retry timing" : "60-second recovery probe; reset time is not known";
		const deadline = nextRetryAt;
		const scheduledGeneration = generation;
		showStatus(ctx);
		ctx.ui.notify(`Auto-nudge: next attempt at ${new Date(deadline).toISOString()} (${timingSource}).`, "info");

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
				timer = ctx.setTimeout(wake, Math.min(remaining, MAX_TIMER_MS));
				return;
			}
			// Consume this scheduled attempt before dispatch. A new terminal failure
			// must pass agent_end again before another attempt can be scheduled.
			cancelPending(ctx);
			lastProbeAt = Date.now();
			ctx.ui.notify("Auto-nudge: continuing the unfinished task.", "info");
			// No deliverAs: explicit followUp would only queue while idle.
			pi.sendUserMessage(CONTINUATION, { attribution: "agent" });
		}
		timerContext = ctx;
		timer = ctx.setTimeout(wake, Math.min(Math.max(1, deadline - Date.now()), MAX_TIMER_MS));
	}

	pi.registerCommand("auto-nudge", {
		description: "Auto-nudge after terminal quota failures: on | off | status",
		handler: async (args, ctx) => {
			if (ctx.agent.kind !== "main") {
				ctx.ui.notify("Auto-nudge is available only in the main session.", "warning");
				return;
			}
			const command = args.trim().toLowerCase() || "status";
			if (command === "off") {
				disarm(ctx);
				ctx.ui.notify("Auto-nudge: off. Pending recovery cancelled.", "info");
				return;
			}
			if (command === "on") {
				if (!isPinned(ctx)) {
					disarm(ctx);
					armedSession = ctx.sessionManager.getSessionId();
					suppressCurrentTurn = false;
					if (ctx.hasUI) {
						removeTerminalListener = ctx.ui.onTerminalInput(data => {
							if (data === "\u001b" || data === "\u0003") {
								suppressCurrentTurn = true;
								cancelPending(ctx);
							}
							return undefined; // Never consume the user's abort key.
						});
					}
				}
				showStatus(ctx);
				ctx.ui.notify(
					`Auto-nudge ${VERSION}: on for this session. Submit your task. Native retry is unchanged. If a terminal quota error has no reset time, recovery attempts use a 60-second interval. Keep OMP running and the computer awake.`,
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
						? "Auto-nudge: off."
						: `Auto-nudge ${VERSION}: on. Session: ${armedSession}. ${next}${coreRetryActive ? " Core retry is active." : ""}`,
					"info",
				);
				return;
			}
			ctx.ui.notify("Use /auto-nudge on, /auto-nudge off, or /auto-nudge status.", "warning");
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
