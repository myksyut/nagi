# Changelog

このファイルは [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) の形で書き、版は [Semantic Versioning](https://semver.org/lang/ja/) に従う。
TUI（`nagi`）の版の正本は `tui/Cargo.toml` の `version`。出し方は [docs/releasing.md](docs/releasing.md)。

## [Unreleased]

## [0.2.0]

### Changed

- 版を semver のタグ（`v0.2.0`）で付けるようにした。以前の `tui-v0.1.<番号>` は使わない。`nagi --version` は `Cargo.toml` の版を出す

### Added

- Release に `SHA256SUMS` と provenance（build attestation）を載せるようにした
