# gladys-nasweb

[Gladys Assistant](https://gladysassistant.com) external integration for a
**NASweb** module (nasWebio, Chomtech), on the local network: its relay
outputs, inputs and temperature probe become Gladys devices of the Discovery
tab, through the local HTTPS API of the module, without any cloud.
Unofficial, not affiliated with nasWebio.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake module and a
> local TLS server only, never with a real NASweb module.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (NaswebApp)
                                   ├─ src/nasweb/client.js   getDeviceInfo, setOutput, statusSubscription (webio-api)
                                   ├─ src/nasweb/http.js     one HTTPS request per TLS connection, pin checked before any byte
                                   ├─ src/nasweb/status.js   the pushed status -> outputs, inputs, temperature (pure)
                                   ├─ src/model.js           -> Gladys devices; switches only for outputs declared safe (pure)
                                   ├─ src/publisher.js       states within 250/min (Gladys: 300)
                                   ├─ src/store.js           /data/nasweb.json: identity, pin, subscription, login stop
                                   └─ src/channel.js ⇄ nasweb-push sub-container (src/receiver.js)
                                                         └─ src/push/service.js  HTTP :8080, published by Gladys
```

- **API** (ported from webio-api 0.1.12, MIT, nasWebio): `POST` JSON to
  `https://<module>/rest/integration/hass/{getDeviceInfo,setOutput,statusSubscription}`,
  with `login` and the SHA-1 (upper-case hex) of the password in the body.
  There is no endpoint to read the states: the module pushes them, once
  subscribed, to an HTTP address.
- **Receiving the pushes.** The main container of an integration has no
  published port (Gladys spec, container descriptor). A sub-container of the
  same image (`node src/receiver.js`, manifest `containers`, `start: manual`)
  serves exactly `POST /nasweb/<push token>` on a port Gladys publishes,
  bounded (32 KB, 32 connections, 4 per sender, idle closed within 10 s, about 11 s per request, 60 posts a minute per sender, 240 in all), and hands each push to the main
  container over a private TCP channel authenticated both ways by an HMAC
  challenge-response (from LM1LC3N7/gladys-mystrom). The main container
  checks the source address (the module's, option `check_push_source`), the
  serial number and the shape. The push and channel tokens are generated
  once and kept in the Gladys configuration outside the `config_schema`
  (`setConfig`), passed to the receiver through `startContainer` env.
- **Identity**: the serial number (`devSN` without dashes) keys the external
  ids (`module:<serial>`, `output:<serial>-<index>`, `input:<serial>-<index>`).
  The certificate is pinned at the first connection (in `/data` before the
  login leaves); another certificate or serial is refused until "Trust the
  device now answering" (two clicks).
- **Commands**: switches only for the outputs declared safe, refused unless
  `allow_commands`; a recent push is required (confirmation), the identity
  is read again before the write, `beforeSend` checks again, 3.5 s to send,
  confirmation by a pushed status by 4.3 s or "sent, without confirmation".

## Development

```bash
npm install
npm test               # node --test (a real local TLS server, the real receiver)
npm run lint
npm run format:check
npm run cover          # regenerate cover.png (800×534)
```

Full CI locally on this VM: `gi ci`. See `CLAUDE.md` for the project rules and
`TODO.md` for the status and the decisions.

## License

Apache-2.0 (see `LICENSE`). Third-party notices: `THIRD_PARTY_NOTICES.md`.
