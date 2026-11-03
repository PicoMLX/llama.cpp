# OpenUI runtime

`renderOpenUI` mounts the official OpenUI React renderer in an opaque-origin,
sandbox without same-origin access. Trusted local assets load once in the parent; a nonce CSP
allows their execution inside `srcdoc`. Model output travels only as OpenUI Lang
data over an occurrence-scoped channel. URLs are action data and never navigate
automatically. Form events are enabled, while CSP blocks form navigation. Appearance and width updates retain the runtime and form state.

The copied runtime, licenses, and version manifests in `static/pico-runtime/openui`
come from PicoMarkdownView's `PicoOpenUIRuntime/Resources/OpenUI`. Recreate them with:

```sh
node src/lib/pico-cards/renderers/openui/sync-runtime.mjs /path/to/PicoOpenUIRuntime/Resources/OpenUI
```

The official JS, CSS, fonts, and notices remain byte identical. `browser.css`
inlines the font files so sandboxed content needs neither CORS access nor network
requests. `BrowserBuildInfo.json` records this derived stylesheet. The small
`browser-host.js` adapter translates the existing native bridge into validated
browser messages. No gateway, remote model SDK, or custom component library is used.

The seven client fixtures are the native runtime's own examples. Browser checks
exercise stock forms, tables, charts, date picker, math, modal, and Markdown links,
plus occurrence isolation, state retention, actions, disposal, and source fallback.
