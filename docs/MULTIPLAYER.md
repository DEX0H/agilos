# Multiplayer design: authoritative server

**Status (2026-10-25):** hosted lobbies are built on this design, with the host's game in
the server's role (`src/net/`). Code map:

| File | Role |
| --- | --- |
| `signal.js` | Lobby codes and the offer/answer exchange (Firestore, or a BroadcastChannel with `?net=local`) |
| `peer.js` | One WebRTC connection: `state` (unreliable) and `events` (reliable) channels, ping |
| `proto.js` | Binary input (36 bytes) and snapshot (64 + 30 bytes per player) formats, with validation |
| `host.js` | The authority: accepts players, runs their characters, snapshots at 30 Hz, events, lag compensation |
| `actors.js` | `RemotePlayer` (a player's character on the host) and `Puppet` (everyone else on a joining player's game) |
| `client.js` | Prediction and replay for your own movement, interpolation 100 ms behind for others |
| `lobby-ui.js` | Host / join menu and the lobby card |

Testing (dev server, `npm run dev`): `?debug&net=local` connects tabs through a BroadcastChannel; `&lag=60` adds 60 ms
each way; `&norender` skips drawing; `&lots=3` forces the small map.

Today every rule of Agilos runs in the player's browser. That's fine with bots, because a
player who edits their own game only affects themselves. With real players it isn't:
a client could claim any position, hit or damage. This note fixes the rules for when
multiplayer is added.

## The rule

**The server decides what happened. Clients only send what they pressed.**

A client never reports its position, a hit, damage, a kill or its health. It sends
inputs; the server simulates, then tells everyone the result.

## How it maps onto the current code

The code was split this way on purpose, so the same simulation can run on the server.

| Today | With multiplayer |
| --- | --- |
| `Character.simulate(dt, input)`: movement from an input object | Runs on the **server** for every player. Clients run it too, only to predict their own movement. |
| `Player` turns keyboard and mouse into that input object | Sends the input object plus its sequence number and aim (yaw, pitch) to the server each tick. |
| `GunState.fire()` + `World.raycastCombatants()` | Run on the **server** only. The client asks to fire; the server checks ammo, fire rate and spread and does the hitscan. |
| `Character.takeDamage()`, health, shield, kills | **Server** only. Clients just display what the server sends. |
| `Match` (zone, alive count, winner) | **Server** only. |
| Bots | Run on the server as `Character`s with AI input, exactly like now. |

## Messages

Client to server, every tick (for example 60 Hz):

```
{ seq, forward, strafe, sprint, crouch, jump, yaw, pitch, fire, reload, weapon }
```

Every field is validated: numbers clamped to their range (`forward`/`strafe` in -1..1,
`pitch` within the look limits), booleans as booleans, `weapon` from a fixed list.
Anything else is dropped.

Server to clients, every tick or two: a snapshot of positions, velocities, aim, health,
ammo and match state, plus events (shots, hits, kills) and the last input `seq` the
server processed for that client.

## Keeping it responsive

- **Client-side prediction:** the client applies its own inputs immediately with the
  shared `Character.simulate`, then corrects to the server's position when a snapshot
  arrives, replaying any inputs the server hasn't processed yet.
- **Interpolation:** other players are drawn slightly in the past, between the two
  latest snapshots, so they move smoothly.
- **Lag compensation:** when a shot arrives, the server rewinds other players to where
  the shooter saw them (capped, for example 200 ms) before the hitscan, so aiming at
  what you see works.

## Anti-cheat checks on the server

- **Fire rate, ammo, reload and spread** come from `GunState` on the server. A client
  can't fire faster or more accurately than the rules allow.
- **Movement** comes from simulating inputs, so speed, jump height and walls are always
  enforced.
- **Aim changes** are rate-checked (for example a cap on turn speed per tick) to flag
  obvious aimbots.
- **Line of sight** for hits is checked on the server with `World.lineOfSight`.
- **Rate limits:** messages per second per connection are capped, and connections
  that flood are dropped.
- **Identity:** a player's id comes from the server's own session, never from a field
  the client sends.

## Things never to do

- Accept "I hit player X for N damage" or "I am at position P" from a client.
- Trust a client's clock for cooldowns or the zone.
- Send other players' hidden information (for example positions behind walls far away)
  that the client doesn't need to draw; that's what wallhacks read.
