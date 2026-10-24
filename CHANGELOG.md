# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- A NASweb module (nasWebio) over its local HTTPS API, without any cloud:
  relay outputs, inputs (active, fault or tamper) and the temperature probe.
- The states pushed by the module to a receiver sub-container (`nasweb-push`,
  same image, one port published by Gladys): a secret URL per installation,
  exact method and path, bounded bodies and rate; the source address and the
  serial number of the module checked by the integration.
- Relay outputs become switches only when declared safe; the others are
  read only. Commands are off by default, decided after a fresh read of the
  identity of the module, confirmed only by a pushed status.
- The certificate of the module pinned at the first connection; a changed
  certificate or serial number refused until trusted in two clicks.
- A refused login stops everything (persisted), without automatic retry.
- "Test the connection" and "Trust the device now answering" buttons.

[Unreleased]: https://github.com/LM1LC3N7/gladys-nasweb/commits/main
