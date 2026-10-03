# wayward-imagegen-anima

An Anima-focused adaptation of Wayward's local image-generation backend.

## Current purpose

The project keeps Wayward's existing image-generation HTTP contract and changes
the renderer so existing Wayward characters can be **regenerated in real time**
with:

- native **Anima Base** model loading,
- **per-character Anima LoRAs**,
- per-character LoRA trigger prompts,
- stable per-character base prompts,
- Wayward's dynamic scene/action/outfit prompt,
- local caching and review tooling.

It does **not** by itself create a new playable Wayward character. A brand-new
character also needs game-side character/state/dialogue/event integration.

See [ANIMA_SETUP.md](./ANIMA_SETUP.md) for configuration details.

## Character selection

One backend handles all configured characters. Wayward's `talentName` is used
to select a profile automatically:

```text
Wayward: Elena + current scene
        ↓
profile: characterProfiles.elena
        ↓
Anima diffusion model + Qwen encoder + Qwen VAE
+ Elena character LoRA
+ Elena triggerPrompt
+ Elena basePrompt
+ Wayward dynamic scene prompt
        ↓
render → cache → Wayward
```

There is no need to restart or change the model configuration manually when the
requested character changes.

## Prompt composition

```text
[global prefix]
+ [character trigger]
+ [stable character base prompt]
+ [character prefix]
+ [Wayward dynamic scene prompt]
+ [character suffix]
+ [global suffix]
```

This keeps LoRA identity information stable while allowing Wayward to vary the
pose, clothing, location and action per scene.

## Native Anima path

Anima is loaded as separate components rather than as an SDXL checkpoint:

- `anima-base-v1.0.safetensors`
- `qwen_3_06b_base.safetensors`
- `qwen_image_vae.safetensors`

The native ComfyUI graph uses `UNETLoader + CLIPLoader + VAELoader + KSampler`.
Character/style LoRAs are applied model-only to the Anima diffusion model before
the sampler.

## Quick start

### Browser setup

For normal users, start ComfyUI and then start this backend. Open:

```text
http://127.0.0.1:8189/setup.html
```

The setup wizard can:

- auto-discover common local ComfyUI endpoints or use a manual/remote URL,
- detect diffusion models, text encoders, VAEs, samplers and LoRAs from ComfyUI without absolute filesystem paths,
- report whether the connected ComfyUI has the native Anima node set,
- add/remove Wayward character profiles,
- configure one or more character LoRAs with strengths,
- optionally add global/style LoRAs shared by every configured character,
- import a LoRA author's recommended prompt and separate LoRA syntax/strength, a confidently matched trigger, and stable base tags,
- read explicit trigger metadata from compatible `.safetensors` files through ComfyUI without guessing from training-tag statistics,
- derive a conservative old-game identity prefix from two or more real rendered Wayward prompts,
- preview the exact raw Wayward prompt, stripped scene prompt, and final Anima positive prompt before rendering,
- edit trigger, base and optional prompt-affix text manually when needed,
- validate the selected Anima components against the live ComfyUI instance,
- disable/restore downloaded static image packs per character,
- delete only locally generated art for one character,
- import/export setup JSON and restore automatic config backups,
- inspect image-library size/formats/WebP availability and set a disk cap,
- pause/resume/clear pre-generation work,
- safely cancel backend-owned ComfyUI work and shut down the backend.

Settings are written to `wayward-imagegen.config.json`. Existing settings are
backed up automatically before the UI writes a replacement. Model, LoRA, prompt,
quality and resolution changes apply immediately; only a changed ComfyUI URL
requires a backend restart.

### Command-line setup

The JSON configuration remains fully supported. Copy
`wayward-imagegen.config.anima.example.json` to
`wayward-imagegen.config.json`, edit it, then run:

```bash
bun src/cli.ts doctor
bun src/cli.ts
```

The default Wayward-facing address is `http://127.0.0.1:8189`.

### Release packages

Two Windows packages are supported:

- **Portable** — recommended for normal users; includes a compiled backend and
  does not require Bun at runtime.
- **Lite** — smaller source package for users who already have Bun installed.

Neither package bundles ComfyUI, models, LoRAs, Wayward, generated images or
development artifacts. See [DISTRIBUTION.md](./DISTRIBUTION.md).

## Renderer backend status

The current renderer uses **ComfyUI**. Forge Neo also supports Anima, but it
exposes the A1111/Forge API rather than the ComfyUI graph API; direct Forge Neo
support is therefore a distinct backend rather than just changing the URL.
