# Anima-focused setup

This fork keeps Wayward's existing image-generation API but changes the local
ComfyUI rendering layer so it can be configured around an **Anima checkpoint**
and **per-character Anima LoRAs**.

## What this does — and does not do

This backend does **not** add a new playable character to Wayward by itself.
Wayward already decides which character and scene need an image; this server
receives that request and generates/replaces the missing image locally.

So the main use case is:

1. Wayward requests an Elena/Mara/Pippa/etc. scene image.
2. `wayward-imagegen` detects the character from `talentName`.
3. The matching character profile is selected automatically.
4. That profile's Anima LoRA and trigger/base prompt are applied.
5. Wayward's scene/action/outfit prompt is appended.
6. ComfyUI renders the image and the result is cached and served back to the game.

Adding a **completely new playable Wayward character** requires a separate
change on the game side so the game has that character, events, state and image
requests. Once the game emits requests for that character, this backend can be
configured to render it too.

## One server, multiple character profiles

You do not need to run one server per character. Configure one shared Anima
checkpoint and map each Wayward character to its own LoRA and prompt fragments:

```json
{
  "imagePreset": "anima",
  "checkpoint": "your_anima_checkpoint.safetensors",
  "characterProfiles": {
    "elena": {
      "loras": [
        {
          "name": "elena_anima_character.safetensors",
          "strengthModel": 0.9,
          "strengthClip": 0.9
        }
      ],
      "positivePromptPrefix": "elena_trigger, 1girl, fixed appearance tags",
      "positivePromptSuffix": "",
      "negativePromptPrefix": "",
      "negativePromptSuffix": ""
    },
    "mara": {
      "loras": [
        {
          "name": "mara_anima_character.safetensors",
          "strengthModel": 0.9,
          "strengthClip": 0.9
        }
      ],
      "positivePromptPrefix": "mara_trigger, 1girl, fixed appearance tags",
      "positivePromptSuffix": "",
      "negativePromptPrefix": "",
      "negativePromptSuffix": ""
    }
  }
}
```

## Prompt composition

The final positive prompt is composed in this order:

```text
[global positive prefix]
+ [character positive prefix / LoRA trigger and fixed appearance]
+ [Wayward scene prompt]
+ [character positive suffix]
+ [global positive suffix]
```

The negative prompt uses the same pattern.

This is important for character LoRAs: the LoRA file alone is often not enough.
Put the LoRA's trigger token and stable identity traits in the corresponding
character profile. Scene-specific content such as pose, clothing, location and
action remains under Wayward's control.

## Current scope

The Anima path currently assumes a checkpoint that can be used through a
standard ComfyUI checkpoint loader plus standard `LoraLoader` nodes. Global
LoRAs and per-character LoRAs are chained, and character LoRAs affect both
**model** and **CLIP**.

If the exact Anima setup you use needs a specialised graph (separate text
encoder/VAE, custom sampler nodes, model patching, etc.), the next extension
should be a still-image workflow JSON template mode. The surrounding routing,
character mapping, prompt composition and cache logic can stay the same.

## Setup process

1. Confirm the exact Anima checkpoint + character LoRA combination works in
   ComfyUI manually.
2. Copy `wayward-imagegen.config.anima.example.json` to
   `wayward-imagegen.config.json`.
3. Fill in the exact checkpoint/LoRA filenames and each LoRA's trigger/base
   prompt.
4. Run:

   ```bash
   bun src/cli.ts doctor
   ```

5. If doctor passes, start the backend:

   ```bash
   bun src/cli.ts
   ```

6. In Wayward, use **Settings -> Image generation -> Automatic**, or point the
   game to `http://127.0.0.1:8189`.

## Cache identity

The cache signature includes the image preset, checkpoint, sampling settings,
LoRA names/strengths, selected character profile and prompt affixes. Changing a
character LoRA or its trigger prompt therefore does not silently reuse an image
from the previous configuration.
