# WebUI Local Integration Notes

This file documents local goals and conflict-handling rules for this `webui` subtree.

## Primary Goal

Keep `tools/server/webui` aligned with latest upstream bug fixes/features while preserving local WebUI customizations.

Current local features to preserve:

- i18n/localization additions
- Open Responses API support
- Settings UI picker/toggle for chat API mode (including Open Responses selection)
- Minor superficial UI/branding tweaks (unless intentionally dropped)

## Scope Rule (Important)

- `tools/server/webui/**` is the only area with local customizations that must be reviewed carefully.
- Files outside `tools/server/webui/**` are not locally used/customized and can be overwritten by upstream during conflict resolution.

## Conflict Policy

When syncing with upstream:

- Conflicts outside `tools/server/webui/**`: prefer upstream/rebased version.
- Conflicts inside `tools/server/webui/**`: review manually and merge carefully.
- Do not blindly overwrite `webui` files from either side.

### Rebase Semantics Reminder

During `git rebase`, conflict terms are easy to misread:

- `ours` = current rebased state (typically upstream + already-replayed commits)
- `theirs` = the single commit currently being replayed

Choosing `ours` in a rebase conflict does **not** always mean "take local branch"; it often means "drop this replayed commit hunk."

## Preferred Upstream Sync Strategy

Avoid replaying a long historical local commit stack when the goal is simply "latest upstream + preserve current WebUI customizations."

Preferred approach:

1. Start from fresh `upstream/master` (whole repo up to date).
2. Reapply the **net** `tools/server/webui` delta (not every historical commit).
3. Resolve only real conflicts in `webui`.
4. Build/test `webui`.

This reduces conflict volume and avoids repeatedly replaying old or cherry-picked commits.

## Safety / Workflow Notes

- Back up current branch state before large sync operations.
- Preserve uncommitted `webui` changes (stash/patch) before switching branches.
- If a `webui` conflict touches chat request flow, settings, or local DB/storage logic, verify behavior manually (send message, load history, API mode switch).

