# Agilos

A fast, vertical, browser-based movement shooter: battle royale against bots, inspired by
Apex Legends' movement, Call of Duty's look and Counter-Strike's gunplay.

**Play:** https://dex0h.github.io/agilos/ (desktop browser, open it in its own tab)

## The game

- **Mode:** a battle royale for you and 4 bots. Everyone spawns at a random point,
  there are no respawns, and the last one standing wins. A safe zone shrinks in four
  phases and hurts anyone outside it.
- **Spawn shield:** 10 seconds of protection after spawning. Firing drops it early.
- **Map:** a vertical city block of nine open-sided buildings, 1 to 4 stories. It has
  stairs, bridges between floors and roofs, jumpable roof gaps and wall-jump chimneys.
- **Movement:** sprint, slide, slide-jump, double jump and wall jump. You can't kick
  off the same wall twice in a row.
- **Gunplay:** a handgun with CS-style accuracy. The first shot is perfect when you
  stand still, and spread grows with movement, jumping and fast follow-up shots. The
  cross crosshair shows the real spread.
- **Knife:** a melee slash, plus a flip animation.
- **Health:** 200 HP, which regenerates after 4 seconds out of combat.
- **Bots:** they use the same movement and gun code as you. They path up stairs, jump
  between roofs, strafe, stop to shoot, react to being shot and respect the zone.

## Controls

Defaults, rebindable from the menu (press Esc). Bindings follow physical key positions,
so they work on QWERTY, QWERTZ and AZERTY, and the labels match your layout.

| Key | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Look, click to shoot or slash |
| Space | Jump; again in the air for a double jump, or next to a wall for a wall jump |
| Shift | Sprint |
| C | Crouch; while sprinting, slide |
| R | Reload |
| 1 / 2 | Handgun / knife |
| F | Flip the knife |
| P | Toggle quality (high / fast) |
| [ / ] | Mouse sensitivity down / up |
| Esc | Menu and settings |
| Enter | New match, after you're eliminated or the match ends |

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173 (adds a window.agilos debug handle)
npm run build   # production build in dist/
```

Pushing to `main` builds and deploys to GitHub Pages through GitHub Actions.

## Code layout

| File | What it does |
| --- | --- |
| `src/main.js` | Renderer, game loop, HUD, input wiring |
| `src/character.js` | Shared movement, health and shield for players and bots |
| `src/player.js` | The local player: keyboard and mouse input, camera |
| `src/bots.js` | Bot AI and models |
| `src/nav.js` | Navigation graph and A* pathfinding for bots |
| `src/match.js` | Battle royale match flow and the zone |
| `src/world.js` | Combatants, hitscan, line of sight, kills, tracers |
| `src/gun.js` | Shared gun logic: ammo, reload, spread |
| `src/weapon.js`, `src/knife.js` | The player's weapons |
| `src/arena.js` | Map geometry, collision boxes and navigation points |
| `src/settings.js`, `src/controls-panel.js` | Key bindings, layouts, sensitivity, menu panel |
| `src/postfx.js`, `src/sky.js`, `src/textures.js`, `src/dust.js` | Visuals |
| `src/models.js` | Model loading and gun normalisation |

## Credits

- **Models:** by Quaternius (CC0), see [public/models/CREDITS.md](public/models/CREDITS.md).
- **Fonts:** Teko and Rajdhani (SIL Open Font License), via Fontsource.
- **Engine:** three.js (MIT).

## Security

See [SECURITY.md](SECURITY.md) for the penetration test report and how to report a
vulnerability.
