# Agents Guide for llama.cpp (Pico AI Fork)

## Project Context

This is a fork of [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) maintained by PicoMLX. We only use the **web UI** located at `tools/server/webui/` (and its subdirectories). The web UI is embedded in a separate product called **Pico AI Server**, which lives in a different repository.

Everything outside `tools/server/webui/` is upstream code we do not modify.

## Upstream Merge Rules

The upstream remote is `upstream` (https://github.com/ggml-org/llama.cpp.git). Our fork is `origin` (https://github.com/PicoMLX/llama.cpp).

When merging upstream changes, follow these rules strictly:

### 1. Files outside `tools/server/webui/`
Accept all upstream changes as-is. We do not customize anything outside the web UI directory.

### 2. Files inside `tools/server/webui/`
Merge with care. We have custom modifications to the web UI for Pico AI Server. When conflicts arise:

- **Preserve our logic over upstream logic** when we have intentionally changed behavior. Use common sense: if our change is a deliberate customization (not a bug), keep ours.
- **Accept upstream additions** (new files, new features, new settings) unless they conflict with our customizations.
- **Accept upstream bug fixes and refactors** unless they revert our intentional changes.

### 3. Known Customizations to Preserve

These are examples of intentional behavior changes we have made. Always preserve our versions during merges:

- **Sidebar defaults**: We hide the conversation sidebar by default (`alwaysShowSidebarOnDesktop: false`) and do NOT auto-open it on new conversations (`autoShowSidebarOnNewChat: false`). Upstream defaults are the opposite. Our values must be preserved.
- **Settings defaults and UI tweaks**: Any default values we have changed in `settings-config.ts` or behavior we have modified in the settings UI reflect deliberate product decisions for Pico AI Server.
- **Additional settings/features**: We may add settings (e.g., MCP server configuration, agentic settings, raw model names) that don't exist upstream. These must be preserved.

### 4. Protected Files
Never overwrite these files with upstream content:
- `AGENTS.md` (this file)
- `CLAUDE.md`

### 5. Merge Workflow

```bash
# Fetch upstream
git fetch upstream

# Merge upstream/master into your working branch
git merge upstream/master

# Resolve conflicts in tools/server/webui/ manually, preserving our customizations
# Accept upstream changes for everything else

# Test the web UI after merging
cd tools/server/webui && npm run build
```

### 6. Conflict Resolution Principles

When resolving merge conflicts in `tools/server/webui/`:

1. **Read both sides** of the conflict before choosing.
2. If the conflict is in a **default value or behavioral setting** we customized, keep ours.
3. If the conflict is in **shared logic** (e.g., a function we also modified), integrate both changes: take the upstream improvement while preserving our behavioral intent.
4. If upstream **renamed, moved, or restructured** files we modified, apply our customizations to the new structure.
5. When in doubt, ask the user rather than guessing.
