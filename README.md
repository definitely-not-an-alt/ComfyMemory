# ComfyMemory

Prevents VRAM OOM errors when using ComfyUI for image generation alongside llama.cpp on a single GPU.

## Install

### 1. Install Client Extension

Install from SillyTavern UI: **Download Extensions & Assets** → paste `https://github.com/definitely-not-an-alt/ComfyMemory`

This clones the repo into `data/<your-handle>/extensions/comfymemory/`.

### 2. Link Server Plugin

```bash
ln -s data/<your-handle>/extensions/comfymemory/server SillyTavern/plugins/comfymemory
```

This symlinks the `server/` directory so ST's plugin loader can find it. Updates to the extension also update the server plugin automatically.

### 3. Enable

Set `enableServerPlugins: true` in `config.yaml`, then restart SillyTavern.

## Requirements

- llama.cpp running in router mode
- ComfyUI configured as SD source
