# Quip HTML Exporter

This project uses Playwright and Node.js to crawl the Quip browse UI, expand the visible folder tree, gather accessible document rows, and export each document to HTML while preserving the folder hierarchy locally.

The script is designed to be conservative and rerunnable:

- It launches Chromium in headed mode by default so manual login is easy.
- It uses a persistent browser profile so login sessions can survive reruns.
- It keeps a state file to skip documents that were already exported successfully.
- It saves downloaded files into `exports/`.
- It recreates the discovered Quip folder structure under `exports/`.
- It sanitizes filenames for cross-platform safety.
- It logs progress, retries, skips, failures, and download completion.

## Files

- `export-quip-html.js`: main exporter script
- `exports/`: download output directory created automatically
- `exports/.quip-export-state.json`: state file created automatically
- `.playwright-profile/`: persistent Chromium profile created automatically

## Prerequisites

- Node.js 18+ recommended
- A Quip account with access to the documents you want to export

## Setup

```bash
npm install
npx playwright install chromium
```

## Run

```bash
npm start
```

The browser opens in headed mode by default. If Quip is not already authenticated in the persistent profile, log in manually in the opened browser window and then continue when prompted in the terminal.

## Output

Exports are written under `exports/` and mirror the Quip tree the script discovers.

Example:

```text
exports/
  Private/
    Books/
      How does 5G work-.html
    Course Projects/
      Machine Vision Project [Parkour Spot ID].html
  .quip-export-state.json
```

The state file records successful exports so reruns skip files that were already downloaded.

## Optional Environment Variables

- `HEADLESS=1`: run headless instead of headed
- `QUIP_URL=https://quip.com/`: override the initial Quip URL
- `BROWSE_URL=https://quip.com/browse`: override the browse/folder root URL
- `MAX_RETRIES=3`: override per-document export retries

Examples:

```bash
HEADLESS=1 npm start
```

```bash
MAX_RETRIES=5 npm start
```

## How It Works

1. Opens Quip with a persistent Chromium profile.
2. Waits for login if needed.
3. Starts from `https://quip.com/browse`.
4. Expands folders in the right-hand Quip tree.
5. Walks the expanded tree to collect file rows and their folder paths.
6. Deduplicates documents by normalized URL or a fallback tree key.
7. Activates the browse pane once, then right-clicks each file row.
8. Uses Quip's context menu flow `Export -> HTML`.
9. Saves the download into `exports/<folder path>/` using a sanitized filename.
10. Records successful exports in `exports/.quip-export-state.json`.

## Notes

- The script favors robustness over elegance and contains several selector fallbacks near the top of `export-quip-html.js`.
- Quip can change its DOM and menu structure. If a menu item or sidebar control is not found, adjust the selector constants at the top of the script.
- Documents are skipped on reruns only if they already exist in the state file and the exported file is still present on disk.
- The script preserves folder structure based on the expanded Quip tree it can see in the right pane.
- The first file export may require the browse pane to receive focus. The script now does an initial left click automatically before the first right click.
- The script only exports documents it can discover from the expanded Quip tree. If Quip changes its virtualized tree structure, you may need to adjust the selectors.

## Known limitations / selectors to verify

- `SELECTORS.browseMainContainers`: Quip may use a different DOM container for the main folder contents pane.
- `SELECTORS.folderLinks`: Quip folder rows may not be exposed as plain browse anchors in every view.
- `SELECTORS.documentLinks`: some Quip file rows may not render as standard anchors with `href`.
- `SELECTORS.documentMenuButtons`: the in-document "more actions" button label or DOM structure may differ.
- `MENU_LABELS.export` and `MENU_LABELS.html`: menu text may vary slightly depending on Quip UI changes.
- The script assumes the HTML export is reachable from the document UI via `Export -> HTML`, either by click or hover-to-open submenu behavior.
- The current folder walker assumes subfolders are discoverable from `https://quip.com/browse` pages. If Quip requires expanding a virtualized tree instead, the crawl selectors/strategy will need adjustment.
