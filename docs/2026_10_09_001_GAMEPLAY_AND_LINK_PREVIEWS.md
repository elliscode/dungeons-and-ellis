# One & Done — Gameplay and Link Preview Improvements

Implement the following three changes in the existing application. Preserve the current architecture, UI, deployment, and existing functionality. Do not rebuild the application or introduce unnecessary dependencies.

## 1. Enforce Enemy Action Limits

Enemies must have a limited number of actions during each DM phase.

- Default each monster to one action per DM phase.
- Allow character/monster definitions to specify a different action allowance where needed.
- Movement remains separate from the action allowance.
- An enemy may move and attack in the same phase.
- Additional attacks consume additional actions.
- Reset action availability when a new DM phase begins.
- Enforce all action limits on the server.
- Apply this to monsters and hostile NPCs where appropriate.
- Preserve DM override capabilities.
- Ensure the UI accurately reflects action availability.

Inspect the existing combat implementation before making changes. Avoid introducing duplicate or conflicting action counters.

## 2. Apply Tank Damage Reduction

Tank-role player characters take 25% of incoming damage, in addition to their existing defense statistic.

- Apply a 75% damage reduction to incoming damage.
- Round the resulting damage down to an integer.
- Apply a minimum of 1 damage for any positive incoming damage.
- Apply the modifier exactly once in the authoritative server-side damage-resolution path.
- Apply it consistently to relevant incoming damage sources.
- Do not apply it to healing, direct HP-setting operations, or DM overrides.
- Ensure the damage reported in activity events and floating damage indicators reflects the actual damage taken.
- Add tests for rounding, minimum damage, and multiple damage sources.

If the existing model distinguishes role from character class, use the established role definition rather than introducing a competing role system.

## 3. Add Per-Game Open Graph Metadata

When a player shares a game URL, the resulting link preview must describe that particular game.

For a game titled "SpEllis", the preview should have:

- Title: `SpEllis`
- Description: `Join my game on One & Done!`
- Image: the currently active scene's background/map image.
- Type: `website`
- URL: the canonical game URL.
- Twitter/X card: `summary_large_image`, with corresponding title, description, and image metadata.

Requirements:

1. Read the game title from the existing game data.
2. Resolve the active scene and its background image.
3. Generate per-game metadata at the server or through another approach compatible with social-preview crawlers.
4. Ensure crawlers can read the metadata from the initial HTML response without executing client-side JavaScript.
5. Update the metadata when the active scene changes.
6. Use a fallback image if no scene is active.
7. Use absolute HTTPS URLs for metadata images.
8. Do not expose private state, player identities, or DM-only information.
9. Preserve existing player authentication and game routing.
10. Document how to test previews and account for third-party preview caching.

Before implementation, inspect the current routing, game model, scene model, and static asset handling. Prefer the smallest reliable change.

## Acceptance Criteria

- An enemy cannot exceed its action allowance during a DM phase unless the DM explicitly overrides it.
- Enemy action availability resets correctly between DM phases.
- Tanks take 25% of incoming damage using the agreed rounding rule.
- Existing defense, HP, death, downed, healing, and DM override behavior continues working.
- Sharing a game URL produces a preview with that game's title, the correct description, and the active scene's map image.
- Changing the active scene changes the image used for newly fetched previews.
- Preview metadata works without client-side JavaScript execution.
- Existing game functionality and deployment remain operational.