# Security and penetration test report

**Project:** Agilos (browser FPS), https://github.com/DEX0H/agilos
**Live site:** https://dex0h.github.io/agilos/
**Test date:** 21 October 2026
**Tested version:** `798eb06` (fixes verified on the live site after deploy)

## Summary

Agilos is a static, client-only web game hosted on GitHub Pages. There is no backend, no
login, no database, no user accounts and no data sent anywhere. That keeps the attack
surface small: the deployed files, the one piece of stored input (settings in the
browser's localStorage), the GitHub repository and its deploy pipeline.

No critical or high-severity issues were found. Three issues were fixed, three
hardening measures were added, and the remaining risks are listed with recommendations.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | Personal email address in public commit metadata | Medium (privacy) | Fixed |
| 2 | Tampered localStorage settings accepted without validation | Low | Fixed |
| 3 | Debug handle exposed on every page load | Low | Fixed |
| 4 | Dev-server vulnerability in a build dependency (esbuild) | Low (dev only) | Fixed |
| 5 | No Content-Security-Policy | Informational | Hardened |
| 6 | No guard against committing secrets | Informational | Hardened |
| 7 | Game can be embedded in other sites (clickjacking) | Informational | Accepted |
| 8 | All game logic runs on the client (cheating) | Informational | Accepted for now |

## Scope and method

In scope:

- The live site and every file it serves.
- The source code and full git history.
- Dependencies (`npm audit`).
- The GitHub Actions deploy workflow.

Out of scope: GitHub's and GitHub Pages' own infrastructure, and the player's browser.

Method:

- Read the code for every place that takes input (URL, keyboard, localStorage).
- Searched all tracked files and every commit for secrets, keys, tokens, `.env` files
  and personal data.
- Listed every request the live site makes and every file in the build output.
- Attacked the live site in a real browser: injected script payloads into stored
  settings, tried prototype pollution and invalid numbers, and confirmed that the
  Content-Security-Policy blocks injected inline and third-party scripts.

## Findings

### 1. Personal email address in commit metadata (fixed)

The first 25 commits were authored with a personal email address, visible to anyone
browsing the repository.

**Fix:** history was rewritten so every commit uses the GitHub noreply address
(`<id>+DEX0H@users.noreply.github.com`), and the repository's git config uses it for new
commits. The rewrite was verified commit by commit and the files are identical.

**Residual risk:** GitHub may keep the old, now unreferenced commits reachable by their
exact hash for a while, and anyone who cloned before the rewrite still has them. If that
matters, GitHub Support can purge cached views of the old commits.

### 2. Tampered settings accepted without validation (fixed)

Key bindings, keyboard layout and mouse sensitivity are saved in localStorage. Any
player can edit their own storage. Testing showed:

- Script payloads such as `<img onerror=...>` and `<svg onload=...>` stored as key
  bindings were **not** executed. The game only ever writes text (`textContent`), never
  HTML, so this was not an XSS hole.
- A `__proto__` key did **not** pollute the global object prototype.
- Junk values were still accepted: a key bound to garbage and a blank layout picker
  broke controls for that player.

**Fix:** saved settings are now validated on load. Only known actions with plausible key
codes, a known layout and a finite sensitivity clamped to 0.1–10 are accepted; anything
else falls back to the defaults. Re-tested on the live site: the poisoned settings were
rejected.

### 3. Debug handle exposed on every page load (fixed)

`window.agilos` gave anyone opening the browser console direct access to game state
(health, position, bots). In a single-player game that only affects the person doing it,
but there was no reason to ship it to everyone.

**Fix:** it now exists only in local development or with `?debug` in the URL.

### 4. Dev-server vulnerability in esbuild (fixed)

`npm audit` reported GHSA-67mh-4wv8-2f99 (moderate) in esbuild, used by Vite. It
affects only the local development server, never the published site.

**Fix:** upgraded Vite to 6.4. `npm audit` now reports 0 vulnerabilities, including
development dependencies.

### 5. Content-Security-Policy (hardened)

GitHub Pages can't send custom HTTP headers, so the policy is a `<meta>` tag in
`index.html`. Scripts, styles, fonts, images and requests may only come from the game's
own origin. Exceptions:

- `'wasm-unsafe-eval'`, needed by the meshopt model decoder (WebAssembly).
- `blob:` and `data:`, for textures decoded from models.
- Inline styles.

Objects and forms are blocked, the base URI is fixed, and the referrer policy is
`no-referrer`. Verified on the live site: the game loads fully, and an injected inline
script and a script from an outside CDN were both refused.

### 6. Guard against committing secrets (hardened)

No secrets were found in the code or in any commit, and the game uses no environment
variables or API keys. `.gitignore` now blocks the following, so they can't be committed
by accident:

- `.env` files
- Private keys and certificates
- Credential and service-account JSON files
- Firebase local files

### 7. Clickjacking (accepted)

Other sites can embed the game in an iframe. `frame-ancestors` doesn't work from a
`<meta>` tag and GitHub Pages can't send `X-Frame-Options`. The game has no sensitive
actions (no accounts, payments or settings that leave the browser), so the impact is
negligible. Revisit if the game moves to a host that supports headers.

### 8. Client-side game logic (accepted for now)

All rules run in the player's browser, so a determined player can change their own game
(health, aim, speed). With bots only, this harms no one else. **Before real multiplayer
ships, the server must be authoritative:** it should validate movement, hits, damage and
the match state, and clients should only send inputs.

## Things that were checked and found fine

- **Requests:** every request the live site makes goes to its own origin. There are no
  third-party scripts, trackers, analytics or CDNs.
- **Build output:** no source maps and no secrets.
- **Text output:** HUD, kill feed, menus and bot name tags are all written as text, so
  player-controlled strings can't become HTML.
- **URL parameters:** none are reflected into the page; only the presence of `?debug` is
  read.
- **Deploy workflow:**
  - It runs only on pushes to `main` and manual runs by people with write access. There
    are no `pull_request_target` triggers and no untrusted inputs in scripts.
  - It uses only official `actions/*` actions.
  - Its permissions are minimal: `contents: read`, `pages: write`, `id-token: write`.
- **Asset licences:** all models are CC0 and the fonts are SIL OFL, both safe to
  redistribute.

## Recommendations

These need repository-owner access in GitHub's settings:

1. Turn on branch protection for `main`, requiring a pull request and blocking force
   pushes. Force pushes were needed once for the email rewrite and should otherwise stay
   off.
2. Turn on Dependabot alerts and security updates.
3. Pin the workflow's actions to full commit SHAs instead of version tags.
4. Make sure two-factor authentication is on for the GitHub account.
5. When multiplayer is added, design for an authoritative server and never trust client
   reports of hits, damage or position.

## How to report a vulnerability

Please open a private security advisory on the repository
(**Security → Advisories → Report a vulnerability**) rather than a public issue.
