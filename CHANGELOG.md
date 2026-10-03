# Changelog

## 0.2.0

First browser-configurable Anima-focused release.

### Added

- Native Anima diffusion + Qwen text encoder + Qwen Image VAE workflow.
- Per-character model-only LoRAs, trigger prompts and stable base prompts.
- Optional global/style LoRAs shared across configured characters.
- Browser setup wizard with local ComfyUI auto-discovery and manual remote/custom URL support.
- ComfyUI model, encoder, VAE, LoRA, sampler and scheduler discovery without filesystem path entry.
- Native-Anima compatibility check for required ComfyUI nodes.
- LoRA recommended-prompt importer and conservative explicit trigger metadata suggestions.
- Real Wayward prompt analysis for suggesting a removable legacy identity prefix.
- Exact Wayward -> stripped scene -> final Anima prompt preview.
- End-to-end test render with browser preview.
- Character-specific static image-pack disable/restore.
- Generated-art management, storage usage/status and optional disk cap.
- Setup JSON import/export and automatic config backup/restore.
- Batch pause/resume/clear, backend-owned ComfyUI cancellation and graceful shutdown.
- External `Wayward-Anima-Server.cmd` manager for persistent backend status/start/stop/restart after the game/browser has closed.
- Standalone Windows Portable package that does not require Bun at runtime.
- Lite source package for Bun users.
- Safe Portable updater that preserves config, generated images and configured state paths.

### Changed

- Native Anima uses server-side sampling settings by default instead of inheriting Wayward's legacy Illustrious tuning.
- Balanced Anima defaults are 30 steps, CFG 4.5, `er_sde`, `simple`.
- Routine deploy/update paths preserve existing generated art and runtime data unless an explicit destructive option is used.

### Safety

- Generated-art deletion requires an exact typed confirmation.
- Static image packs are moved to a reversible backup location rather than deleted.
- Portable updates only auto-stop an idle backend that is proven to belong to the selected Wayward root.
- CI validates Portable compilation, setup UI serving, config backup/restore, image-pack round trips and runtime-data preservation.
