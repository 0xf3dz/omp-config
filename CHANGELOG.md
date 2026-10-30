# Changelog

## Unreleased

### Added

- Add the ASD-STE100 prose rules as a reusable skill.
- Add the session-only quota resume extension with explicit on, off, and status commands.
- Add provider-timed recovery and 60-second recovery probes when no reset time exists.

### Changed

- Organize the repository as personal OMP developer configuration.
- Update Untitled in `extensions/untitled/` with routing recaps and session metrics.
- Replace the GitHub-root installer with a local package link from the checkout.
- Add one Untitled routing recap per prompt with actual model names, turn counts, and tools.
- Replace the recap's fallback surface with a native card and remove the input-area recap.
- Use `omp-config/extensions/untitled/` as the only installed Untitled extension source.
- Retain the `omp-untitled` package identity and existing Git history.

### Migration

- Run `bash extensions/untitled/install.sh` from the checkout to migrate an existing Untitled installation.
- Stop use of the previous remote `curl | bash` installer and GitHub-root plugin source.
- Load quota resume through its explicit entry file; do not install it globally.
