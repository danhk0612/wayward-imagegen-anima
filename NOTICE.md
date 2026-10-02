# Notice

Wayward Anima ImageGen is based on the `wayward-imagegen` local image-generation
backend by sintention and retains its MIT license and copyright notice.

This fork adds native Anima workflow support, per-character Anima LoRA profiles,
a local setup UI, Wayward image-pack controls, lifecycle controls, deployment
helpers, and related tests/documentation.

The release package intentionally does **not** redistribute ComfyUI, diffusion
models, text encoders, VAEs, LoRAs, or Wayward itself. Those components may have
their own licenses and terms. Users must supply them separately.

The local setup/control APIs are restricted to loopback access because they can
modify local configuration and image-pack files.
