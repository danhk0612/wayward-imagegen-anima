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
`Wayward-Anima.cmd`.

## Portable layout

```text
Wayward/
  index.html
  Wayward-Anima.cmd
  Wayward-Anima.ps1
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
