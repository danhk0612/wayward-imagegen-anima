# Wayward Anima ImageGen roadmap

## 0.2.0 browser-setup milestone

Completed:

- Native Anima renderer with per-character model-only LoRAs.
- Server-side protection from Wayward's legacy Illustrious steps/CFG/model overrides.
- Optional server-forced Anima resolution; empty means use Wayward's requested size.
- Browser setup wizard at `/setup.html`.
- Live ComfyUI discovery for diffusion models, text encoders, VAEs, LoRAs, samplers and schedulers.
- Character profile add/edit/remove with multiple LoRAs, trigger prompt, base prompt and prompt affixes.
- Live setup validation against ComfyUI.
- End-to-end test render with browser preview.
- Wayward root detection and per-character static image-pack disable/restore.
- Per-character generated-art deletion without touching game saves.
- Batch pause/resume/clear controls.
- Safe backend-owned ComfyUI cancellation and graceful backend shutdown.
- Portable one-click PowerShell launcher with first-run setup flow.
- MIT/NOTICE documentation with third-party model assets excluded.
- Minimal Lite ZIP build script and CI packaging smoke test.
- Standalone Windows Portable ZIP with compiled backend; Bun is not required at runtime.
- CI smoke test for the compiled executable, local setup UI serving, and graceful shutdown.
- Most setup changes apply live without restarting the backend.

## Before 0.2.0 release

- Test the setup wizard against a clean Wayward folder on Windows.
- Verify first-run flow: launcher -> setup -> save -> automatic backend restart -> game.
- Verify a character with no static image pack generates on demand and via pre-generation.
- Verify disable/restore of a downloaded image pack is reversible with real pack files in a disposable/sandbox Wayward copy, not a live library.
- Verify cancel/shutdown while a batch image is running without deleting completed art.
- Check Korean UI text and error messages on Windows PowerShell 5.1.

## Optional later work

- More advanced global/style LoRA controls.
- Optional complex-scene policy UI.
- Model/package download helpers only if licensing and maintenance cost remain acceptable.
- Additional renderer backends such as Forge as separate adapters.

## Production-safety rule

Do not use destructive generated-art reset/deletion checks against a live image library. Routine deploys preserve the config, generated art, cache and static-pack state unless an explicit destructive switch/action is used.
