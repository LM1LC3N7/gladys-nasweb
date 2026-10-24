# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for a NASweb module (nasWebio,
local HTTPS API, no cloud): a Node.js service (Node 22+, ESM, no build step)
that runs in its own sandboxed Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
The same image also runs the `nasweb-push` sub-container (the HTTP endpoint
the module pushes its states to). See `TODO.md` for the status and the
decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "command" # tests whose name matches
npm run cover                             # regenerate cover.png (800×534)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> NaswebApp (shared with the tests)
src/app.js                        NaswebApp: identity, pin, subscription, pushes, commands, buttons
src/nasweb/client.js              the module API (webio-api 0.1.12): device info, setOutput, subscription
src/nasweb/http.js                one HTTPS request per TLS connection, the pin checked before any byte
src/nasweb/status.js              the pushed status -> outputs, inputs, temperature (pure)
src/model.js                      -> Gladys devices and routing (pure)
src/publisher.js                  states within the rate limit (250/min)
src/store.js                      /data/nasweb.json (identity, pin, subscription, login stop)
src/channel.js                    private TCP channel, mutual HMAC challenge-response
src/receiver.js, src/push/        the nasweb-push sub-container (HTTP push endpoint)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, limits, timings; texts in English and French
scripts/cover.mjs                 cover.png generator (plain Node)
gladys-assistant-integration.json manifest: name, config_schema, actions, containers, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys, a local TLS server
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** `module:<serial>`, `output:<serial>-<index>`,
  `input:<serial>-<index>`, the serial being `devSN` without dashes, and the
  feature roles of `src/constants.js`. Changing one creates new devices and
  orphans the old ones. The same goes for the manifest `config_schema` and
  `actions` keys.
- **Relays.** A relay output is a switch ONLY when declared safe
  (`safe_outputs`); every other output stays read only. Commands are refused
  unless `allow_commands` (off by default). Never add a switch, a light or a
  button for an output that is not declared safe.
- **Commands** decide on fresh facts: the identity read again before the
  write, `beforeSend` right before the bytes leave, a recent push required,
  confirmation only by a pushed status equal to the requested state. A
  request that may have left is never answered "not sent".
- **Secrets.** The password (and its SHA-1, as good as the password for the
  module), the login, the push and channel tokens: never in the logs, in
  `/data`, in a status or an error. A secret field is kept by Gladys in its
  database as it is and only hidden in the interface: say so, nothing more.
- **The certificate is pinned** at the first connection, in `/data` before the
  login leaves; another one is never learned blindly (two clicks on "Trust
  the device now answering").
- **The container rootfs is read-only.** Write only under `/data`.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tags
  (main and sub-container), by hand. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md`. Never write a version heading.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **Rate.** Gladys accepts 300 states a minute: everything goes through the
  publisher (250 a minute).
- **Encoding.** Every file is UTF-8 without BOM; `test/encoding.test.js`
  refuses mojibake and control bytes.
