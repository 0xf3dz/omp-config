# Changelog

## Unreleased

### Added

- Add the ASD-STE100 prose rules as a reusable skill.
- Add the session-only quota resume extension with explicit on, off, and status commands.
- Add provider-timed recovery and 60-second recovery probes when no reset time exists.

### Changed

- Organize the repository as personal OMP developer configuration.
- Move Untitled into `extensions/untitled/` without changes to its metrics implementation.
- Replace the GitHub-root installer with a local package link from the checkout.
- Retain the `omp-untitled` package identity and existing Git history.

### Migration

- Run `bash extensions/untitled/install.sh` from the checkout to migrate an existing Untitled installation.
- Stop use of the previous remote `curl | bash` installer and GitHub-root plugin source.
- Load quota resume through its explicit entry file; do not install it globally.
