# Pele fallback for Mermaid diagrams

Mermaid.js remains the renderer for its supported diagram families. `isPeleFallbackDiagram` recognizes only `usecase-beta` and `agentflow-beta`, including a leading YAML frontmatter block and Mermaid comments. `renderPeleFallback(source, dark, options?)` returns SVG for these two families. The caller sanitizes the SVG and mounts it in the existing diagram card.

The runtime is the same pinned Pele 1.9.1 browser bundle and Swift bridge shipped by PicoMarkdownView-HTML. It runs offline in a classic worker, with a deadline and optional abort signal; each completed, failed, cancelled, or timed-out request terminates its worker. Source limits match the native provider: 32,768 UTF-8 bytes and 1,024 lines. Worker source and output are not logged.

Pele's text-measurement callback uses `OffscreenCanvas.measureText` when available, mapping bold, italic, monospace, subscript and superscript flags to the canvas font. Browsers without OffscreenCanvas retain Pele's built-in Arial metrics. The native bridge resolves theme variables to concrete SVG values. Runtime version, integrity digests, and licenses live beside the static assets under `static/pico-runtime/pele/`.

The portable native fixture set contains 91 examples across 32 families: 32 reference examples, one skill example and 58 demo examples. The browser regression renders the 85 examples supported by Mermaid.js there, and routes the six usecase/agentflow examples through Pele. This establishes fixture coverage, not complete syntax or pixel-for-pixel native drawing equivalence.
