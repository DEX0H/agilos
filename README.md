# Agilos

Browser FPS movement shooter. Planned: a small vertical battle-royale-style arena, mobs/enemies, and a handgun to start.

## Status

- **Iteration 1 (in progress):** movement test room. WASD, mouse look, sprint, jump, double jump, auto step-up, stepped arena with platforms and a tower.
- Next: handgun (hitscan, recoil, reload, HUD), then basic mobs, then networking for battle royale.

## Run locally

```sh
npm install
npm run dev     # http://localhost:5173
npm run build   # production build in dist/
```

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Mouse | Look (click the page to lock the mouse) |
| Space | Jump; press again in the air for a double jump |
| Shift | Sprint |
| Esc | Release the mouse |

## Layout

- `src/main.js`: renderer, scene, game loop, HUD
- `src/player.js`: first-person controller and AABB collision
- `src/arena.js`: test arena geometry and colliders
