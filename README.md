# Personal OMP configuration

Personal extensions and developer configuration for [Oh My Pi](https://github.com/can1357/oh-my-pi).

## Layout

```text
extensions/
  quota-resume/   Session-only continuation after quota failures
  untitled/       Untitled routing recaps, metrics, and installer
skills/
  asd-ste100-writing/  User-facing prose rules in ASD-STE100 Simplified Technical English
```

## Untitled installation

1. Clone this repository.
2. Run `bash extensions/untitled/install.sh` from the repository root.
3. Restart OMP and select Untitled Auto.

The installer links `extensions/untitled/` as the single `omp-untitled` plugin. Do not load a second copy with `--extension`.
The extension shows one title-free routing recap after each completed prompt and keeps session metrics in the status bar.
