# Quip HTML Exporter

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Automation-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-202040)](#getting-started)

This project uses Playwright and Node.js to export all Quip files to HTML (and, optionally, to Markdown).

- ⚡ Export 500 files in 20 minutes
- 📁 Preserve the Quip folder hierarchy locally
- 🖼️ Keep images, links, and tables intact in the exported HTML
- 🔁 Resume safely and skip already-exported files on reruns

## Getting Started

1. Download or clone this repository.
2. Install the required dependencies:

```bash
npm install
npx playwright install chromium
```

3. Start the exporter so Playwright opens Chromium:

```bash
npm start
```

4. On the very first run, log in to Quip in the Chromium window that Playwright opens.
5. Once Quip is fully loaded, continue so the exporter can start running.
6. After the export has started, you can leave the window open, move it to the background, or minimize it while the script continues.

## Output

Exports are written under `exports/` and mirror the Quip tree the script discovers.

Example:

```text
exports/
  folder 1/
    folder 2/
      file 1.html
    folder 3/
      file 2.html
  .quip-export-state.json
```

The state file records successful exports so reruns skip files that were already downloaded.

## Optional Environment Variables

- `HEADLESS=1`: run headless instead of headed
- `QUIP_URL=https://quip.com/`: override the initial Quip URL
- `BROWSE_URL=https://quip.com/browse`: override the browse/folder root URL
- `MAX_RETRIES=3`: override per-document export retries

## Optional: Convert HTML Exports To Markdown

If you have [Pandoc](https://pandoc.org/) installed, you can optionally convert the exported HTML files into a mirrored `exports_md/` directory and download Quip-hosted images into `exports_md_media/`. Pandoc is a separate tool and is not installed by `npm install`.

Run:

```bash
npm run convert:md
```

This optional script:
- keeps the folder structure in `exports_md/`
- downloads Quip image URLs into `exports_md_media/`
- rewrites image references before running Pandoc
