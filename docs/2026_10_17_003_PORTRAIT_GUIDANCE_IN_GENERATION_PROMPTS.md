# One & Done — Portrait Guidance in Generation Prompts

This is a documentation-only change to the LLM generation guides for heroes and NPCs. It doesn't touch code, schemas or data.

## Background

Hero and NPC portraits are generated separately in ChatGPT and become the definition's token art. The definition itself (name, abilities, DM note) is then written by an LLM using the prompts in `docs/CHARACTER_GENERATION.md` and `docs/NPC_GENERATION.md`.

Before this change, those prompts took only a token path. The LLM never saw the portrait, so nothing kept a definition consistent with its art. An LLM shown a portrait could also change how the character looks to fit the role it was given, or let appearance decide personality, morality or which side the character is on.

The goal is to keep the variety and individuality of the generated art intact when portraits are turned into playable characters and NPCs.

## Part 1: The prompt

### 1. Where the rules go

The rules go **inside the prompt's text block**, after the existing token rule, as a "Portrait (when one is attached)" list. The LLM only sees what's pasted, so guidance elsewhere in the doc never reaches it.

A new input line, `Portrait: <attach the token image, or leave blank>`, sits under `Token:`. Step 1 of each workflow now says to attach the portrait, and that it comes from ChatGPT. That background stays out of the prompt, since the model doesn't need it.

### 2. The rules

The same five rules go in both prompts:

| Rule | Wording, in short |
|---|---|
| Source of truth | The portrait decides how the character looks. Keep descriptions consistent with what's visible: skin tone, facial features, hair, apparent age, build, clothing and distinguishing marks. |
| No homogenizing | Don't change, soften or homogenize the depicted appearance to fit the requested role, name or theme. |
| Appearance isn't character | Appearance never decides personality, morality, intelligence or competence. Those come from the request. |
| Don't invent | Only state what the portrait shows. If it doesn't establish ethnicity, gender identity or pronouns, leave them unstated, and use the name rather than gendered pronouns unless the request gives some. |
| Nonhuman features | Keep visible species or creature features rather than reading every portrait as human. |

Pronoun handling is the concrete rule "use the name, not gendered pronouns", because that's easier for a model to follow than "don't invent certainty".

### 3. Where each schema puts it

The two schemas give appearance different homes, so the first rule is worded per guide:

- **Heroes** (`character.schema.json`) have no `description` field. The portrait shapes the `name`, the theme and the ability `description` flavor text.
- **NPCs** (`npc.schema.json`) have a `description`, a DM note of at most 300 characters that is mainly for personality and secrets. The prompt asks for a short appearance note only.
- **NPC hostility:** the NPC prompt adds trustworthiness and "whether the NPC is hostile" to the list of things appearance never decides, since `hostile: true` is the NPC's side.

## Part 2: Spreading portraits across the cast

The guidance also asks that portraits be used across the whole cast, rather than particular appearances going mostly to background characters or antagonists. One LLM call writes one character, so it can't follow this rule. It's a note for the person running the workflow instead:

- `CHARACTER_GENERATION.md` gets a "Portraits across the roster" section.
- `NPC_GENERATION.md` gets a "Portraits across the bank" section.

Both go after the workflow and link to each other.

## Part 3: Out of scope

- **Monsters:** `docs/MONSTER_GENERATION.md` is unchanged. If it's ever added, the nonhuman-features rule is the one that matters most there.
- **Schemas:** no new field for appearance, and `npm run build:schemas` isn't needed.
- **Existing data:** current heroes and NPCs aren't revisited.

## Acceptance Criteria

- Both prompts contain the Portrait list and the `Portrait:` input line.
- Both workflows' step 1 mentions attaching the portrait.
- Both docs have the cast-spreading section, and the two sections link to each other.
- Manual check: generate one hero and one NPC with a portrait attached. Check that the name and flavor text fit the image, that no unshown details (ethnicity, pronouns) are stated, and that the output still passes `npm run validate:characters` and `npm run validate:npcs`.

## Core/shell impact
- Core: none.
- Shell: none. Docs only (`docs/CHARACTER_GENERATION.md`, `docs/NPC_GENERATION.md`).
- Contract change: no.
