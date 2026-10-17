# One & Done — Final Design & Implementation Handoff

## 1. Project Overview

Build **One & Done**, a lightweight, multiplayer, browser-based virtual tabletop designed specifically for running D&D-style one-shots with a human Dungeon Master (DM).

**Production URL:** `https://oneshot.elliscode.com`

This is a private tool for a specific tabletop gaming group, not a public VTT platform.

The goal is to create a fast, cooperative dungeon-crawler experience controlled by a human DM. Players select predefined heroes, move around a shared grid, and perform actions. The application handles basic mechanics, dice, health, movement, combat phases, and bookkeeping while leaving narrative decisions and ultimate authority to the DM.

The application should be purpose-built, easy to use, and intentionally limited in scope.

### Product philosophy

One & Done should feel like:

> A fast cooperative dungeon-crawler controlled by a human DM.

It should NOT feel like:

> A web application for managing D&D.

Prioritize gameplay, speed, clarity, and simplicity over comprehensive tabletop rules or configuration options.

## 2. Technology Stack and Hosting

The application will run on a Mac Mini hosted in the user's basement.

- Node.js and npm.
- Express or an equivalent lightweight HTTP server.
- WebSockets, preferably Socket.IO, for real-time multiplayer updates.
- SQLite for persistence.
- Vanilla HTML, CSS, and JavaScript are preferred unless a frontend framework materially simplifies implementation.
- Caddy handles reverse proxying and HTTPS.
- Public URL: `https://oneshot.elliscode.com`.

Keep the architecture straightforward and suitable for one small gaming group.

Avoid unnecessary infrastructure, including microservices, Kubernetes, Redis, GraphQL, PostgreSQL, OAuth, and elaborate authentication frameworks.

The server is authoritative for game state, dice rolls, combat phases, character ownership, and other rule-enforced actions.

## 3. Core Architecture: Scenes, Games, and Instances

This is one of the most important architectural decisions.

One & Done has two primary DM-facing areas: **Scenes** and **Games**.

A Scene is a reusable template. A Game is an actual playable adventure. A Scene Instance is a live copy of a scene used within a particular game.

### 3.1 Scene templates

Scene templates are reusable content created by the DM.

A scene template defines:

- Background image.
- Grid configuration.
- Static objects and obstacles.
- Initial NPC and monster placements, where applicable.
- Player spawn location.
- Other map-specific configuration.

Scenes are managed through the Scenes section of the DM interface.

The DM can create, edit, save, and reuse scenes. A scene template is not itself a running encounter.

### 3.2 Games

A Game represents an actual one-shot adventure.

A game contains:

- Its own game ID.
- Its own player roster and player identities.
- Character assignments and player colors.
- Its own collection of scene instances.
- An optional active scene.
- Game-level NPC and monster instances.
- Combat state and other live game state.
- Chat and activity history.
- Persistent state needed to resume the adventure.

A game can exist before the DM joins it. Players can join through the game link without the DM being present.

Games must survive browser refreshes, disconnects, and server restarts.

### 3.3 Scene instances

When the DM adds a scene template to a game, create a scene instance associated with that game.

A scene instance has its own live state, including:

- Entity placements.
- Positions of scene-scoped NPCs and monsters.
- Their current HP, status, inventory, and other mutable state.
- Any other mutable gameplay data associated with that instance.

A scene instance must not directly mutate its source scene template.

For example, moving a monster in a running game must not change its position in the reusable template.

If the same template is added to two games, each game gets independent state. Multiple instances of the same template should also be independently representable.

### 3.4 Switching scenes

A game may contain multiple scene instances.

The DM can add scenes, select the active scene, and switch between them at any time.

When switching scenes:

- Player characters appear in the newly active scene.
- Game-scoped NPCs and monsters appear in the newly active scene.
- Scene-scoped NPCs and monsters remain associated with their original scene instance.
- Scene-scoped entities retain their most recently used positions and state when that scene is revisited.
- The new scene uses its own background, grid, and placements.

When a game has no active scene, players see:

**"Waiting for DM to set active scene"**

Players should not see the scene library or have to choose scenes themselves.

## 4. DM Navigation and Workflows

When the DM opens the application, they see two primary options:

- **Scenes**
- **Games**

DM authentication must be separate from the player-facing game URL. Possession of a player game link must not grant DM privileges.

### 4.1 Scenes section

The Scenes section is the scene-building environment.

The DM can:

- View saved scene templates.
- Create a new scene.
- Open and edit an existing scene.
- Select a background.
- Configure the grid.
- Place, remove, and position objects.
- Place and configure obstacles.
- Define NPC and monster placements or initial configurations.
- Configure player spawn.
- Save changes to the template.

Provide a clear **Scene Edit** mode indicator or toggle while editing scenes.

Scene editing modifies reusable templates, not live game instances.

### 4.2 Games section

The Games section displays all games accessible to the DM.

The DM can:

- Create a new game.
- Open an existing game.
- Delete a game, with confirmation.
- View the game's current state.
- Access or copy its player join link.
- Add scenes to the game.
- Select the active scene.
- Remove scenes from the game.
- Manage players and their character assignments.
- Run gameplay and combat.
- Add and manage NPCs and monsters.

Deleting a scene from a game should not delete the reusable scene template.

Deleting a game should not delete the scene templates it references.

### 4.3 Inside a game

The DM enters a live game environment.

The DM can select an existing scene instance or add another scene from the template library.

When a scene is selected, the DM sees the live scene instance, including players, entities, and the map.

During gameplay, the DM can:

- Move any token.
- Add or remove NPCs and monsters.
- Use NPC and monster banks.
- Change entity scope between scene-level and game-level.
- Damage, heal, or set HP.
- Kill, revive, or otherwise override an entity's state.
- Start and end combat.
- Advance combat phases.
- Configure the combat timer.
- Switch the active scene.
- Manage player characters and reset their assignments.
- Undo the last supported action.

**The underlying map layout cannot be edited in Game mode.**

Game mode is for running the adventure, not editing reusable map templates. Map construction happens in Scenes.

The DM can still position live entities and manipulate gameplay state during a game.

## 5. Player Login, Identity, and Character Selection

The player experience should be extremely simple.

### 5.1 Player flow

When a player opens a game link:

1. Enter their name, or accept a previously remembered name.
2. Choose a role.
3. Choose a character from the available roster.
4. Enter the currently active scene.

The role selection screen offers:

- Tank.
- DPS.
- Heal.

Character selection should be conceptually similar to choosing a hero in Overwatch or Team Fortress 2. These are fixed gameplay characters, not traditional D&D character creation.

If no scene is active, the player waits on a screen displaying:

**"Waiting for DM to set active scene"**

Once a scene becomes active, the player enters it automatically.

### 5.2 Display name

On first visit, ask:

**"What's your name?"**

Persist the display name in browser `localStorage`, so returning players can accept their previous name without re-entering it.

The player can change their display name at any time.

Changing the display name must not create a new player identity or release their character.

### 5.3 Player identity and session IDs

Each player needs a generated, stable player identifier for their seat in a particular game.

For example:

`playerId = "p_8f3a91c2"`

Store the identifier in `localStorage` so the same browser can reconnect to the same player identity.

Conceptually:

- Game join token: allows access to the game.
- Player ID: identifies the player's seat within that game.
- Display name: the name shown to other players.
- Character assignment: the hero currently locked to that player.

The player ID is not an authentication credential. The game link provides access to the game; the player ID supports continuity and reconnection.

Do not use display names as primary keys.

Changing names must preserve character ownership, color, and player identity.

### 5.4 Character locking and reconnection

After selecting a character, the character is locked to that player's identity within the game.

On returning with the same browser and game link, the player reconnects to their existing character instead of being asked to select another.

The server must enforce ownership and prevent two players from claiming the same character.

Implement a configurable reconnection grace period so temporary disconnects do not immediately release a character.

The DM can release a character or reset a player's assignment if needed.

Provide a **Reset Player / Release Character** action for the DM. Resetting must invalidate the previous player-to-character association so an old browser cannot unexpectedly reclaim it.

After a reset, the player can select a role and character again.

A reset should not accidentally delete unrelated game state.

### 5.5 Character selection and scene entry

Character selection must work even if the DM has not yet joined the game.

Once the character is selected, the player remains assigned to that character while waiting for an active scene.

When a scene becomes active, the player's token appears at the designated player spawn, or the default spawn if none is configured.

## 6. Character and Entity Models

### 6.1 Player characters

Player characters are fixed, predefined gameplay packages.

Each character definition includes:

- ID.
- Display name.
- Role.
- Token/image reference.
- Maximum HP.
- Movement allowance.
- Attacks.
- Abilities.
- Starting inventory.
- Optional defense and other basic combat statistics.

Example:

```json
{
  "id": "fire-mage",
  "name": "Fire Mage",
  "role": "dps",
  "maxHp": 30,
  "movement": 6,
  "defense": 15,
  "attacks": [
    {
      "id": "fire-bolt",
      "name": "Fire Bolt",
      "attack": "1d20+5",
      "damage": "1d8+3",
      "range": 8
    }
  ],
  "abilities": [],
  "inventory": ["rope", "healing-potion"]
}
```

This is an illustrative schema, not a mandatory exact implementation.

Separate character definitions from mutable character state.

A character definition describes the hero. The live game state stores current HP, status, inventory, position, and other mutable information.

### 6.2 NPCs

NPCs are characters controlled by the DM.

Examples include merchants, guards, quest-givers, allies, and recurring named characters.

NPCs can use token-style assets just like player characters or use larger image assets.

NPCs may have HP, inventory, abilities, status, and other state as appropriate.

An NPC is not necessarily hostile.

### 6.3 Monsters

Monsters are DM-controlled creatures generally used as enemies.

Monsters may use either:

- Token-style assets.
- Larger image assets that scale to the configured grid footprint.

Monsters support the basic gameplay state required for encounters, including HP, defense, attacks, position, and death state.

NPCs and monsters share the underlying concept of a DM-controlled entity, but their definitions can have different defaults and available configuration.

### 6.4 Objects and obstacles

Objects include chests, barrels, doors, rocks, scenery, and similar items.

Objects may be visual-only or interactable.

Do not implement an elaborate object physics or interaction engine.

### 6.5 No weapon or progression system

Do not implement:

- Weapon equipment or swapping.
- Equipment progression.
- Lootable weapons.
- XP or leveling.
- Persistent character advancement.
- Traditional D&D character sheets.

Attacks belong directly to the character or monster definition.

## 7. Entity Scope and Persistence

NPC and monster instances can be either **scene-scoped** or **game-scoped**. This distinction is independent of whether the entity is an NPC or a monster.

The DM can change an entity's scope at any time.

### 7.1 Scene-scoped entities

A scene-scoped entity belongs to a particular scene instance.

Examples include five rats in a single encounter.

Its mutable state persists with that scene instance, including:

- Position.
- Current HP.
- Status.
- Inventory.
- Other applicable gameplay state.

Leaving the scene does not automatically destroy these entities. They remain associated with that scene instance and reappear in their most recently used positions when the DM returns.

They do not automatically follow the party into other scenes.

### 7.2 Game-scoped entities

A game-scoped entity belongs to the game rather than an individual scene.

Examples include Walky the Wize, a recurring NPC who accompanies the party throughout the adventure.

Game-scoped entities appear in the active scene alongside player characters. Their state persists across scene transitions.

Preserve applicable properties such as:

- Current and maximum HP.
- Status and conditions.
- Inventory.
- Abilities and other mutable state.
- Other relevant entity state.

When a new scene becomes active, game-scoped entities appear in that scene. Initialize or assign a suitable position in the new scene without carrying over an invalid grid coordinate from the previous scene.

### 7.3 Changing scope

The DM must be able to promote a scene-scoped entity to game scope or demote a game-scoped entity to scene scope.

For example:

- Promote an important NPC so they accompany the party.
- Demote a temporary ally so they remain in the current scene.
- Promote a recurring villain so their HP and status persist between encounters.

Scope changes must preserve the entity's current state.

When promoting an entity, define how its current state transfers to game scope and where it appears in the active scene.

When demoting an entity, associate it with the selected scene instance and preserve its current state and position as appropriate.

Avoid accidental duplication or loss of entities during scope changes.

### 7.4 Entity definitions versus instances

NPC and monster banks contain reusable definitions.

Adding a definition to a game or scene creates a live instance with its own mutable state.

Changing one live instance must not unexpectedly modify the bank definition or other instances of that definition.

A recurring NPC may therefore have a reusable definition named "Walky the Wize" and a game-scoped instance whose current HP, status, and inventory evolve throughout the adventure.

## 8. NPC and Monster Banks

The DM should have convenient access to reusable NPC and monster banks during gameplay.

Example:

NPC BANK:
- Town Guard.
- Merchant.
- Innkeeper.
- Walky the Wize.
- Mysterious Wizard.

MONSTER BANK:
- Goblin.
- Orc.
- Skeleton.
- Rat.
- Dragon.

The banks should support selecting a definition and adding an instance to the active scene or game.

The DM should be able to choose the desired scope when adding an entity, or change it afterward.

When adding a new entity during gameplay:

- Scene-scoped entities belong to the active scene instance.
- Game-scoped entities belong to the game and appear in the active scene.

The bank is a source of reusable definitions, not a list of live entities.

## 9. Scenes, Maps, and Grid

### 9.1 Backgrounds

Scenes use static background images.

The grid must be configured independently of the background image. Do not bake the grid into the background.

The same background can be used with different grid configurations.

### 9.2 Grid configuration

The DM can configure the grid for each scene template, including its dimensions and alignment.

Token positions are represented using grid coordinates or an equivalent consistent coordinate system.

The client renders the grid over the background.

### 9.3 Spawn positions

The default player spawn is the bottom-left square of the grid.

A scene template can define a different player spawn square.

When a new player character enters an active scene, place them at the configured spawn.

Game-scoped entities also need a reasonable placement policy when transitioning to a new scene.

Multiple tokens can occupy the same square. Do not implement collision prevention.

### 9.4 Static resource organization

Use a static resources folder with application-relative URLs referenced by JSON definitions.

Suggested structure:

```text
static/
├── backgrounds/
│   ├── tavern.png
│   ├── dungeon.png
│   └── forest.png
├── tokens/
│   ├── goblin.png
│   ├── orc.png
│   ├── paladin.png
│   └── cleric.png
└── images/
    ├── dragon.png
    ├── large-monster.png
    ├── chest.png
    ├── barrel.png
    ├── rock.png
    └── obstacle.png
```

The exact file structure can be adjusted during implementation.

Use the appropriate visual representation for each entity. Large images must scale according to the configured grid footprint.

## 10. Token Rendering, Stacking, and Z-Order

Multiple tokens may occupy the same square.

When a token moves, it becomes the globally topmost token for rendering purposes.

The server should maintain a consistent global z-order, or an equivalent ordering mechanism, so all clients agree about the relative stacking of tokens.

There is one player-specific rendering exception:

**A player must always see their own token on top locally.**

This is a client-side rendering preference. It must not mutate the shared global z-order.

The DM sees the actual global stacking order.

The DM must be able to inspect stacked tokens, including tokens underneath the top token. Provide a hover or selection mechanism that exposes all tokens in the stack and allows the DM to select a particular one.

## 11. Token Donut UI

Each character token has a circular action interface surrounding it.

The character token or image occupies the center.

Four quarter-segment buttons surround it:

- **North: Attack**
- **East: Move**
- **South: Inventory**
- **West: Act**

A health bar is positioned above the donut. The health bar is not part of the donut.

Conceptually:

```text
             HEALTH BAR
             ███████░░░
                24/30

                 ATTACK
                   ▲

             ACT  [TOKEN] MOVE

                   ▼
               INVENTORY
```

The donut should be the primary way players interact with their characters.

The buttons remain visible around the token.

Outside combat, Attack remains visible and can open the attack interface, but attack choices are disabled until combat begins.

When a character is downed or dead, the donut changes to reflect the character's state, as described in the HP section.

The UI should remain usable on a typical desktop browser without requiring players to navigate traditional character sheets.

## 12. Movement

Players can move their tokens around the grid.

Movement is separate from the normal action economy.

In combat, a player may move and then attack, or attack and then move, subject to movement limits and action availability.

The server validates movement and updates shared state.

The DM can move any token.

Multiple tokens may occupy the same square, and moving into an occupied square is allowed.

Movement should update all connected clients in real time.

## 13. Non-Combat Gameplay

Outside combat:

- Players can move freely.
- Players can use Act.
- Players can use Inventory.
- Players can interact with the scene through the available UI.
- There is no initiative system.
- There are no player turns.
- Attacks are disabled.

The DM decides narrative outcomes.

Do not introduce a turn system outside combat.

## 14. Combat and Action Economy

Combat uses two global phases:

1. **PLAYER PHASE**
2. **DM PHASE**

The phases repeat until the DM ends combat.

There is no individual initiative order.

### 14.1 Player phase

During PLAYER PHASE, all players may act independently without waiting for a specific player to finish.

Each player normally has one action per player phase.

Movement is separate from that action.

A player can move and attack in either order, provided the movement and attack are otherwise valid.

Abilities may explicitly grant additional actions if their definitions support that behavior.

The server enforces phase and action availability.

### 14.2 DM phase

During DM PHASE, the DM controls monsters and NPCs as appropriate.

The DM can move entities, make attacks, apply damage, heal, and otherwise manage the encounter.

The DM manually advances the phase when ready, unless the optional timer expires.

### 14.3 Starting and ending combat

When the DM starts combat:

- Combat becomes active.
- Attacks become available.
- The phase becomes PLAYER PHASE.
- The optional combat timer begins if configured.

When the DM ends combat:

- Combat becomes inactive.
- Attacks become unavailable.
- The timer stops and disappears.
- Normal free-form non-combat behavior resumes.

The server is authoritative for phase state.

## 15. Optional Combat Timer

The DM can configure an optional timer for each combat phase.

Support an off setting and convenient presets such as 30, 60, 90, and 120 seconds, with a custom value if practical.

The timer applies to both PLAYER PHASE and DM PHASE.

All clients see the remaining time.

The server must be authoritative. Track the phase start and end times or use an equivalent mechanism. Do not rely on individual browser countdowns to determine phase transitions.

When the timer expires, the server automatically transitions between PLAYER PHASE and DM PHASE.

The DM can manually advance the phase before expiry.

Ending combat stops the timer.

Persist enough timer state to handle reconnects and server restarts without trusting stale client timers.

## 16. Dice and Attack Resolution

Support standard dice notation:

- `d4`
- `d6`
- `d8`
- `d10`
- `d12`
- `d20`

Support expressions such as:

- `1d20`
- `2d6`
- `3d6+2`
- `1d8+4`
- `1d20+5`

The server performs all authoritative dice rolls.

A standard attack proceeds as follows:

1. The player selects an attack.
2. The player selects a target.
3. The server validates ownership, phase, action availability, target validity, range, and other applicable restrictions.
4. The server rolls the attack expression.
5. The result is compared against the target's defense.
6. On a hit, the server rolls damage and applies it.
7. The server broadcasts the result and updates the shared state.

Do not implement the complete D&D 5e ruleset.

Keep attack resolution simple and configurable.

An attack must have a valid target. Players should be able to select targets directly on the VTT.

The server must reject invalid or unauthorized attacks.

## 17. HP, Downed State, and Death

All characters and monsters with HP display a health bar above their token's donut.

### 17.1 Health visibility

Player view:
- Friendly character HP is visible.
- Enemy HP is hidden.

DM view:
- All HP is visible.

Do not leak exact enemy HP in shared activity messages, chat, or client payloads intended for players. Where practical, filter hidden information on the server rather than relying solely on client-side hiding.

### 17.2 Downed state

When a character reaches 0 HP, they become DOWN.

A downed character cannot:

- Move.
- Attack.
- Act normally.
- Use inventory.
- Use normal abilities.

Their only available action is a D20 roll from their token.

The UI must clearly communicate the downed state and disable normal actions.

If the character is healed above 0 HP, they return to the active state.

### 17.3 Death

While down, if a character takes damage equal to their full maximum HP, they die.

For example, a character with 30 maximum HP who is downed and then takes 30 or more damage dies.

Death is permanent unless the DM explicitly revives or overrides it.

Dead characters display a clear DEAD state and cannot perform normal actions.

The DM must have tools to revive, kill, or override character state.

Apply appropriate death behavior to monsters as well, while leaving the DM in control.

## 18. Damage Feedback

When an attack damages a target, display a temporary damage indicator near the target.

Use the attacking player's assigned color.

Examples:

- `-8`
- `+5`
- `MISS`
- `CRIT`

Implement basic damage indicators first; the additional indicator types can be added where supported by attack resolution.

Shared activity events should record attacks, hits, misses, and damage without leaking hidden enemy HP.

## 19. Player Colors

Provide a bank of exactly 10 distinct player colors.

Each active player slot has a unique color.

Players can choose or change their color at any time from the available bank, subject to uniqueness among active players.

Color belongs to the player's identity within the game, not to their character.

If a player changes characters, their color remains the same.

Use the color consistently for:

- Player names in chat.
- Activity entries.
- Damage indicators.
- Token identity or related UI accents where appropriate.

Choose an accessible, visually distinct palette.

## 20. Inventory

Inventory is intentionally simple and DM-managed.

Characters have predefined starting inventory items.

The DM can add items to a character's inventory.

Players can view their inventory through the south segment of the token donut.

Using an item removes it from the inventory.

In combat, using an item consumes the player's action.

Inventory items do not automatically execute game mechanics.

For example, a player might use a rope to tie up a goblin. One & Done records the action, and the DM decides whether the goblin is restrained, escapes, or something else happens.

Do not build an inventory effects engine, equipment system, or elaborate item database.

The inventory is a lightweight narrative tool.

## 21. Act

Act is the interface for character actions and interactions outside the normal attack flow.

Examples:

- Open Chest.
- Pull Lever.
- Investigate Door.
- Intimidate Goblin.

Acts can be defined for characters or made available through the game as appropriate.

The DM decides outcomes.

An Act may optionally specify a dice roll. If present, the server rolls the dice and publishes the result in chat/activity.

An Act without a roll simply records the action.

During combat, normal action-economy rules apply unless an ability explicitly grants an exception.

Do not build an automatic narrative resolution engine.

## 22. Chat and Activity Log

Provide a right-side panel containing two distinct areas:

1. Player chat.
2. Game/activity log.

### 22.1 Player chat

Chat messages contain:

- Player display name.
- Player color.
- Message.
- Optional timestamp.

Chat is independent of Discord. No Discord integration is required.

### 22.2 Activity log

The activity log contains server-generated game events, such as:

- Player joins.
- Character selected.
- Movement.
- Ability used.
- Attack attempted.
- Damage or healing.
- Item used.
- Act used.
- Dice rolled.
- Combat started or ended.
- Phase changed.
- Entity spawned, killed, or revived.
- Scene changed.

Represent chat messages and game events as separate internal types.

The server should generate authoritative activity events.

Do not expose hidden information, including exact enemy HP, to players through the activity log.

## 23. DM Controls and Overrides

The DM has ultimate authority over gameplay.

Provide tools to:

- Move any token.
- Add or remove live entities.
- Change entity scope.
- Damage, heal, or set HP.
- Kill or revive entities.
- Override gameplay state when necessary.
- Start or end combat.
- Advance phases.
- Configure the combat timer.
- Select the active scene.
- Add or remove scenes from a game.
- Reset a player's character assignment.
- Manage player colors where necessary.
- Manage player spawn behavior.
- Inspect stacked tokens.

The DM should be able to resolve unusual situations without fighting the rules engine.

Consider a simple **Undo Last Action** feature for accidental movement, damage, or target selection.

This is not intended to be a full time machine. Implement undo for a limited, well-defined set of actions if practical.

## 24. Persistence and Reconnection

Use SQLite for durable game state.

The application must preserve:

- Game definitions and metadata.
- Scene templates.
- Scene instances.
- Scene-scoped entity state.
- Game-scoped entity state.
- Player identities and character assignments.
- Player colors.
- Character HP and other mutable state.
- Combat phase and timer state.
- Chat and activity history.
- Other necessary state to resume a game.

Scene templates and live scene instances must remain separate.

A game must remain available even when no DM is connected.

Players should be able to join or reconnect independently.

A browser refresh must not create duplicate player identities or duplicate characters.

A server restart must not lose the running game's state.

The server should restore persisted state on startup and broadcast the current authoritative state to newly connected clients.

Use appropriate database transactions or equivalent safeguards for critical state changes.

## 25. Suggested Project Structure

The exact structure is up to the implementer. Keep the code modular without overengineering.

Suggested starting point:

```text
one-and-done/
├── package.json
├── README.md
├── server/
│   ├── server.js
│   ├── websocket.js
│   ├── game/
│   ├── combat/
│   ├── dice/
│   ├── sessions/
│   ├── scenes/
│   └── persistence/
├── client/
│   ├── index.html
│   ├── css/
│   ├── js/
│   └── assets/
├── data/
│   ├── characters/
│   ├── monsters/
│   └── npcs/
├── static/
│   ├── backgrounds/
│   ├── tokens/
│   └── images/
└── data/
    └── one-and-done.sqlite
```

Avoid duplicating source-of-truth state between the client and server.

## 26. Security and Validation

This is a private gaming application, but the server must still validate actions.

- Players can only perform actions allowed for their assigned character.
- Players cannot modify another player's character.
- Players cannot set their own HP or override server state.
- Players cannot perform attacks outside combat.
- Players cannot attack invalid or out-of-range targets.
- The server enforces action economy and phase restrictions.
- Players cannot grant themselves DM privileges.
- Player game links must not grant DM access.
- Client-supplied player IDs must be validated against the game's stored identity and assignment state.
- A player reset must invalidate the previous assignment so the old browser cannot silently reclaim the character.

The player ID in `localStorage` is a continuity mechanism, not a security boundary.

Use a separate DM authentication mechanism and protect DM-only operations.

## 27. Explicitly Out of Scope

Do not implement the following unless specifically requested later:

### Communication
- Voice chat.
- Video chat.
- Music or audio streaming.
- Discord integration.

### Character systems
- D&D Beyond integration.
- Traditional character-sheet import/export.
- Traditional D&D character sheets.
- Leveling or XP.
- Persistent character progression.
- Weapon swapping or equipment progression.
- Spell-slot management.

### Rules complexity
- Full D&D 5e rules.
- Individual initiative ordering.
- Exhaustive condition engine.
- Automatic inventory effects.
- Automatic narrative resolution.
- Virtual dice physics.

### VTT complexity
- Fog of war.
- Dynamic lighting.
- Advanced line of sight.
- Full map editor in Game mode.
- Campaign management.
- Public matchmaking.
- Player accounts or OAuth.
- Complex physics or collision prevention.

Keep One & Done focused on its purpose: running a one-shot with a human DM.

## 28. Recommended MVP Implementation Order

Implement incrementally, keeping the application usable at each stage.

1. Create the Node.js/npm application and basic HTTP server.
2. Build the initial frontend and DM/player navigation.
3. Implement DM authentication.
4. Implement game creation, deletion, and joining.
5. Add WebSockets and real-time state synchronization.
6. Implement player names and persistent browser identity.
7. Implement role selection and character roster.
8. Implement character locking, reconnection, and player reset.
9. Implement the 10-color bank.
10. Implement scene templates and the Scenes section.
11. Implement scene instances and the Games section.
12. Implement backgrounds, grid rendering, and player spawning.
13. Implement token rendering, movement, stacking, and z-order.
14. Implement NPC/monster definitions and banks.
15. Implement scene-scoped and game-scoped entity instances.
16. Implement entity scope changes and cross-scene persistence.
17. Implement the token donut UI and health bars.
18. Implement Move, Act, and Inventory.
19. Implement dice parsing and server-side rolls.
20. Implement attacks, targets, range, defense, and damage.
21. Implement combat phases and optional timers.
22. Implement downed, death, and revival logic.
23. Implement chat and activity events.
24. Implement DM gameplay controls and overrides.
25. Implement supported undo functionality.
26. Add persistence and reconnect/server-restart recovery.
27. Test multiplayer behavior with several simultaneous clients.
28. Deploy through Caddy at `oneshot.elliscode.com`.

Prioritize the smallest complete playable loop before polishing secondary UI details.

## 29. Definition of Done

The MVP is complete when all of the following are possible.

### Hosting and game management
- The application runs on the Mac Mini at `oneshot.elliscode.com`.
- The DM can log in and see Scenes and Games.
- The DM can create and delete games.
- Players can join a game without the DM being present.
- Games persist across browser refreshes and server restarts.

### Player flow
- Players can enter a name or accept their remembered name.
- Players can choose a role and character.
- Character selection locks to their identity within the game.
- Reconnecting players recover their character.
- The DM can release/reset a player's character.
- Players retain their color when changing characters.
- Players see a waiting message until a scene becomes active.

### Scenes and entities
- The DM can create and edit reusable scene templates.
- The DM can add scene instances to games.
- The DM can select an active scene.
- Live instance changes do not mutate the source template.
- NPC and monster banks can spawn live instances.
- The DM can change entity scope between scene and game.
- Game-scoped entities follow the adventure and retain state.
- Scene-scoped entities remain with their scene instance and retain state.
- Players and game-scoped entities appear in newly active scenes.
- The DM can move between scenes without losing state.

### Gameplay
- Players can move tokens.
- Multiple tokens can occupy one square.
- Recent movement updates global z-order.
- Players always see their own token on top locally.
- The DM can inspect and select stacked tokens.
- The donut provides Attack, Move, Act, and Inventory.
- Attack is disabled outside combat.
- Act and Inventory work without requiring automatic narrative effects.
- Combat starts in PLAYER PHASE.
- Players act independently during PLAYER PHASE.
- The DM controls entities during DM PHASE.
- The optional timer works for both phases.
- Dice rolls and attacks are server-authoritative.
- HP, damage feedback, downed state, death, and revival work.
- Friendly HP is visible to players, while enemy HP remains hidden.
- Chat and activity update for connected clients.

### DM authority and durability
- The DM can move, spawn, remove, damage, heal, kill, and revive entities.
- The DM can override gameplay state.
- The DM can switch scenes.
- The DM can reset player character assignments.
- The game remains usable after disconnects and reconnects.
- Scene-scoped and game-scoped entity state survives server restarts.
- Undo works for the actions explicitly supported by the implementation.

The final acceptance test should be running an actual one-shot with multiple players, switching scenes, spawning NPCs and monsters, running combat, and resuming the game after a browser refresh or server restart.

## 30. Final Product Principles

Keep these principles in mind throughout implementation:

1. **Scenes are reusable templates; games are actual adventures; scene instances are live copies.**
2. **Game-scoped entities follow the adventure; scene-scoped entities remain with their scene instance.**
3. **The DM controls the world and can override the rules.**
4. **The server is authoritative for shared state and game mechanics.**
5. **Players should be able to join, select a hero, and start playing with minimal friction.**
6. **One & Done is not a complete D&D rules engine or a general-purpose VTT.**
7. **Prefer simple, reliable behavior over extensive configurability.**
8. **Do not let editing reusable templates unexpectedly mutate live game instances.**
9. **Do not let reconnects or name changes accidentally create duplicate players or release characters.**
10. **Build the smallest complete playable experience first, then refine it.**

### Ideal player flow

```text
Open game link
    ↓
Enter/confirm name
    ↓
Choose role
    ↓
Choose hero
    ↓
Wait for active scene if necessary
    ↓
Enter the game
    ↓
Select token and perform actions
```

### Ideal DM flow

```text
Open One & Done
    ↓
Choose Scenes or Games
    ↓
Build reusable scene templates
    ↓
Create/open a game
    ↓
Add scene instances
    ↓
Set active scene
    ↓
Spawn/manage NPCs and monsters
    ↓
Run encounter
    ↓
Switch scenes while preserving relevant state
    ↓
Override anything necessary
```

**Implementation request:** Review the full specification, propose a practical implementation plan, and then build the application incrementally. Make reasonable technical decisions without asking for approval for every implementation detail. Keep the architecture simple, test critical state transitions, and document how to run and deploy the finished application on the Mac Mini.