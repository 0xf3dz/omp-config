# Quota resume

This extension sends a new continuation after a quota error ends an OMP turn.
It preserves the current conversation and completed tool results.
It leaves OMP's native retry in control while that retry remains active.

## Requirements

- OMP with managed extension timers and the `agent_end.willContinue` event field.
- OMP 18.13.1 passed the runtime checks for this extension.
- An open interactive OMP process and an awake computer.

## Enable for one session

Keep this extension outside OMP's automatic discovery directories.
Do not install it as a global plugin or add it to global `extensions` settings.

1. Exit the selected OMP session.
2. Start OMP with the absolute path to this entry file:

   ```bash
   omp --resume --extension /absolute/path/to/omp-untitled/extensions/quota-resume/index.ts
   ```

3. Select your saved session.
4. Enter `/quota-resume on`.
5. Submit your task or continuation instruction once.

For a new session, omit `--resume`.
The extension starts disabled and needs `/quota-resume on` after each launch.
It does not change global settings or consume saved quota-reset credits.

## Commands

| Command | Effect |
| --- | --- |
| `/quota-resume on` | Enable the watcher for the current main session. |
| `/quota-resume status` | Show its state and next scheduled attempt. |
| `/quota-resume off` | Disable the watcher and cancel a pending attempt. |

## Recovery

| Condition | Action |
| --- | --- |
| Native retry remains active | Leave recovery to OMP. |
| A quota error ends the turn | Schedule a new continuation. |
| The provider supplies retry timing | Wait for that time. |
| No retry timing exists | Attempt recovery after 60 seconds. |
| An automatic attempt also hits quota | Schedule another attempt, at least 60 seconds after the previous automatic attempt. |
| The turn succeeds | Stop recovery attempts; keep the watcher enabled for future failures. |
| A non-quota error occurs | Do not schedule a recovery attempt. |

The extension uses OMP's quota classifier and provider retry-time parser.
It does not read the usage countdown from Tern or query a separate usage endpoint.
The companion `quota-resume-prompt.md` instructs the agent to continue without a replay of completed actions.

## Cancellation and limits

Recovery attempts can incur provider charges.
If the provider supplies no reset time, the extension uses model requests as 60-second recovery probes.
This can produce repeated failed requests until quota becomes available.

- Escape, Ctrl+C, or new submitted input cancels pending recovery.
- A model change prevents a pending attempt from dispatch.
- A session switch, branch, tree navigation, or shutdown disables the watcher.
- Success does not schedule a prompt to continue a task that the agent considers complete.
- Process exit removes the timer and enabled state.
- The extension does not prevent system sleep.

## Verification

The OMP 18.13.1 runtime checks used a local provider with synthetic quota errors.
They covered a provider-timed continuation, a 60-second recovery without timing, and cancellation with `/quota-resume off`.
The checks did not exercise a real five-hour provider reset.
