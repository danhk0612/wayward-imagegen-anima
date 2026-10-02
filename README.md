# wayward-imagegen-anima

An Anima-focused adaptation of Wayward's local `wayward-imagegen` backend.

## Purpose

This project keeps Wayward's existing image-generation API while changing the
local ComfyUI rendering path so it can use:

- an **Anima checkpoint**,
- **per-character Anima LoRAs**,
- per-character LoRA trigger/base prompts,
- global prompt defaults,
- Wayward's own dynamic scene/action/outfit prompt.

It is designed first for **real-time regeneration of images for Wayward's
existing characters**. It does not, by itself, add a new playable character to
the game's story/state/event system.

See [ANIMA_SETUP.md](./ANIMA_SETUP.md) for the Anima-specific configuration and
behaviour.

## Character selection model

Run one backend for the whole game. When Wayward requests an image, the request
contains a character-derived `talentName`. The backend resolves that name to a
character profile such as `elena`, `mara` or `pippa`, then automatically applies
that profile's LoRA and trigger/base prompt.

Example:

```text
Wayward requests: Elena + tavern scene
       ↓
character profile: elena
       ↓
Anima checkpoint
+ Elena LoRA
+ Elena trigger/base prompt
+ Wayward dynamic scene prompt
       ↓
ComfyUI render
       ↓
cache + return image to Wayward
```

## Prompt composition

The final positive prompt is:

```text
[global positive prefix]
+ [character profile positive prefix / LoRA trigger / fixed appearance]
+ [Wayward scene prompt]
+ [character profile positive suffix]
+ [global positive suffix]
```

The negative prompt follows the same pattern.

This means the LoRA's required trigger token and stable identity traits belong in
`characterProfiles.<character>.positivePromptPrefix`, while pose, clothing,
location and action can stay dynamic from Wayward.

## Quick start

Requirements:

- Bun
- ComfyUI
- an Anima checkpoint that already works in your ComfyUI environment
- one or more Anima character LoRAs
- the custom node packs required by the graph (checked by `doctor`)

Copy:

```text
wayward-imagegen.config.anima.example.json
```

to:

```text
wayward-imagegen.config.json
```

Then replace the placeholder checkpoint, LoRA filenames and trigger prompts with
values from your own ComfyUI setup.

Validate:

```bash
bun src/cli.ts doctor
```

Run:

```bash
bun src/cli.ts
```

Then use Wayward's **Settings -> Image generation -> Automatic**, or point it to
`http://127.0.0.1:8189`.

## New playable characters

This backend can render a new character *after the game knows that character and
starts requesting images for it*. A brand-new playable character therefore has
two separate layers:

1. **Game-side work** — character definition, state, dialogue/events and image
   request keys.
2. **Image backend work** — add the character folder/profile, LoRA and trigger
   prompt here.

Only layer 2 is covered by this repository.

## Upstream behaviour retained

The backend still acts as a small local HTTP server between Wayward and ComfyUI,
keeps a local image cache, supports ahead-of-time generation/review, and serves
locally generated images back to the game.
