# Personal OMP configuration

Personal extensions and developer configuration for [Oh My Pi](https://github.com/can1357/oh-my-pi).
The repository keeps the `omp-untitled` name and Git history.

## Layout

```text
extensions/
  untitled/       Untitled telemetry extension and installer
README.md         Repository setup and conventions
```

Each extension owns its entry file and documentation.
The repository root does not install an extension bundle.

## Setup

1. Install OMP.
2. Clone this repository:

   ```bash
   git clone git@github.com:0xf3dz/omp-untitled.git
   cd omp-untitled
   ```

3. Read the [Untitled instructions](extensions/untitled/README.md) before installation.

## Existing installation

The old GitHub-root package no longer serves as an installation source.
To migrate an existing Untitled installation, run this command from the checkout:

```bash
bash extensions/untitled/install.sh
```

The installer links the local package under its existing `omp-untitled` identity.
Restart OMP after the migration.
Do not use the previous remote `curl | bash` command.

## Repository conventions

- Keep each extension under `extensions/<name>/`.
- Keep extension assets beside the code that uses them.
- Add configuration files only when a feature needs them; do not add empty directories.
- Keep credentials and local OMP state outside this repository.
- Use explicit launch flags for session-only extensions.
- Describe persistent settings changes before an installation command.
- Use short Conventional Commit messages, such as `feat: add an extension` or `fix: cancel a stale timer`.
