# TODO

## Status

Milestone 1 (0.1.0, local commits, not pushed): a NASweb module read through
its local HTTPS API and the states it pushes to the `nasweb-push`
sub-container; relay outputs declared safe as switches behind an off-by-default
option. Never tested with a real NASweb module: only against a fake module, a
local TLS server and the real receiver on the loopback.

## Next

- Test with a real module: the exact shape of the pushed status (index type,
  `device_temp_env` scale), how often it pushes, whether the subscription
  survives a reboot of the module, whether it accepts a host name in the push
  address, how many subscriptions it keeps.
- Several modules in one installation (one module in v1).
- Withdraw the subscription when the address of the module changes (the old
  module is not told in v1).

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and both `docker_image` tags (`ghcr.io/lm1lc3n7/gladys-nasweb:0.1.0`,
  main and `nasweb-push`): the first patch release gives 0.1.1.
- **Reference**: webio-api 0.1.12 (MIT, nasWebio, the manufacturer; the
  GitHub repository `nasWebio/webio_api` stops at an older commit 3d686f8,
  the PyPI sdist 0.1.12 was read too), license checked in its `LICENSE`;
  Home Assistant's NASweb integration (Apache-2.0, `components/nasweb`) for
  the mapping and the subscription flow. Ported, not copied; credited in
  `THIRD_PARTY_NOTICES.md`, shipped in the image. The endpoints are under
  `rest/integration/hass/`: that is the manufacturer's integration API, the
  only one documented; no User-Agent or application is imitated.
- **Neighbours**: gladys-qbus (relays declared safe, publisher, hidden
  features), gladys-mystrom (receiver sub-container and HMAC channel),
  gladys-alfen (pinned TLS client and its bounded HTTP parser). Read only.
- **Push reception** (Gladys spec `contracts/container-descriptor.md`: the
  main container never has a published port): a sub-container of the same
  image declares one TCP port (`nasweb_push`, `browsable: false`), started
  `manual` by the integration with its secrets in env. No polling fallback is
  possible: webio-api has no endpoint returning the states; without pushes
  the devices are unreachable and the status says why.
- **Push URL** `http://<callback_address>:<host port>/nasweb/<push token>`:
  the push token (32 random base64url characters) and the channel token are
  generated once, kept in the Gladys configuration outside the
  `config_schema` (`setConfig`, never shown), never in `/data` nor the logs.
  `/data` keeps the subscribed host and port and 8 hex characters of the hash
  of the token (to tell a subscription made with another token), not the
  token. The user types the address of Gladys (the container cannot know the
  LAN address of the host), in `callback_address`: a key named
  `gladys_address` never reaches the integration (the core stores keys upper
  case and returns `GLADYS_*` ones unchanged, as reserved; seen in the
  sandbox, see gladys-mystrom).
- **Checks on a push**: receiver: method POST, exact path, token compared in
  constant time, 32 KB, 5 kept while the main container
  is away (review r1: 32 connections, 4 per sender, idle closed within 10 s from the
  acceptance, headers 5 s, request 10 s checked every second, 60 posts a
  minute per sender, 240 in all; with the option on, other senders get 403
  from the receiver before any budget); main container: source address
  equal to the module's (option
  `check_push_source`, on by default, for Docker setups hiding the source:
  docker-proxy, rootless), serial number equal to the identified one, a push
  older than 90 s ignored, strict parsing (own keys, indexes 0..999, 64
  outputs and 64 inputs at most).
- **External ids**: `module:<serial>`, `output:<serial>-<index>`,
  `input:<serial>-<index>`, the serial being `devSN` without dashes (as
  webio-api and Home Assistant key it).
- **Relays: switches only when declared safe** (`safe_outputs`, output
  indexes), as gladys-qbus; any other output is read only (`unknown/binary`),
  with no button at all (the lot 15 brief: "sinon lecture seule"). Commands
  are refused unless `allow_commands` (off by default). Both feature sets are
  built, the other one hidden: a switch created before its output left the
  list keeps its feature (never a lost feature) and refuses commands.
- **Commands**: a recent push (< 90 s) is required (the confirmation comes
  only by a push); the identity (`getDeviceInfo`, serial) is read again
  before each command, in 2.5 s at most; options and identity checked again
  in `beforeSend`; sent within 3.5 s of the click or refused unsent;
  confirmed only by a push showing the requested state by 4.3 s, else "sent,
  without confirmation"; `{"Answer": not "OK"}` is "the module answered that
  the command failed". The write is always sent (no "already in that state"
  shortcut: setting a relay to its state is harmless, and no fresh read of
  the state exists). One command at a time per output.
- **TLS**: the module serves a self-signed certificate (webio-api: verify_ssl
  False). One request per TLS connection; the SHA-256 fingerprint pinned at
  the first connection, written to `/data` before the login leaves; another
  certificate refused before any byte; "Trust the device now answering"
  (two clicks within 60 s, exactly the fingerprint and serial shown).
- **Another serial at the address**: refused, and the module is no longer
  read automatically (the login would go to another module); only "Test the
  connection" or the trust button read it.
- **Login refused** (401 or "Not Authorized"): final stop persisted in
  `/data`, no automatic retry; lifted by other credentials (also across a
  restart: 8 bits of a salted hash of the REFUSED credentials only, cleared at
  the first success) or a successful "Test the connection".
- **Reads**: never faster than once a minute (time of the attempt in `/data`
  before the read, written at most once a minute), and only while no push
  arrives or the subscription is not current; the subscription renewed every
  10 minutes while nothing arrives.
- **Not offered**: alarm zones (arm/disarm), the thermostat (heating), the
  humidity (the API gives none), several modules.
- **Temperature**: `device_temp_env` in °C as webio-api reads it, sent at
  most every 30 s; the feature appears once a value was seen.
- **Review r1** (fixes):
  - freshness and confirmation dated by the time the receiver got the post
    (`at`), never by its arrival in this container: a push kept by the
    receiver counts from its own time; an older push never overwrites a newer
    one; only a push posted after the bytes of `setOutput` left (time noted in
    `beforeSend`) confirms a command; a timer at the exact end of the 90 s
    turns the badges unreachable and drops the pending values;
  - values sent to Gladys only while the last push is under 90 s old (rebuild,
    reads, deviceCreated included): never an old value as new;
  - one write at a time per output: a newer command waits for the write of
    the previous one only, then replaces it ("replaced by a newer command");
  - `/data/nasweb.json` that exists but cannot be read: nothing sent, never
    written over, until "Test the connection" starts again from scratch;
  - "Test the connection" subscribes again at once;
  - refused pushes update the status at most every 10 s.
