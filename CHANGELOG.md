# Changelog

All notable changes to Bring are documented here, newest first. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/) once published. Until the
first npm release everything accumulates under **Unreleased** with the commit
that introduced it.

## [Unreleased]

### Added

- Colored `bring doctor` output in interactive terminals: green ✓, red ✗,
  dimmed skipped checks. Automatically plain when piped, under `NO_COLOR`, or
  with `--json`. A live animated checklist is planned for Phase 1E, when the
  Ink spinner components exist to reuse.
- `bring doctor` — non-mutating dependency diagnostics: locates the
  `devcontainer` and `docker` executables on PATH, probes them with bounded
  timeouts, verifies the Dev Containers CLI exposes the commands Bring needs
  (`up`, `exec`, `read-configuration`), and distinguishes a missing CLI, a
  capability gap, missing Docker, a stopped daemon, and a permission problem —
  each with the exact fix. Exit 0 when healthy, 4 when not. (`36c9271`)
- `bring doctor --json` — the same report as machine-readable JSON with stable
  check ids and error codes (`DEPENDENCY_MISSING`, `DEPENDENCY_UNREACHABLE`,
  `UNSUPPORTED_CAPABILITY`), never any ANSI. (`36c9271`)
- Installable CLI skeleton: `bring --version`, `bring --help`, bare `bring`
  Ink placeholder, contractual exit codes (0/1/2/3/4/5/130), unknown options
  rejected with exit 2, tests (vitest + ink-testing-library), Biome
  lint/format, GitHub Actions CI on Node 22 and 24, Apache-2.0 license,
  `npm pack` ships only `dist/` + metadata. (`122277c`)

### Changed

- Help and README now describe `bring down` / `bring remove` as acting like
  `docker stop` / `docker rm`: the upstream devcontainer CLI turned out to
  have no lifecycle stop/down commands at all, so Bring will manage workspace
  containers through Docker using devcontainer labels (product semantics
  unchanged: `down` preserves, `remove` deletes). (`36c9271`)
