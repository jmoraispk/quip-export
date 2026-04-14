const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT_DIR = __dirname;
const INPUT_PATH = path.resolve(process.argv[2] || path.join(ROOT_DIR, 'exports'));
const MD_ROOT = path.resolve(process.argv[3] || path.join(ROOT_DIR, 'exports_md'));
const MEDIA_ROOT = path.resolve(process.argv[4] || path.join(ROOT_DIR, 'exports_md_media'));

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

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quip-pandoc-'));
  const tempHtmlPath = path.join(tempDir, path.basename(htmlPath));

  try {
    fs.writeFileSync(tempHtmlPath, localizedHtml, 'utf8');
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

  const htmlFiles = getHtmlFilesFromInput(INPUT_PATH);
  if (!htmlFiles.length) {
    log(`No HTML files found under ${INPUT_PATH}`);
    return;
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
