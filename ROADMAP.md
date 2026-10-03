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
- Clean Windows Wayward test-folder first-run and expanded setup/prompt-assistant UI validation completed.
- Tagged release workflow builds Lite + Portable packages, generates SHA256 checksums and publishes GitHub release assets.
- Setup UI guidance and launcher/update flow verified on Windows PowerShell; CI also parses all PowerShell scripts with Windows PowerShell 5.1.
- Runtime integration smoke verifies on-demand generation and pre-generation for a character with no static image pack.
- Runtime integration smoke verifies cancelling a running backend-owned batch render leaves completed generated art unchanged.
- Full HTTP shutdown lifecycle smoke verifies an active backend-owned batch render is interrupted, the server closes, and previously completed art remains unchanged.
- External Windows server manager reports the hidden backend PID/status/batch progress and can start/stop/restart/open setup without launching the game; cross-install port ownership is guarded.

## Before 0.2.0 release

- Create the `v0.2.0` tag after the final main-branch CI is green; the tag workflow will publish Lite/Portable ZIPs and SHA256 checksums.

## Optional later work

- Optional complex-scene policy UI.
- Model/package download helpers only if licensing and maintenance cost remain acceptable.
- Additional renderer backends such as Forge as separate adapters.

## Production-safety rule

Do not use destructive generated-art reset/deletion checks against a live image library. Routine deploys preserve the config, generated art, cache and static-pack state unless an explicit destructive switch/action is used.
