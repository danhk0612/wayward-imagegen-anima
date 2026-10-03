# Wayward Anima ImageGen — distribution

## Packages

Two release packages are supported:

- **Portable** — recommended for most users. Includes a compiled Windows backend executable, so Bun is not required.
- **Lite** — smaller source package for users who already have Bun installed and prefer the readable TypeScript runtime.

Both packages require an already-working ComfyUI installation and do not include
ComfyUI, diffusion models, VAEs, text encoders, LoRAs, generated images, or
Wayward itself.

## Install

1. Extract either ZIP into the folder that contains Wayward's `index.html`.
2. Start ComfyUI.
3. Double-click `Wayward-Anima.cmd`.
4. On first run, the browser setup wizard opens at
   `http://127.0.0.1:8189/setup.html`.
5. Use local auto-discovery or enter the ComfyUI URL manually. The setup UI
   reads model/encoder/VAE/LoRA filenames from ComfyUI; absolute filesystem
   paths are not required.
6. Add a Wayward character ID and choose its LoRA(s). You may paste the LoRA
   author's recommended prompt and let the setup assistant separate LoRA
   syntax, strength, trigger and stable base tags.
7. Optionally disable that character's downloaded static image pack so newly
   generated images become authoritative.
8. Save. Most settings apply immediately. Changing the ComfyUI URL requires one
   backend restart.

After setup, normal use is simply: start ComfyUI, then double-click
`Wayward-Anima.cmd`. It starts the backend, starts one tray manager for that
Wayward root, and opens the game. Closing the game/browser does not implicitly
stop the backend.

The tray icon shows the canonical backend state reported by
`/api/control/status`: running, generating, or paused. Its menu provides
status, server start/stop/restart, setup, and Wayward launch actions. The tray
reuses `Wayward-Anima-Server.ps1` for those commands; it does not implement a
second lifecycle policy. `Wayward-Anima-Server.cmd` remains the console
alternative. Both refuse to stop port 8189 when it belongs to a different
Wayward installation.

Idle automatic shutdown is optional and OFF by default. When enabled in the
setup UI, the timer is based on the last Wayward/game request. Shutdown is
allowed only after the configured idle interval and only when there is no
foreground generation, no backend job/submission, no running or incomplete
batch (a paused unfinished batch also blocks shutdown), and no backend-owned
ComfyUI queue/running work. If ComfyUI ownership cannot be checked, automatic
shutdown fails closed and leaves the backend running. This means overnight
pre-generation is not interrupted.

For development/test installs, `scripts/install-portable-to-wayward.ps1` can
update an existing Portable installation in place. It preserves the configured
image/state directories (including custom relative paths) and config file,
removes stale runtime/source files, and will only auto-stop port 8189 when it can
prove the idle backend belongs to the target Wayward root.

## Portable layout

```text
Wayward/
  index.html
  Wayward-Anima.cmd
  Wayward-Anima.ps1
  Wayward-Anima-Server.cmd
  Wayward-Anima-Server.ps1
  Wayward-Anima-Tray.cmd
  Wayward-Anima-Tray.ps1
  wayward-imagegen/
    wayward-imagegen.exe
    ui/
    LICENSE
    NOTICE.md
    wayward-imagegen.config.json   # created by setup
    images/                         # generated locally
```

The compiled executable is intentionally kept separate from the browser UI so
the UI remains inspectable and easy to replace without rebuilding the executable.

## Lite layout

```text
Wayward/
  index.html
  Wayward-Anima.cmd
  Wayward-Anima.ps1
  Wayward-Anima-Server.cmd
  Wayward-Anima-Server.ps1
  Wayward-Anima-Tray.cmd
  Wayward-Anima-Tray.ps1
  wayward-imagegen/
    src/
    ui/
    package.json
    LICENSE
    NOTICE.md
    wayward-imagegen.config.json   # created by setup
    images/                         # generated locally
```

Lite additionally requires Bun in PATH.

## Update, stop, and recovery

- **Update:** use the safe Portable installer/update path. It replaces runtime
  files while preserving `wayward-imagegen.config.json`, the configured image
  library, state/batch data and static-pack state. It only auto-stops an idle
  backend proven to belong to the selected Wayward root.
- **Normal stop:** choose **서버 종료** from the tray or use
  `Wayward-Anima-Server.cmd` -> Stop. Active backend-owned work is cancelled
  through the graceful control endpoint and an unfinished batch is paused.
- **Tray problem:** exit/restart only the tray with `Wayward-Anima-Tray.cmd`.
  The tray is not the backend; restarting it does not delete or reset images.
- **Backend problem:** use `Wayward-Anima-Server.cmd` -> Status first. If the
  reported config path belongs to another Wayward installation, do not terminate
  that PID; resolve the port conflict instead.
- **Configuration problem:** open setup and restore an automatic config backup.
  A full backup restore requires one backend restart.
- **Generated art:** routine install/update/restart does not reset generated
  images. Character generated-art deletion remains a separate explicit,
  confirmation-protected action.

## Safety / reversibility

Routine updates preserve the existing config, generated art, image cache, batch
state and static-image-pack state. Character art is only reset when an explicit
reset operation is used. The development helper
`scripts/install-portable-to-wayward.ps1` also performs a safe in-place
Portable update by replacing runtime files while verifying that config and
generated-image data remain unchanged.

Static image packs are disabled by moving character-specific manifests and art
under `_disabled-imagepacks/<character>/`, not by deleting them. They can be
restored from the setup UI.

Deleting AI-generated art affects only the backend's generated image folder and
matching cache entries. It requires an exact typed confirmation such as
`DELETE elena`; it does not modify Wayward save data.

## Build

Lite:

```powershell
./scripts/build-lite-release.ps1
```

Portable:

```powershell
./scripts/build-portable-release.ps1
```

The Portable build uses Bun only at build time. The resulting Windows package
does not require Bun at runtime.

## License

The backend code is distributed under the MIT license. See `LICENSE` and
`NOTICE.md`. Third-party models and applications are not included.
