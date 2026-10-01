# Workflow UI concept

A standalone, interactive design prototype. It does not modify production components, call models, save to the database, or change artwork.

Serve the repository root locally and open `/mockups/workflow/`. For example, run `python3 -m http.server 4175 --bind 127.0.0.1` from the repository root.

## Design

- **Top:** six workflow steps, with a short explanation of each.
- **Left:** page navigation and page status only.
- **Center:** the Tools palette, artwork, clickable text regions, and canvas view controls.
- **Right:** the active step's settings, the selected text editor, and a consistent next-step action. Canvas tools live on the Tools palette.
- **Settings:** one explicit entry for chapter defaults, AI, series terminology, lettering, and appearance. Each section names its scope.
- **Activity:** background progress, errors, retries, and downloads have one destination.

The right panel always names the operation and its scope. Batch actions have an explicit page/chapter selector. Editing a region is always local to that region. Advanced tools expand in their relevant step. The Settings dialog contains persistent defaults rather than actions that run work.

## Try it

1. Start in Translate on page 09. Click text regions on the artwork and edit the English.
2. Change “Apply to” from this page to the whole chapter.
3. Open Settings and switch between its categories.
4. Continue to Review and approve a line.
5. Open Clean. Inspect the example mask, check the approval box, and simulate cleaning.
6. Try Typeset, Export, page navigation, outline visibility, and zoom.
7. Drag the Tools grip to float the palette, then double-click it to pin the palette back between the pages and the artwork. Switch steps to see the tools change.

State is kept in memory and resets on reload. Page 09 contains the interactive text example. Other pages demonstrate navigation. All job actions explicitly identify their simulated behavior. Compare shows the bundled English reference, not generated output. The step indicator shows navigation position, not verified completion. Production integration should derive task completion from actual workflow state.

Artwork comes from the repository's `fixtures/test-pages/`; its required four-line attribution is shown beneath every page. See `fixtures/test-pages/ATTRIBUTION.txt` for the source attribution. Bootstrap icons load from the existing local dependency. Inter and Rajdhani load from the same Google Fonts stylesheet as the app.
