# Agilos

A fast, vertical, browser-based movement shooter: battle royale against bots, inspired by
Apex Legends' movement, Call of Duty's look and Counter-Strike's gunplay.

**Play in the browser:** https://dex0h.github.io/agilos/ (desktop browser, open it in its own tab)

**Download for Windows:** [Agilos-Setup.exe](https://github.com/DEX0H/agilos/releases/latest/download/Agilos-Setup.exe)
(Windows 10 and 11, 64-bit; [all releases](https://github.com/DEX0H/agilos/releases),
[code signing policy](#code-signing-policy)). The installer adds Start menu and desktop
shortcuts and the game keeps itself on the latest version: every change released here
reaches installed copies automatically (checked at launch and every 20 minutes, installed
when you close the game or with "Restart to update" in the menu). Uninstall from Windows
Settings > Apps > Agilos.

## The game

- **Mode:** a battle royale for you and 1 to 15 bots (4 by default, set in the menu).
  Everyone spawns at a random point, there are no respawns, and the last one standing wins.
- **Play with friends:** sign in, press **Host a lobby** and send your 6-letter code. Friends
  type it in and press **Join**. The host picks the lobby size (2 to 16) and whether bots fill
  the empty spots, then starts the match. Games connect directly to each other (WebRTC); the
  host's game runs the match. Someone who drops out mid-match is played on by a bot.
- **The ring:** six Apex-style rounds. Each round the next ring is marked (white wall, and a
  dashed circle on the minimap), then the ring closes onto it. Outside, you take damage
  every 1.5 seconds, more each round (3 up to 25), and the last ring closes completely.
- **Minimap:** top right, north up: the ring, the next ring, buildings, mystery boxes and you.
- **Spawn shield:** 10 seconds of protection after spawning. Firing drops it early.
- **Map:** a vertical city block of nine open-sided buildings, 1 to 4 stories. It has
  stairs, bridges between floors and roofs, jumpable roof gaps and wall-jump chimneys.
- **Movement:** sprint, slide, slide-jump, double jump and wall jump. You can't kick
  off the same wall twice in a row.
- **Gunplay:** a handgun with CS-style accuracy. The first shot is perfect when you
  stand still, and spread grows with movement, jumping and fast follow-up shots. The
  cross crosshair shows the real spread.
- **Mystery boxes:** four glowing crates sit against walls in random spots, new ones every
  match; their light beams show where they are. Press E at one for a short spin, and the
  weapon it lands on goes straight into your gun slot. A box then recharges for 20 seconds.
  - **SMG** (common, 55%): fast automatic fire, accurate on the move, weak at range.
  - **Assault rifle** (rare, 35%): automatic, hits harder and reaches farther.
  - **Sniper** (legendary, 10%): one body shot kills. Right mouse to scope; unscoped
    shots are a gamble.
  - You lose the box weapon when you die, and bots use the boxes too.
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
| Mouse | Look, click to shoot or slash (hold for automatic weapons) |
| Right mouse | Scope (sniper) |
| E | Use a mystery box |
| Space | Jump; again in the air for a double jump, or next to a wall for a wall jump |
| Shift | Sprint |
| Ctrl | Crouch; press while running to slide (crouch and slide are separate bindings, both on Ctrl by default). A new slide needs a fresh press and comes at most every 1.6 s. In the browser the game plays fullscreen while Ctrl is bound, so Ctrl+W can't close the tab (Fullscreen setting) |
| R | Reload |
| 1 / 2 | Gun (handgun or box weapon) / knife |
| F | Flip the knife |
| P | Toggle quality (high / fast) |
| [ / ] | Mouse sensitivity down / up |
| Esc | Menu and settings |
| Enter | New match, after you're eliminated or the match ends |

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173 (add ?debug for a window.agilos test handle)
npm run build   # production build in dist/
```

Sign-in and cloud stats need the Firebase web settings, which are not in the repository:
copy `.env.example` to `.env.local` and fill it in. Without it the game runs in guest
mode. CI reads them from the repository secrets `FIREBASE_API_KEY` and `FIREBASE_APP_ID`.

Pushing to `main` builds and deploys to GitHub Pages through GitHub Actions.

### Windows app

The Windows app is the same game in an [Electron](https://www.electronjs.org/) window
(`electron/`), packaged with electron-builder.

```sh
npm run app        # build, then run the desktop app
npm run dist:win   # build the installer into release/ (on Windows)
```

Releases are automatic: every merge to `main` (except docs-only changes) runs the
[release workflow](.github/workflows/release.yml), which builds the installer on Windows
as version `<major>.<minor>.<run number>` and publishes it to GitHub Releases, where the
download button and the in-app updater find it.

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
| `src/weapon.js`, `src/knife.js` | The player's gun slot (viewmodel, scope) and knife |
| `src/mysterybox.js` | Mystery boxes: placement, spin, rarity roll |
| `src/gunmodels.js` | Models for the SMG, assault rifle and sniper |
| `src/arena.js` | Map geometry, collision boxes and navigation points |
| `src/settings.js`, `src/controls-panel.js` | Key bindings, layouts, sensitivity, menu panel |
| `src/postfx.js`, `src/sky.js`, `src/textures.js`, `src/dust.js` | Visuals |
| `src/models.js` | Model loading and gun normalisation |
| `src/net/` | Multiplayer: lobby signaling, WebRTC peers, the host's authority, prediction and interpolation on joining players, lobby menu |

## Credits

- **Models:** by Quaternius (CC0), see [public/models/CREDITS.md](public/models/CREDITS.md).
- **Fonts:** Teko and Rajdhani (SIL Open Font License), via Fontsource.
- **Engine:** three.js (MIT).

## Code signing policy

Windows releases are built only by this repository's
[release workflow](.github/workflows/release.yml) on GitHub Actions, from the tagged source.
Nothing is built or signed on a personal machine.

- **Signing:** installers are currently not code-signed, so Windows SmartScreen may warn
  on first install (More info > Run anyway). The release workflow can sign through
  SignPath.io once that is set up ([SIGNING.md](SIGNING.md)).
- **Team roles:** authors, reviewers and approvers:
  [@DEX0H](https://github.com/DEX0H) (owner). Every change reaches `main` through a pull
  request with a passing CI build, and every signing request is approved by hand.
- **What is signed:** `Agilos.exe` and the `Agilos-Setup.exe` installer, product name
  "Agilos". Electron's own runtime files are upstream binaries.

## Privacy

The game has no analytics or ads. Playing as a guest stores nothing outside your device.
If you create an account, you only choose a username and a password (no email). Firebase
(Google) stores your username, colour, settings and match stats, in the EU (eur3). Only
you can read them. "Delete account and stats" in the profile menu removes all of it.
Passwords can't be recovered, since there is no email to send a reset to.

Apart from sign-in, stats and lobbies, the browser version talks only to its own website.
In a lobby, your game connects directly to the host's game, so the two of you can see each
other's network (IP) address, as with any peer-to-peer game. The connection details pass
through Firebase only while connecting and are deleted once you're in. Only play with
people you're happy to share that with. The
Windows app also checks GitHub Releases (github.com) for updates at launch and every 20
minutes; untick "Check for updates" in the menu to turn that off. Local settings stay on
your computer (browser storage, or the app's folder under `%APPDATA%\Agilos`).

## License

Code: [MIT](LICENSE). Models, textures and fonts keep their own licences (CC0 and SIL
OFL), see [public/models/CREDITS.md](public/models/CREDITS.md).

## Security

See [SECURITY.md](SECURITY.md) for the penetration test report and how to report a
vulnerability.
