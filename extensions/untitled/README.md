# OMP Untitled Metrics

This OMP extension shows session-scoped routing metrics from [Untitled](https://tryuntitled.ai/) in the OMP status bar.

## Requirements

- [Oh My Pi](https://github.com/can1357/oh-my-pi)
- [Untitled](https://tryuntitled.ai/) on macOS
- An OMP OpenAI Codex provider that sends requests through the local Untitled relay

## Install

Run the installer from your local checkout:

```bash
bash extensions/untitled/install.sh
```

The installer links this extension's package directory into OMP and changes your global status-bar settings.
It adds extension status to the main OMP status bar.
Restart OMP after installation.

To load the extension for one launch without global changes, use its absolute path:

```bash
omp --extension /absolute/path/to/omp-untitled/extensions/untitled/index.ts
```

## Use

- The OMP status bar shows the routed model, request count, workload savings, and capacity estimate for the current session.
- Run `/untitled` to show or hide all extension output.
- Run `/untitled details` to show or hide the detail panel.
- Run `/models` to switch between specific models and the untitled router.
- Note: `/untitled` only shows or hides metrics and does not change the model.


Exact token savings need a paired Sol comparison. The extension shows `—` when that comparison does not exist.

## Data source

The extension reads the local Untitled telemetry log. It checks these sources in order:

1. `UNTITLED_SUBSCRIPTION_LOCAL_LOG`
2. `~/Library/Application Support/Untitled Router/config/relay.env`
3. `~/Library/Application Support/Untitled Router Data/subscription.jsonl`

The extension does not send network requests.
