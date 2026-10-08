# D&E: Dungeons & Ellis

A small multiplayer virtual tabletop for running D&D-style one-shots with a human DM. Players pick a fixed hero, move on a shared grid, and act through the action ring (the "donut") around their token. The server handles dice, HP, movement, and combat phases. The DM has the final say on everything.

Production: `https://oneshot.elliscode.com` (Mac Mini + Caddy).

## Run locally

Requires Node 22.13+ (it uses the built-in `node:sqlite`; developed on Node 24).

```sh
npm install
cp .env.example .env      # set DM_PASSWORD; set SECURE_COOKIES=false for plain http://localhost
npm start                 # http://127.0.0.1:3000
npm test                  # unit + socket integration tests
```

`npm run dev` restarts the server when files change.

## How it works

- **Scenes** (DM home → Scenes) are reusable map templates. Each one has a background, an independent grid (columns, rows, cell size, offset), objects and obstacles, starting NPC/monster placements, and a player spawn square. The default spawn is the bottom-left square.
- **Games** are actual adventures. When you add a scene to a game, the game gets its own live copy (a *scene instance*). Moving or hurting things in a game never changes the template, and editing the template later never changes games that already use it.
- **Players** open the game link, enter a name, pick Tank / DPS / Heal, and then pick a hero. They can do all of this before the DM shows up. The browser remembers each seat as a `playerId` plus a server-issued secret, so refreshing or reconnecting puts the player back on the same hero. Name changes keep the seat, color, and hero.
- **DM controls** (Games → Open):
  - *Scenes tab:* add scenes, switch the active scene, remove scenes.
  - *Players tab:* see presence, change colors, **Release** (frees the hero so the player picks again), **✕** (removes the seat; that browser can't rejoin as that player).
  - *Banks tab:* place NPCs and monsters, choosing *scene* scope (stays in this scene) or *game* scope (follows the party).
  - *Board:* drag any token to move it. Click a stack to see every token in it, including the ones underneath. Click a token to open the inspector: damage, heal, set HP, kill, revive, scope, hostility, inventory, attacks, extra actions.
  - *Top bar:* start and end combat, switch phases, set the phase timer (off / 30 / 60 / 90 / 120 / custom), and **Undo**.
- **Combat:** the game alternates between PLAYER PHASE and DM PHASE. During the player phase, every player gets one action (attack, act, ability, or item) plus their movement, in any order. Abilities with `grantsActions` give extra actions. The timer runs on the server; when it expires, the server switches phases. Players can't attack outside combat.
- **HP:** at 0 HP a player character or NPC goes DOWN, and their only option is a d20 roll. If a DOWN character takes damage ≥ their max HP, they die. Monsters die at 0 HP. The DM can always revive or override.
- **Hidden info:** the server strips HP and stats for monsters and hostile NPCs from everything it sends to players, including activity log text. The DM sees everything.
- **Undo** covers moves, damage/heal/HP changes, attacks, spawns and removals, scope changes, items, acts, and abilities, up to the last 20. Structural actions (scene changes, hero selection or release, combat start, end, and phase changes) clear the undo history.
- **Chat:** `/roll 2d6+1` in chat makes a server roll that shows in the activity log.

## Content

Definitions live in `data/` and load at startup. Edit them, then restart the server.

| Path | What |
| --- | --- |
| `data/characters/*.json` | Heroes (`role`: `tank` / `dps` / `heal`) |
| `data/monsters/*.json`, `data/npcs/*.json` | Bank definitions (`size: {w,h}` for large creatures; NPC `hostile: true` hides their HP) |
| `data/acts.json` | Generic actions in the Act menu (optional `roll`) |
| `static/backgrounds`, `static/tokens`, `static/images` | Art, referenced as `/static/...` |

Attack fields: `attack` (to-hit dice), `damage`, `range` (squares). Ability fields: `heal` + `range` (targets an ally and applies the healing), `roll` (narrative roll), `grantsActions`, `free`. Dice notation: `NdX±M` with d4/d6/d8/d10/d12/d20, and terms can be chained (`1d8+1d6+2`). A natural 20 is a crit (damage dice doubled). A natural 1 always misses.

The included art is generated placeholder art (`npm run placeholders`). Replace the SVG/PNG files, or point definitions at new files. Running the generator never overwrites existing files unless you pass `--force`.

## Deploy

1. `npm install --omit=dev`, then create `.env` from `.env.example`. Use a strong `DM_PASSWORD`, a random `SESSION_SECRET`, and `SECURE_COOKIES=true`. Keep `HOST=127.0.0.1` when Caddy runs on the same machine.
2. Start the server: `npm start` (stop it with Ctrl-C; state is saved continuously, so stopping and restarting is safe mid-game).
3. Add the site block from `deploy/Caddyfile` to your Caddy config. It proxies `oneshot.elliscode.com` to `127.0.0.1:3000`; adjust the upstream if `HOST`/`PORT` differ. Caddy handles HTTPS and the WebSocket upgrade.

**Backups:** everything lives in `data/d-and-e.sqlite` (plus the `-wal`/`-shm` files while the server runs). To back up safely while it's running, use `sqlite3 data/d-and-e.sqlite ".backup backup.sqlite"`.

## Layout

```
server/
  index.js        HTTP routes, pages, startup
  sockets.js      /play and /dm Socket.IO namespaces
  auth.js         DM password + signed cookie
  db.js           SQLite schema
  dice.js         dice parser/roller
  content.js      loads data/ definitions
  templates.js    scene template store + validation
  games/
    service.js    game cache, dispatch → persist → broadcast, undo, timers, presence
    commands.js   every game command (validation + rules)
    combat.js     phases, damage/heal/down/death, attack resolution
    placement.js  spawn + placement of entities in scenes
    project.js    per-viewer state (hides enemy HP from players)
    state.js      state shape and helpers
client/           vanilla JS pages (home, editor, DM game, player)
test/             node:test suites
```

Every state change goes through `GameService.dispatch()`. It validates the command, applies it to the in-memory game, writes the new state, activity entries, and undo snapshot in one SQLite transaction, then sends each connected client its own filtered view. A failed command rolls back to the previous state.
