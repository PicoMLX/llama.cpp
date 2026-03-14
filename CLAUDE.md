IMPORTANT: Ensure you’ve thoroughly reviewed the [AGENTS.md](AGENTS.md) file before beginning any work.

## Quick Context

This is the PicoMLX fork of llama.cpp. We only use `tools/server/webui/` — the web UI is embedded in **Pico AI Server** (a separate repo). Everything outside that directory is upstream llama.cpp code we do not modify.

## Key Rules

- **Upstream merges**: See AGENTS.md for full details. Files outside `tools/server/webui/` take upstream as-is. Files inside require careful merging to preserve our customizations.
- **Never overwrite** `CLAUDE.md` or `AGENTS.md` with upstream content.
- **Preserve our defaults** when they differ from upstream (e.g., sidebar hidden by default, no auto-open on new chat).
