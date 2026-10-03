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
- Optional global/style LoRAs shared by all configured characters.
- Setup JSON import/export and automatic config-backup restore UI.
- Image-library usage/format/WebP status plus configurable disk-cap control.
- Sandbox CI verifies static image-pack disable/restore without touching a live library.
- Disposable Portable-install helper for clean Wayward first-run testing.
- Safe in-place Portable updater that preserves config/generated images and removes stale runtime/source files.
- Common-local-port ComfyUI discovery with manual remote/custom URL fallback and native-Anima compatibility reporting.
- LoRA recommended-prompt importer with conservative trigger matching.
- Real rendered Wayward prompt analysis for suggesting `gamePromptPrefixToStrip` only after multiple distinct samples.
- Exact renderer-backed prompt transformation preview for raw -> stripped scene -> final Anima prompt.
- Optional explicit LoRA trigger metadata suggestions through ComfyUI; no heuristic guessing from tag-frequency metadata.
- Portable updater preserves custom image/state paths and auto-stops only an idle backend proven to belong to the selected Wayward root.

## Before 0.2.0 release

- Re-check the expanded setup wizard on the clean Windows Wayward test folder after prompt-assistant changes.
- Verify a character with no static image pack generates on demand and via pre-generation.
- Verify cancel/shutdown while a batch image is running without deleting completed art.
- Check Korean UI text and error messages on Windows PowerShell 5.1.

## Optional later work

- Optional complex-scene policy UI.
- Model/package download helpers only if licensing and maintenance cost remain acceptable.
- Additional renderer backends such as Forge as separate adapters.

## Production-safety rule

Do not use destructive generated-art reset/deletion checks against a live image library. Routine deploys preserve the config, generated art, cache and static-pack state unless an explicit destructive switch/action is used.
