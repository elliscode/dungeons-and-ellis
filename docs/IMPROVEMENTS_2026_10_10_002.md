# One & Done — Role Multipliers + Game Feed Scrolling

Implement these as incremental changes to the existing application. Inspect the current code and reuse the existing role-selection UI, shared damage/healing pipeline, and unified Game Feed. Do not rebuild or refactor unrelated functionality.

## Part 1: Role-Based Combat Multipliers

### 1. Role bonuses

Apply these server-authoritative role bonuses:

| Role | Bonus | Intended behavior |
|---|---|---|
| Tank | Takes ¼ damage | Existing behavior: reduce incoming damage by 75%, rounding down with a minimum of 1 damage for positive incoming damage. |
| DPS | Deals 4× damage | Multiply damage dealt by DPS player characters by 4. |
| Heal | Restores 4× healing | Multiply healing restored by Heal player characters by 4. |

These bonuses should apply automatically based on the character's assigned role. Do not require players to activate a special ability to receive their role bonus.

### 2. Damage multiplier implementation

- Apply the DPS multiplier in the shared server-side damage-resolution pipeline, so it works consistently across normal attacks and damage-dealing abilities.
- Include damage from multi-attacks, area attacks, and chain attacks when the damage is dealt by a DPS player character.
- Apply the multiplier to each individual damage instance before applying the target's defensive mitigation.
- Preserve attack-roll results, hit/miss logic, critical-hit handling, defense checks, range checks, and action costs.
- Apply the multiplier exactly once per damage instance. Do not multiply damage in both the ability handler and the shared damage pipeline.
- Do not accidentally apply the player DPS bonus to monsters or NPCs controlled by the DM.
- Preserve the existing Tank mitigation, protection effects, damage absorption, redirection, and DM override behavior.

### 3. Healing multiplier implementation

- Apply the 4× healing multiplier in the shared server-side healing pipeline for healing performed by player characters with the Heal role.
- Include healing spells and abilities that restore HP, including chain healing and area healing when supported by the existing effect engine.
- Apply the multiplier to the actual healing amount before enforcing the target's maximum HP.
- Never allow healing to exceed the target's maximum HP.
- Apply the bonus exactly once, regardless of which ability handler initiated the healing.
- Do not multiply healing performed by non-Heal player characters or DM-controlled entities unless an existing explicit effect independently modifies that healing.
- Preserve existing downed/dead recovery rules and any healing modifiers from abilities or active effects. Define the order of applicable modifiers centrally to prevent accidental double multiplication.

### 4. Role selection tiles

When a player first joins a game and chooses a role, make each role's benefit immediately visible on the role-selection tile.

Use clear, concise copy:

- **Tank** — `Takes ¼ damage`
- **DPS** — `Deals 4× damage`
- **Heal** — `Heals for 4×`

Display the bonus prominently enough that players understand the gameplay difference before selecting a role. Keep the existing visual design and character-selection flow; this is a small UI enhancement, not a redesign.

The bonus descriptions should be driven by the actual role rules where practical, so the UI does not become inconsistent with the server implementation.

Do not confuse role selection with character selection. Preserve existing roster, player identity, character-locking, reconnection, and player-color behavior.

### 5. Game Feed and damage feedback

- Continue logging attacks, damage, and healing through the existing unified Game Feed.
- Display the final damage or healing amount actually applied after multipliers, mitigation, protection, and HP caps.
- Preserve the existing player-color damage indicators.
- Do not expose enemy HP or other information that players are not permitted to see.

## Part 2: Game Feed Scroll-to-Bottom Behavior

### 1. Add a "Scroll to bottom" button

Add a button labeled **Scroll to bottom** to the unified Game Feed/chat panel.

- Show the button when the player is viewing older messages rather than the bottom of the feed.
- Clicking the button immediately scrolls the feed to the newest message at the bottom.
- After scrolling to the bottom, hide the button until the player moves away from the bottom again.
- Keep the button visually unobtrusive and consistent with the existing interface.
- Ensure the button works on both desktop and mobile layouts.

### 2. Automatically scroll on every new chat message

Change the existing Game Feed behavior so that **every newly received chat message automatically scrolls the feed to the bottom**, even if the player had manually scrolled up to read older messages.

- Apply this behavior to incoming chat messages from other players and the DM.
- Apply it to newly appended Game Feed entries if chat and system events share the same feed.
- Ensure the scroll happens after the new entry has been rendered.
- Avoid duplicate entries or unnecessary scroll loops when the feed updates.
- After automatic scrolling reaches the bottom, hide the "Scroll to bottom" button.
- Keep the chat input accessible at the bottom of the panel.

This explicitly replaces the previous behavior that only auto-scrolled when the player was already at the bottom.

### 3. Implementation details

- Reuse the existing Game Feed component and its current message rendering and real-time update mechanism.
- Track whether the feed is currently at the bottom to control button visibility.
- Use the existing framework's appropriate post-render mechanism to scroll after new entries are inserted.
- Avoid introducing a new chat system, polling mechanism, or additional backend service.
- Do not break message history, timestamps, message ordering, chat input, `/roll` handling, DM/private messages, or server-side filtering of hidden information.

## Part 3: Tests and Acceptance Criteria

### Role bonuses

- Tank damage reduction continues working as before.
- DPS normal attacks deal 4× the calculated damage.
- DPS damage-dealing abilities deal 4× damage, including supported multi-target attacks.
- Heal abilities restore 4× the calculated healing amount, subject to the target's maximum HP.
- A Heal character's healing can recover a downed character when existing recovery rules permit it.
- Other roles do not receive the wrong multiplier.
- DM-controlled entities do not accidentally receive player-role multipliers.
- Multipliers are applied exactly once and interact correctly with critical hits, buffs, debuffs, mitigation, protection, and DM overrides.
- The role-selection tiles display the correct benefits.

### Game Feed

- The button appears when the player scrolls away from the bottom.
- Clicking it scrolls to the latest entry and hides the button.
- A new message automatically scrolls the feed to the bottom, even if the player was reading older messages.
- The button reappears if the player subsequently scrolls up.
- Multiple rapid incoming messages do not cause duplicate entries, rendering problems, or scroll loops.
- The behavior works after reconnecting and receiving new messages.
- Existing Game Feed privacy and hidden-HP protections remain intact.

## Implementation Approach

1. Inspect the existing role model, shared damage/healing pipeline, role-selection tiles, and Game Feed component.
2. Implement the role multipliers centrally on the server.
3. Add the role-benefit descriptions to the selection tiles.
4. Implement the Game Feed button and revised auto-scroll behavior.
5. Add or update tests for the scenarios above.
6. Summarize the files changed, implementation decisions, tests run, and any limitations.

Keep the changes narrowly scoped. Preserve existing gameplay rules except for the explicitly requested role bonuses and Game Feed scrolling behavior.