# opencode-qoder

English | [简体中文](README.zh-CN.md)

Qoder Global provider plugin for [opencode](https://opencode.ai/). Ported from the global-only pieces of `pi-provider-qoder`: PAT exchange, COSY request signing, Qoder body encoding, chat SSE parsing, reasoning, image input, and tool calls.

Qoder China endpoints and model aliases are intentionally not included.

## Build

```bash
pnpm install
pnpm build
```

## Installation

Add the plugin to `opencode.json`, or adjust the path for your config location:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-qoder"],
  "model": "qoder/auto"
}
```

The plugin registers provider `qoder` and bundles these models: `auto`, `ultimate`, `performance`, `efficient`, `lite`, `qmodel_38max`, `qfmodel`, `qmodel_latest`, `qmodel`, `kmodel_latest`, `kmodel`, `gmodel`, `gfmodel`, `dmodel`, `dfmodel`, `mmodel`, `qmodel_preview`, and `gm51model`.

## Model discovery

The live model list is fetched at startup and refreshed every 15 minutes; when it changes, opencode's catalog reloads automatically. The last live list is cached at `~/.cache/opencode/opencode-qoder-models.json` across restarts. The bundled table is the fallback.

Models advertising reasoning effort levels expose one variant per effort (e.g. `high`, `low`, `max` on `kmodel_latest`), selectable in opencode's model picker.

Model names carry Qoder's credit multiplier, e.g. `(0.5x)`, or `(Free)` during a limited-time promotion. Once credits run out, paid models are marked `Unavailable` but stay selectable; free and zero-multiplier models are not. Both come from the live list, so neither appears while the bundled fallback is in use.

| Variable | Purpose |
| --- | --- |
| `QODER_DISABLE_MODEL_DISCOVERY` | Set to `1`, `true`, or `yes` to disable discovery |
| `QODER_MODEL_LIST_URL` | Override the model list endpoint |
| `QODER_MODEL_CACHE_SECONDS` | Catalog TTL in seconds (default: 3600) |
| `QODER_MODEL_DISK_CACHE` | Override the disk cache path |

## Authenticate

Use a Qoder Personal Access Token (`pt-...`). It is exchanged for a short-lived job token automatically before requests.

```bash
export QODER_PERSONAL_ACCESS_TOKEN="pt-..."
opencode
```

`QODER_PAT` is accepted as an alias.

Or run opencode's auth flow:

```text
/connect qoder
```

Choose `Personal Access Token` and paste the PAT.

After changing the plugin config, quit and restart opencode. Plugins and provider config are loaded at startup.
