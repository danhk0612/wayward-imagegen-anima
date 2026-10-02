# Anima setup

This fork keeps Wayward's existing image-generation API and routes the game's
still-image requests to a local Anima renderer.

## What it does

The image backend is primarily for **real-time regeneration of images for
characters that already exist in Wayward**. It does not add dialogue, events or
a new playable character to the game by itself.

For each request:

1. Wayward sends a `talentName`, scene prompt and image type.
2. The server extracts the character name from `talentName`.
3. The matching `characterProfiles.<name>` entry is selected.
4. The Anima model is loaded with that character's LoRA(s).
5. The LoRA trigger and stable character description are inserted automatically.
6. Wayward's changing scene/action/outfit prompt is appended.
7. The image is rendered, cached and returned to Wayward.

A completely new playable Wayward character therefore has two independent
parts: game-side character/content work, and image-side LoRA/profile work. This
repository handles the image-side part.

## Native Anima model layout

Anima Base v1 is not an SDXL all-in-one checkpoint. In ComfyUI it is loaded as
three components:

- diffusion model: `anima-base-v1.0.safetensors`
- text encoder: `qwen_3_06b_base.safetensors`
- VAE: `qwen_image_vae.safetensors`

The native graph is:

```text
UNETLoader
  -> optional Turbo/speed LoRA (model-only)
  -> global Anima LoRA(s) (model-only)
  -> selected character LoRA(s) (model-only)
  -> KSampler
  -> VAE Decode
  -> Save Image

CLIPLoader (Qwen 0.6B)
  -> positive/negative CLIPTextEncode

VAELoader (Qwen Image VAE)
  -> VAE Decode
```

The defaults are 30 steps, CFG 4, `er_sde`, `simple`, matching the current
ComfyUI Anima template starting point. They remain configurable.

## Character profiles

Run **one server for all characters**. You do not switch configuration manually
when Elena changes to Mara. The server selects the profile from Wayward's
`talentName` automatically.

Example:

```json
{
  "imagePreset": "anima",
  "animaModel": "anima-base-v1.0.safetensors",
  "animaTextEncoder": "qwen_3_06b_base.safetensors",
  "animaVae": "qwen_image_vae.safetensors",
  "characterProfiles": {
    "elena": {
      "loras": [
        {
          "name": "elena_anima_character.safetensors",
          "strengthModel": 0.9
        }
      ],
      "triggerPrompt": "elena_trigger",
      "basePrompt": "1girl, blue eyes, long brown hair",
      "positivePromptPrefix": "",
      "positivePromptSuffix": "",
      "negativePromptPrefix": "",
      "negativePromptSuffix": ""
    }
  }
}
```

For native Anima the character LoRA is applied to the diffusion model with
`LoraLoaderModelOnly`; `strengthClip` is ignored by the Anima path.

## Where the LoRA prompt goes

A character LoRA commonly needs more than the `.safetensors` file. Keep the two
roles separate:

- `triggerPrompt`: the exact activation token/tag expected by the LoRA.
- `basePrompt`: stable identity traits that should accompany the character in
  every image, such as hair/eye/body/recognition tags used during training.

Wayward remains responsible for changing scene information such as pose,
clothing, room, action and situation.

Final positive prompt order:

```text
[global positive prefix]
+ [character triggerPrompt]
+ [character basePrompt]
+ [character positivePromptPrefix]
+ [Wayward dynamic scene prompt]
+ [character positivePromptSuffix]
+ [global positive suffix]
```

The negative prompt uses the character/global negative prefix/suffix around
Wayward's negative prompt.

## Setup

1. Confirm the exact Anima model + character LoRA works by itself in your image
   UI first.
2. Put the Anima model, Qwen text encoder, VAE and character LoRAs where ComfyUI
   can see them.
3. Copy `wayward-imagegen.config.anima.example.json` to
   `wayward-imagegen.config.json`.
4. Fill in the exact LoRA filenames, strengths, triggers and base prompts.
5. Run:

   ```bash
   bun src/cli.ts doctor
   ```

6. Start:

   ```bash
   bun src/cli.ts
   ```

7. Point Wayward image generation at `http://127.0.0.1:8189` (or use its
   automatic local detection if available).

## Cache identity

The cache signature includes the Anima model/text encoder/VAE, sampling
parameters, LoRA names/strengths, selected character and all character prompt
fragments. Changing a LoRA, trigger or fixed character prompt therefore
creates a new render identity instead of silently reusing an old image.

## Forge Neo

Forge Neo can also run Anima, but this repository's current renderer speaks the
ComfyUI API. Forge Neo is therefore a separate backend, not something that can
be substituted by changing `COMFYUI_URL` alone.
