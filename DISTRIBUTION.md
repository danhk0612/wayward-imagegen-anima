# Wayward Anima ImageGen — Lite distribution

## Goal

A small source distribution for Wayward players who already have a working
ComfyUI installation with Anima-compatible models.

The package does not include ComfyUI, models, VAEs, text encoders, LoRAs,
generated images, or Wayward itself.

## Install

1. Extract the ZIP into the folder that contains Wayward's `index.html`.
2. Start ComfyUI.
3. Double-click `Wayward-Anima.cmd`.
4. On first run, the browser setup wizard opens at
   `http://127.0.0.1:8189/setup.html`.
5. Choose the Anima diffusion model, text encoder and VAE reported by ComfyUI.
6. Add a Wayward character ID, choose its LoRA(s), and enter the trigger/base
   prompts.
7. Optionally disable that character's downloaded static image pack so newly
   generated images become authoritative.
8. Save. Restart the local backend once after changing setup values.

After setup, normal use is simply: start ComfyUI, then double-click
`Wayward-Anima.cmd`.

## Runtime layout

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

## Safety / reversibility

Static image packs are disabled by moving character-specific manifests and art
under `_disabled-imagepacks/<character>/`, not by deleting them. They can be
restored from the setup UI.

Deleting AI-generated art affects only the backend's generated image folder and
matching cache entries. It does not modify Wayward save data.

## License

The backend code is distributed under the MIT license. See `LICENSE` and
`NOTICE.md`. Third-party models and applications are not included.
