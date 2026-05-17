const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT_DIR = __dirname;
const POSITIONAL = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const FLAGS = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));
const INPUT_PATH = path.resolve(POSITIONAL[0] || path.join(ROOT_DIR, 'exports'));
const MD_ROOT = path.resolve(POSITIONAL[1] || path.join(ROOT_DIR, 'exports_md'));
const MEDIA_ROOT = path.resolve(POSITIONAL[2] || path.join(ROOT_DIR, 'exports_md_media'));
const ONLY_FILES_WITH_HTML = FLAGS.has('--only-with-html');
const ONLY_FILES_WITH_TABLES = FLAGS.has('--only-with-tables');

function log(message) {
  const stamp = new Date().toISOString();
  console.log(`${stamp} ${message}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFilename(inputName, fallback = 'file') {
  const normalized = String(inputName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const cleaned = normalized
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
    .replace(/^\.+/g, '');

  return (cleaned || fallback).slice(0, 180);
}

function getAllHtmlFiles(rootDir) {
  const results = [];

  function visit(currentPath) {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (entry.isFile() && fullPath.toLowerCase().endsWith('.html')) {
        results.push(fullPath);
      }
    }
  }

  visit(rootDir);
  return results.sort((a, b) => a.localeCompare(b));
}

function getHtmlFilesFromInput(inputPath) {
  const stat = fs.statSync(inputPath);
  if (stat.isFile()) {
    return [inputPath];
  }

  return getAllHtmlFiles(inputPath);
}

function inferExtension(urlString, contentType) {
  try {
    const url = new URL(urlString);
    const extFromPath = path.extname(url.pathname);
    if (extFromPath) {
      return extFromPath;
    }
  } catch {
    // Ignore URL parsing failures; use content type fallback below.
  }

  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) {
    return '.png';
  }
  if (type.includes('jpeg') || type.includes('jpg')) {
    return '.jpg';
  }
  if (type.includes('gif')) {
    return '.gif';
  }
  if (type.includes('webp')) {
    return '.webp';
  }
  if (type.includes('svg')) {
    return '.svg';
  }

  return '.bin';
}

async function fetchBinary(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get('content-type') || ''
  };
}

function replaceAsync(input, regex, replacer) {
  const matches = [];
  input.replace(regex, (...args) => {
    matches.push(args);
    return args[0];
  });

  return matches.reduce(
    (promise, matchArgs) =>
      promise.then(async (currentString) => {
        const [match] = matchArgs;
        const replacement = await replacer(...matchArgs);
        return currentString.replace(match, replacement);
      }),
    Promise.resolve(input)
  );
}

async function localizeImages(htmlContent, htmlFilePath, mdFilePath) {
  const htmlBaseRoot = fs.statSync(INPUT_PATH).isDirectory()
    ? INPUT_PATH
    : path.dirname(INPUT_PATH);
  const relativeHtmlPath = path.relative(htmlBaseRoot, htmlFilePath);
  const htmlDir = path.dirname(relativeHtmlPath);
  const htmlBase = path.basename(relativeHtmlPath, '.html');
  const targetMediaDir = path.join(MEDIA_ROOT, htmlDir, sanitizeFilename(htmlBase, 'document'));

  let imageIndex = 0;

  return replaceAsync(
    htmlContent,
    /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi,
    async (match, quote, src) => {
      if (!/^https?:\/\//i.test(src)) {
        return match;
      }

      imageIndex += 1;

      try {
        const downloaded = await fetchBinary(src);
        const extension = inferExtension(src, downloaded.contentType);
        const localName = `${String(imageIndex).padStart(3, '0')}${extension}`;
        const localPath = path.join(targetMediaDir, localName);
        ensureDir(path.dirname(localPath));
        fs.writeFileSync(localPath, downloaded.buffer);

        const relativeFromMd = path.relative(
          path.dirname(mdFilePath),
          localPath
        ).replace(/\\/g, '/');

        return match.replace(src, relativeFromMd);
      } catch (error) {
        log(`WARN failed image download for ${src}: ${error.message}`);
        return match;
      }
    }
  );
}

// Quip's exported HTML carries a heavy load of attributes and wrapper tags
// that Pandoc cannot represent in GFM, so it punts and emits raw HTML. We
// strip the noise here, normalise the table shape Quip uses (a spreadsheet
// with letter column headers and a numeric row column), and let Pandoc emit
// clean pipe tables.
function cleanQuipHtml(html) {
  let result = String(html || '');

  // Drop <colgroup>...</colgroup>; Pandoc cannot represent column widths in GFM.
  result = result.replace(/<colgroup\b[^>]*>[\s\S]*?<\/colgroup>/gi, '');

  // Normalise self-closing th/td so the rest of our regexes can find them.
  result = result.replace(/<(th|td)\b([^>]*?)\/>/gi, '<$1$2></$1>');

  // Collapse <br> inside tables to spaces and flatten in-cell <ul>/<ol> lists
  // to comma-separated inline text. Pandoc cannot represent block content
  // (including lists) inside GFM pipe table cells, so it would otherwise
  // keep the whole table as raw HTML.
  result = result.replace(/<table\b[\s\S]*?<\/table>/gi, (tableHtml) => {
    let out = tableHtml.replace(/<br\s*\/?>/gi, ' ');
    out = out.replace(
      /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi,
      (_match, tag, attrs, cellInner) => {
        let inner = cellInner;
        inner = inner.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, listContent) => {
          const items = [...listContent.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
            .map((mm) => mm[1].replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          return items.join(', ');
        });
        inner = inner.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, listContent) => {
          const items = [...listContent.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
            .map((mm) => mm[1].replace(/\s+/g, ' ').trim())
            .filter(Boolean);
          return items.join('; ');
        });
        return `<${tag}${attrs}>${inner}</${tag}>`;
      }
    );
    return out;
  });

  // Reshape spreadsheet-style tables: drop the A/B/C letter row + row-number column.
  result = reshapeSpreadsheetTables(result);

  // Strip noise attributes from every tag.
  const NOISE_ATTRS = ['id', 'class', 'style', 'title', 'section-style', 'width', 'height', 'align', 'valign', 'target', 'rel'];
  for (const attr of NOISE_ATTRS) {
    result = result.replace(
      new RegExp(`\\s${attr}\\s*=\\s*("[^"]*"|'[^']*')`, 'gi'),
      ''
    );
  }
  // Strip every data-* attribute (Quip emits many — data-section-style,
  // data-nolink, data-remapped, etc. — none of which Pandoc can represent).
  result = result.replace(/\sdata-[a-z0-9-]+\s*=\s*("[^"]*"|'[^']*')/gi, '');

  // Unwrap pure Quip <div> wrappers (e.g. <div data-section-style="5">).
  result = result.replace(/<\/?div\b[^>]*>/gi, '');

  // Unwrap <span> wrappers — Quip uses them only for anchor IDs.
  result = result.replace(/<\/?span\b[^>]*>/gi, '');

  return result;
}

function reshapeSpreadsheetTables(html) {
  return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (fullMatch, inner) => {
    const theadMatch = inner.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i);
    if (!theadMatch) {
      return fullMatch;
    }

    const headerCells = [...theadMatch[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
      .map((m) => (m[1] || '').replace(/\s+/g, ' ').trim());

    if (headerCells.length < 2) {
      return fullMatch;
    }

    const firstEmpty = headerCells[0] === '';
    const restAreLetters = headerCells.slice(1).every(
      (cell, i) => cell === String.fromCharCode(65 + i)
    );
    if (!firstEmpty || !restAreLetters) {
      return fullMatch;
    }

    // Drop the letter-row thead.
    let body = inner.replace(/<thead\b[^>]*>[\s\S]*?<\/thead>/i, '');

    // Drop the row-number first column on every <tr>.
    body = body.replace(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i, (_m, tbodyInner) => {
      const trimmed = tbodyInner.replace(
        /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi,
        (_mTr, trInner) => `<tr>${trInner.replace(/<td\b[^>]*>[\s\S]*?<\/td>/i, '')}</tr>`
      );
      return `<tbody>${trimmed}</tbody>`;
    });

    // Promote the first <tr> in <tbody> to <thead>, converting <td> to <th>.
    body = body.replace(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i, (_m, tbodyInner) => {
      const firstTrMatch = tbodyInner.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/i);
      if (!firstTrMatch) {
        return `<tbody>${tbodyInner}</tbody>`;
      }

      const headerRowCells = firstTrMatch[1].replace(
        /<td\b([^>]*)>([\s\S]*?)<\/td>/gi,
        '<th$1>$2</th>'
      );
      const rest = tbodyInner.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/i, '');
      return `<thead><tr>${headerRowCells}</tr></thead><tbody>${rest}</tbody>`;
    });

    return `<table>${body}</table>`;
  });
}

function runPandoc(inputHtmlPath, outputMdPath) {
  ensureDir(path.dirname(outputMdPath));
  execFileSync('pandoc', [
    inputHtmlPath,
    '-f',
    'html',
    '-t',
    'gfm',
    '-o',
    outputMdPath
  ], {
    stdio: 'inherit'
  });
}

function normalizeMarkdownOutput(markdown) {
  let result = String(markdown || '');

  function getAttr(attributes, name) {
    const match = String(attributes || '').match(
      new RegExp(`${name}="([^"]*)"`, 'i')
    );
    return match ? match[1] : '';
  }

  function imageMarkup(attributes) {
    const src = getAttr(attributes, 'src');
    const alt = getAttr(attributes, 'alt');
    return src ? `![${alt || ''}](${src})` : '';
  }

  function embedMarkup(attributes) {
    const src = getAttr(attributes, 'src');
    return src ? `![](${src})` : '';
  }

  result = result.replace(
    /<div\b[^>]*>\s*<img\b([\s\S]*?)\/>\s*<\/div>/gi,
    (_match, attributes) => imageMarkup(attributes)
  );

  result = result.replace(
    /<img\b([\s\S]*?)\/>/gi,
    (_match, attributes) => imageMarkup(attributes)
  );

  result = result.replace(
    /<div\b[^>]*>\s*<embed\b([\s\S]*?)\/>\s*<\/div>/gi,
    (_match, attributes) => embedMarkup(attributes)
  );

  result = result.replace(
    /<embed\b([\s\S]*?)\/>/gi,
    (_match, attributes) => embedMarkup(attributes)
  );

  // <u>X</u> -> **X**. GFM has no underline; treat as bold emphasis.
  result = result.replace(/<u>([\s\S]*?)<\/u>/gi, '**$1**');

  // Drop residual wrapper tags Pandoc may keep when their attributes are gone.
  result = result.replace(/<\/?(?:div|span)\b[^>]*>/gi, '');

  // Strip stray <br> tags that survived (typically standalone lines).
  result = result.replace(/^\s*<br\s*\/?>\s*$/gim, '');
  result = result.replace(/<br\s*\/?>/gi, '  \n');

  result = result.replace(/\n{3,}/g, '\n\n');
  return result;
}

async function convertOneFile(htmlPath, index, total) {
  const htmlBaseRoot = fs.statSync(INPUT_PATH).isDirectory()
    ? INPUT_PATH
    : path.dirname(INPUT_PATH);
  const relativeHtmlPath = path.relative(htmlBaseRoot, htmlPath);
  const mdPath = path.join(
    MD_ROOT,
    relativeHtmlPath.replace(/\.html$/i, '.md')
  );

  log(`[${index}/${total}] converting ${relativeHtmlPath}`);

  const originalHtml = fs.readFileSync(htmlPath, 'utf8');
  const localizedHtml = await localizeImages(originalHtml, htmlPath, mdPath);
  const cleanedHtml = cleanQuipHtml(localizedHtml);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quip-pandoc-'));
  const tempHtmlPath = path.join(tempDir, path.basename(htmlPath));

  try {
    fs.writeFileSync(tempHtmlPath, cleanedHtml, 'utf8');
    runPandoc(tempHtmlPath, mdPath);
    const generatedMarkdown = fs.readFileSync(mdPath, 'utf8');
    fs.writeFileSync(mdPath, normalizeMarkdownOutput(generatedMarkdown), 'utf8');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore temp cleanup failures.
    }
  }
}

async function main() {
  if (!fs.existsSync(INPUT_PATH)) {
    throw new Error(`HTML export input not found: ${INPUT_PATH}`);
  }

  ensureDir(MD_ROOT);
  ensureDir(MEDIA_ROOT);

  let htmlFiles = getHtmlFilesFromInput(INPUT_PATH);
  if (!htmlFiles.length) {
    log(`No HTML files found under ${INPUT_PATH}`);
    return;
  }

  if (ONLY_FILES_WITH_HTML || ONLY_FILES_WITH_TABLES) {
    const pattern = ONLY_FILES_WITH_TABLES
      ? /<table\b/i
      : /<(?:table|div|span|u|br|colgroup|thead|tbody|tr|td|th|ul|ol|li|a|em|strong|b|i|code|sup|sub|del)\b/i;
    const before = htmlFiles.length;
    htmlFiles = htmlFiles.filter((htmlPath) => {
      const htmlBaseRoot = fs.statSync(INPUT_PATH).isDirectory()
        ? INPUT_PATH
        : path.dirname(INPUT_PATH);
      const relative = path.relative(htmlBaseRoot, htmlPath).replace(/\.html$/i, '.md');
      const mdPath = path.join(MD_ROOT, relative);
      if (!fs.existsSync(mdPath)) {
        return false;
      }
      return pattern.test(fs.readFileSync(mdPath, 'utf8'));
    });
    const flagName = ONLY_FILES_WITH_TABLES ? '--only-with-tables' : '--only-with-html';
    log(`${flagName}: ${htmlFiles.length}/${before} files match the filter.`);
  }

  log(`Found ${htmlFiles.length} HTML files to convert.`);

  let completed = 0;
  for (const [index, htmlPath] of htmlFiles.entries()) {
    await convertOneFile(htmlPath, index + 1, htmlFiles.length);
    completed += 1;
  }

  log(`Done. Converted ${completed} files into ${MD_ROOT}`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
