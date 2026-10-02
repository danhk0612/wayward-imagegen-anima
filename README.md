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

Copy:

```text
wayward-imagegen.config.anima.example.json
```

to:

```text
wayward-imagegen.config.json
```

Fill in your exact character LoRA filenames, trigger prompts and base prompts,
then validate the whole local render chain:

```bash
bun src/cli.ts doctor
```

Start the server:

```bash
bun src/cli.ts
```

The default Wayward-facing address is `http://127.0.0.1:8189`.

## Renderer backend status

The current renderer uses **ComfyUI**. Forge Neo also supports Anima, but it
exposes the A1111/Forge API rather than the ComfyUI graph API; direct Forge Neo
support is therefore a distinct backend rather than just changing the URL.
