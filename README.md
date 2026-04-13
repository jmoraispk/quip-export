# Quip HTML Exporter

This project uses Playwright and Node.js to export Quip files to HTML while preserving the folder hierarchy locally. It is designed to be robust and typically runs at roughly one file every 2-4 seconds, depending on Quip responsiveness and document size. In one tested run, it exported about 500 files in roughly 20 minutes.

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

If you have [Pandoc](https://pandoc.org/) installed, you can optionally convert the exported HTML files into a mirrored `exports_md/` directory. Pandoc is a separate tool and is not installed by `npm install`.

Windows PowerShell:

```powershell
Get-ChildItem .\exports -Recurse -File -Filter *.html | ForEach-Object { $relative = $_.FullName.Substring((Resolve-Path .\exports).Path.Length + 1); $target = Join-Path .\exports_md ($relative -replace '\.html$', '.md'); New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null; pandoc $_.FullName -f html -t gfm -o $target }
```

Linux/macOS:

```bash
find ./exports -type f -name "*.html" | while read -r f; do rel="${f#./exports/}"; out="./exports_md/${rel%.html}.md"; mkdir -p "$(dirname "$out")"; pandoc "$f" -f html -t gfm -o "$out"; done
```
