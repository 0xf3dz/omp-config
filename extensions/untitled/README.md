# OMP Untitled Metrics

This OMP extension shows per-output model attribution and session-scoped routing metrics from [Untitled](https://tryuntitled.ai/) in OMP.

## Requirements

- [Oh My Pi](https://github.com/can1357/oh-my-pi)
- [Untitled](https://tryuntitled.ai/) on macOS
- An OMP OpenAI Codex provider that sends requests through the local Untitled relay

## Install

Run the installer from your `omp-config` checkout:

```bash
bash extensions/untitled/install.sh
```

The installer links this directory as the only `omp-untitled` plugin and enables its status bar output. It replaces an earlier link to `omp-untitled-metrics`.
Restart OMP after installation. Do not also load the extension with `--extension`; that would load it twice.

For one launch without a persistent link, use:

```bash
omp --extension /absolute/path/to/omp-config/extensions/untitled/index.ts
```

Do not use the old `omp-untitled` remote installer. This repository owns the extension now.

## Use

- One prompt gets one transcript recap below the model response. The recap combines all routed models in one box without a title.
- The recap has this format: `Untitled routed to gpt-6.1-sol ×2 for 2 turns for web_search ×1, gpt-6-luna ×2 for 2 turns for bash ×1`.
- A turn is one routed assistant output. A tool call and the answer after it are two turns.
- The extension waits 1.5 seconds after the final assistant output or `agent_end`, then writes one recap when the session is idle. It retries missing route data. Shutdown writes pending recaps before the session closes.
- The OMP status bar shows aggregate routed models, request count, workload savings, and capacity estimate for the current session.
- Run `/untitled` to show or hide session metrics. Persisted transcript recaps remain visible.
- Run `/untitled details` to show or hide the aggregate detail panel.
- Run `/models` to switch between specific models and the Untitled router.
- `/untitled` does not change the selected model.

Exact token savings need a paired Sol comparison. The extension shows `—` when that comparison does not exist.

The built-in served-model footer only reports recognized model substitutions once per model pair. It cannot show every routed output or unknown identities through the extension API, so this extension uses standard transcript messages instead of notifications or a replacement footer.

Session reload, branch changes, and tree navigation rebuild metrics from the active branch. A run with a saved row keeps that row. A run without a row gets one summary row when the session is idle. Per-output rows from earlier versions still supply their saved model identity and are not duplicated.

The extension keeps the output models in the saved row details. It does not keep token counts or text there.

## Data source

The serving identity comes from the assistant message's `upstreamModel` first. The requested `model` is only a request label, never proof of the actual model. Untitled request/provider names (including `untitled-router/eclipse`), known Untitled serving models, and exact local telemetry matches identify routed outputs.

When response metadata is absent, the extension uses a successful serving event with exact input, cached-input, and output token counts within 120 seconds. Events are not reused across outputs. If matching events name different models, the identity is ambiguous and remains unknown. Router aliases are not actual model identities.

Unknown identities display `unknown`. They are not replaced with the requested alias. New serving-model names are displayed even when they are not in the rate table. Unknown or unpriced requests make session cost comparisons unavailable (`—`) rather than assigning an estimated rate. The existing Luna, Terra, and Sol pricing calculations are unchanged.

The extension reads at most the last 8 MiB of the local Untitled telemetry log. It checks these locations in order:

1. `UNTITLED_SUBSCRIPTION_LOCAL_LOG`
2. `~/Library/Application Support/Untitled Router/config/relay.env`
3. `~/Library/Application Support/Untitled Router Data/subscription.jsonl`

The extension does not send network requests.
