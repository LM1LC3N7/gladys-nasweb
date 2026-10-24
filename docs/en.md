# NASweb for Gladys Assistant

This integration brings a **NASweb module** (nasWebio, Chomtech) into Gladys,
on your local network, without any cloud: its **relay outputs**, its
**inputs** and its **temperature probe**.

Unofficial integration, not affiliated with nasWebio. **Never tested with a
real module**: it follows the local API used by the manufacturer's own
library (webio-api, the one of Home Assistant's NASweb integration). Please
report on the Gladys forum whether it works with yours.

## What you get

| On the module              | In Gladys                                                                |
| -------------------------- | ------------------------------------------------------------------------ |
| Relay output declared safe | A switch (on / off), only if you allow the commands                      |
| Other relay output         | Its state, read only (no command at all)                                 |
| Input                      | "Input active" (1 active, 0 normal) and "Input fault or tamper" (1 or 0) |
| Temperature probe          | Temperature in °C, once the module reported a value                      |

The outputs and inputs appear in the **Discovery** tab once the module has
sent its first status. Alarm zones and the thermostat of the module are not
offered (they arm, disarm or heat: out of scope for this first version).
The module API gives no humidity value: none is offered.

## How the states arrive

The module **pushes** its states: it posts them to an address it was given
(a "status subscription"). The integration container cannot receive
anything from the network, so Gladys starts a small **receiver** next to it
(the `nasweb-push` container, same image) and publishes one port for it,
chosen by Gladys and shown in the configuration screen. The integration
subscribes the module itself to `http://<address of Gladys>:<that port>/nasweb/<secret>`:

- the secret part is random, generated once for your installation, kept in
  the Gladys configuration (never shown), and never written to the logs;
- the receiver accepts exactly that address, the POST method, 32 KB at most
  and 120 posts a minute at most; everything else is refused;
- the integration then accepts a status only if it comes **from the address
  of the module** (option "Check the sender of the states") and carries
  **its serial number**.

If Docker hides the real address of the sender on your machine (every
status then seems to come from an address like 172.x.x.1, and the status
says so), turn off "Check the sender of the states": the secret address and
the serial number are still checked.

There is no other way to read the states: if no status arrives for 90
seconds, the devices are shown **unreachable**, the module is read again
(identity, subscription) at most once a minute, and the subscription is
renewed every 10 minutes.

## Configuration

1. Give the module a **fixed IP address** in your router.
2. In Gladys, Integrations → NASweb → Configuration:
   - **Address of the module**: its IP address (the one of its web page),
     optionally with its HTTPS port, for example `192.168.1.50`;
   - **Login** and **Password** of the web page of the module. The password
     is kept by Gladys in its database, never shown again, and only sent to
     the module, as the module expects it (a SHA-1 hash, which is as good as
     the password for the module: treat it as such);
   - **Address of Gladys**: the IP address of the machine running Gladys, as
     the module reaches it, for example `192.168.1.10` (no port);
   - save.
3. If your Gladys machine has a firewall, allow the port shown in the
   configuration screen (receiver block).
4. The status says "Connected" once the first status arrived. The outputs
   and inputs are then in the Discovery tab.

### Relay outputs: switches only when declared safe

A relay may drive a lamp, but also a pump, a boiler, a heater or a gate. A
switch is reached by "turn everything off" of voice assistants, of scenes
and of the dashboard. So:

- only the outputs listed in **Outputs declared safe** (their numbers, the
  NASWEB_OUTPUT parameter of the Discovery tab, for example `1, 2, 5`)
  become switches; list only loads that may be switched off or on at any
  time;
- every other output is its **state, read only**: no command can reach it
  from Gladys;
- **Allow the commands** is off by default: until you turn it on, every
  command is refused, even on a switch.

An output removed from the list keeps the switch already created in Gladys
(its history is kept), but every command on it is refused.

### When a command is accepted

A command on a switch is refused (nothing sent to the module) when:

- "Allow the commands" is off, or the output is not declared safe;
- the value is not exactly on (1) or off (0);
- no status arrived from the module for 90 seconds (the result could not be
  confirmed);
- the module refused the login, its certificate changed, or another serial
  number answers at its address;
- a command for the same output is still running;
- the module answers too slowly: the identity read and the command must
  leave within 3.5 seconds of the click.

Before each command the integration reads the identity of the module again
(its serial number). The command is confirmed only by a status of the module
showing the requested state within about 4 seconds; otherwise Gladys shows
"Sent, without confirmation".

## Security

- The module serves a self-signed certificate. Its fingerprint is **pinned**
  at the first connection (kept in `/data` before the login ever leaves);
  another certificate is refused before anything is sent. If you replaced or
  updated the module, the status shows the new fingerprint: press **Trust
  the device now answering** twice within 60 seconds (the first press only
  shows what answers). The same button accepts a new serial number (a
  replaced module: its outputs become new devices).
- A refused login stops everything, even after a restart: correct the
  credentials and save, or press **Test the connection**. The integration
  never retries by itself.
- No credential, secret address or token is ever written to the logs, to
  `/data` or to the status.

## Buttons

- **Test the connection**: reads the module now with the saved
  configuration (even after a refused login), subscribes it to the states,
  and says what answered. At most every 10 seconds.
- **Trust the device now answering**: see Security.

## Troubleshooting

- _"waiting for its first status"_: the module does not reach Gladys. Check
  the address of Gladys, the firewall of the Gladys machine, and that the
  module and Gladys are on the same network (or routed). Browsing Gladys
  through Gladys Plus or a reverse proxy does not change anything: the
  module must reach the LAN address of the Gladys machine.
- _"status(es) refused: they came from 172…"_: see "How the states arrive".
- _"Module unreachable"_: check the address of the module and that its web
  page opens.
