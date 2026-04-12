const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium } = require('playwright');

const ROOT_DIR = __dirname;
const EXPORTS_DIR = path.join(ROOT_DIR, 'exports');
const STATE_FILE = path.join(EXPORTS_DIR, '.quip-export-state.json');
const PROFILE_DIR = path.join(ROOT_DIR, '.playwright-profile');
const START_URL = process.env.QUIP_URL || 'https://quip.com/';
const BROWSE_URL = process.env.BROWSE_URL || 'https://quip.com/browse';
const HEADLESS = /^(1|true|yes)$/i.test(process.env.HEADLESS || '');
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);

// Quip's DOM is likely to change over time. Keep the selectors here so they are
// easy to adjust without digging through the rest of the script.
const SELECTORS = {
  workspaceReadyIndicators: [
    '[role="tree"]',
    '[role="navigation"]',
    '[role="main"]',
    'main',
    '[data-testid*="browse"]',
    '[class*="sidebar"]',
    '[class*="browse"]',
    '[class*="folder"]'
  ],

  // Best-effort selectors for the main browse/content pane that lists the
  // current folder's children. These are likely to need manual tuning for Quip.
  browseMainContainers: [
    '[role="main"]',
    'main',
    '[data-testid*="browse"]',
    '[data-testid*="folder"]',
    '[class*="browse"]',
    '[class*="content"]',
    '[class*="pane"]',
    '[class*="list"]'
  ],

  // Folder links are assumed to navigate within Quip's browse UI.
  folderLinks: [
    'a[href*="/browse"]',
    'a[href^="/browse"]'
  ],

  // Document links are assumed to open real Quip documents rather than browse
  // containers. If Quip renders documents without anchors, adjust this area.
  documentLinks: [
    'a[href*="://quip.com/"]:not([href*="/browse"])',
    'a[href^="/"]:not([href^="/browse"])'
  ],

  // Best-effort document title selectors once a document is open.
  documentTitles: [
    'h1',
    '[data-testid*="title"]',
    '[aria-label*="title"]',
    'input[aria-label*="title"]',
    '[contenteditable="true"]'
  ],

  // In-document menu button fallbacks for "more actions".
  // This is another likely adjustment point for Quip.
  documentMenuButtons: [
    'button[aria-label*="More"]',
    'button[aria-label*="more"]',
    'button[aria-label*="Menu"]',
    'button[aria-label*="menu"]',
    'button[aria-label*="Actions"]',
    'button[aria-label*="actions"]',
    '[data-testid*="menu"] button',
    '[data-testid*="more"] button',
    '[class*="menu"] button',
    '[class*="more"] button'
  ]
};

const MENU_LABELS = {
  export: /export/i,
  html: /^html$/i
};

const TIMINGS = {
  defaultTimeoutMs: 15000,
  navigationTimeoutMs: 45000,
  loginWaitMs: 10000,
  menuWaitMs: 8000,
  downloadTimeoutMs: 60000,
  postClickPauseMs: 700,
  postNavigationPauseMs: 1000,
  betweenRetriesMs: 2500,
  workspaceReadyPollMs: 1000,
  maxWorkspaceWaitMs: 120000,
  crawlLoopLimit: 500
};

function log(level, message) {
  const stamp = new Date().toISOString();
  console.log(`${stamp} [${level}] ${message}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }

    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    log('WARN', `Failed to read JSON from ${filePath}: ${error.message}`);
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadState() {
  const state = readJson(STATE_FILE, {
    version: 1,
    exported: {},
    failures: {}
  });

  if (!state.exported || typeof state.exported !== 'object') {
    state.exported = {};
  }

  if (!state.failures || typeof state.failures !== 'object') {
    state.failures = {};
  }

  return state;
}

function saveState(state) {
  writeJson(STATE_FILE, state);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(inputName, fallback = 'untitled') {
  const normalized = String(inputName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  const cleaned = normalized
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim()
    .replace(/^\.+/g, '');

  const safe = cleaned || fallback;
  return safe.slice(0, 180);
}

function sanitizePathSegment(segment, fallback = 'untitled-folder') {
  return sanitizeFilename(segment, fallback);
}

function normalizeDocUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, START_URL);
    url.hash = '';
    url.search = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(rawUrl || '').trim();
  }
}

function normalizeFolderUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, START_URL);
    url.hash = '';
    url.search = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return String(rawUrl || '').trim();
  }
}

function extractDocId(rawUrl) {
  try {
    const url = new URL(rawUrl, START_URL);
    const parts = url.pathname.split('/').filter(Boolean);
    return sanitizeFilename(parts[0] || 'doc', 'doc');
  } catch {
    return 'doc';
  }
}

function buildRelativeFolderPath(pathParts) {
  return pathParts
    .map((part) => sanitizePathSegment(part))
    .filter(Boolean)
    .join(path.sep);
}

function buildUniqueFilePath(relativeFolderPath, baseName, extension, docUrl, reservedPaths) {
  const docId = extractDocId(docUrl);
  const ext = extension || '.html';
  const safeFolderPath = relativeFolderPath || '';
  const absoluteFolderPath = safeFolderPath
    ? path.join(EXPORTS_DIR, safeFolderPath)
    : EXPORTS_DIR;

  ensureDir(absoluteFolderPath);

  const candidates = [
    `${baseName}${ext}`,
    `${baseName} - ${docId}${ext}`
  ];

  for (const candidate of candidates) {
    const relativePath = safeFolderPath
      ? path.join(safeFolderPath, candidate)
      : candidate;
    const lower = relativePath.toLowerCase();
    const fullPath = path.join(EXPORTS_DIR, relativePath);
    if (!reservedPaths.has(lower) && !fs.existsSync(fullPath)) {
      reservedPaths.add(lower);
      return fullPath;
    }
  }

  let counter = 2;
  while (true) {
    const candidate = `${baseName} - ${docId} (${counter})${ext}`;
    const relativePath = safeFolderPath
      ? path.join(safeFolderPath, candidate)
      : candidate;
    const lower = relativePath.toLowerCase();
    const fullPath = path.join(EXPORTS_DIR, relativePath);
    if (!reservedPaths.has(lower) && !fs.existsSync(fullPath)) {
      reservedPaths.add(lower);
      return fullPath;
    }
    counter += 1;
  }
}

function isExportedAndPresent(state, normalizedUrl) {
  const entry = state.exported[normalizedUrl];
  if (!entry) {
    return false;
  }

  const relativePath = entry.relativePath || entry.filename;
  if (!relativePath) {
    return false;
  }

  const fullPath = path.join(EXPORTS_DIR, relativePath);
  return fs.existsSync(fullPath);
}

async function promptForEnter(message) {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(`${message}\n`);
  } finally {
    rl.close();
  }
}

async function safeIsVisible(locator) {
  try {
    return await locator.isVisible();
  } catch {
    return false;
  }
}

async function firstVisibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) {
      continue;
    }

    if (await safeIsVisible(locator)) {
      return locator;
    }
  }

  return null;
}

async function looksLoggedIn(page) {
  const url = page.url();
  if (!/quip\.com/i.test(url)) {
    return false;
  }

  if (/login|signup|signin/i.test(url)) {
    return false;
  }

  const indicator = await firstVisibleLocator(page, SELECTORS.workspaceReadyIndicators);
  if (indicator) {
    return true;
  }

  const links = await collectFolderPageEntries(page);
  return links.documents.length > 0 || links.folders.length > 0;
}

async function waitForWorkspaceReady(page) {
  const deadline = Date.now() + TIMINGS.maxWorkspaceWaitMs;

  while (Date.now() < deadline) {
    if (await looksLoggedIn(page)) {
      return true;
    }
    await page.waitForTimeout(TIMINGS.workspaceReadyPollMs);
  }

  return false;
}

async function ensureLoggedIn(page) {
  await page.goto(START_URL, {
    waitUntil: 'domcontentloaded',
    timeout: TIMINGS.navigationTimeoutMs
  });

  await page.waitForTimeout(TIMINGS.loginWaitMs);

  if (await looksLoggedIn(page)) {
    log('INFO', 'Quip appears to be logged in already.');
    return;
  }

  log('INFO', 'Manual login may be required. Complete login in the browser window.');
  await promptForEnter('After Quip is fully logged in and the workspace is visible, press Enter to continue.');

  const ready = await waitForWorkspaceReady(page);
  if (!ready) {
    throw new Error('Workspace did not become ready after manual login prompt.');
  }
}

function isLikelyDocumentUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, START_URL);
    if (!/quip\.com$/i.test(url.hostname)) {
      return false;
    }

    const normalizedPath = url.pathname.toLowerCase();
    if (!normalizedPath || normalizedPath === '/') {
      return false;
    }

    const blockedPrefixes = [
      '/blog',
      '/account',
      '/help',
      '/support',
      '/desktop',
      '/marketing',
      '/jobs',
      '/about',
      '/signup',
      '/login'
    ];

    return !blockedPrefixes.some((prefix) => normalizedPath.startsWith(prefix));
  } catch {
    return false;
  }
}

function isLikelyFolderUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, START_URL);
    return /quip\.com$/i.test(url.hostname) && url.pathname.toLowerCase().startsWith('/browse');
  } catch {
    return false;
  }
}

function formatFolderPath(pathParts) {
  if (!pathParts || !pathParts.length) {
    return '(root)';
  }

  return pathParts.join(' / ');
}

async function collectFolderPageEntries(page) {
  return page.evaluate((selectors, startUrl) => {
    function isVisible(element) {
      if (!element) {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (!style || style.visibility === 'hidden' || style.display === 'none') {
        return false;
      }

      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function normalizeWhitespace(text) {
      return String(text || '').replace(/\s+/g, ' ').trim();
    }

    function isLikelyDocumentUrl(rawUrl) {
      try {
        const url = new URL(rawUrl, startUrl);
        if (!/quip\.com$/i.test(url.hostname)) {
          return false;
        }

        const pathName = url.pathname.toLowerCase();
        if (!pathName || pathName === '/') {
          return false;
        }

        const blocked = [
          '/blog',
          '/account',
          '/help',
          '/support',
          '/desktop',
          '/marketing',
          '/jobs',
          '/about',
          '/signup',
          '/login'
        ];

        return !blocked.some((prefix) => pathName.startsWith(prefix));
      } catch {
        return false;
      }
    }

    function isLikelyFolderUrl(rawUrl) {
      try {
        const url = new URL(rawUrl, startUrl);
        return /quip\.com$/i.test(url.hostname) && url.pathname.toLowerCase().startsWith('/browse');
      } catch {
        return false;
      }
    }

    function normalizeUrl(rawUrl) {
      try {
        const url = new URL(rawUrl, startUrl);
        url.hash = '';
        url.search = '';
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
      } catch {
        return rawUrl;
      }
    }

    function pickRoot() {
      const candidates = [];

      for (const selector of selectors.browseMainContainers) {
        for (const node of document.querySelectorAll(selector)) {
          if (!isVisible(node)) {
            continue;
          }

          const rect = node.getBoundingClientRect();
          const anchorCount = node.querySelectorAll('a[href]').length;
          const score = rect.width * rect.height + anchorCount * 1000;
          candidates.push({ node, score });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      return candidates[0] ? candidates[0].node : document.body;
    }

    function extractTitle(anchor) {
      const row = anchor.closest('[role="row"], [role="treeitem"], li, tr, [class*="row"], [class*="item"]');
      return (
        normalizeWhitespace(anchor.getAttribute('aria-label')) ||
        normalizeWhitespace(anchor.getAttribute('title')) ||
        normalizeWhitespace(anchor.textContent) ||
        normalizeWhitespace(anchor.innerText) ||
        normalizeWhitespace(row && row.textContent) ||
        'Untitled'
      );
    }

    const root = pickRoot();
    const folderItems = [];
    const documentItems = [];
    const seenFolders = new Set();
    const seenDocuments = new Set();
    const combinedSelectors = Array.from(
      new Set([].concat(selectors.folderLinks, selectors.documentLinks))
    );
    const anchors = Array.from(root.querySelectorAll(combinedSelectors.join(',')));

    for (const anchor of anchors) {
      if (!isVisible(anchor)) {
        continue;
      }

      const href = anchor.href || anchor.getAttribute('href') || '';
      const title = extractTitle(anchor);
      const normalizedUrl = normalizeUrl(href);

      if (isLikelyFolderUrl(href)) {
        if (seenFolders.has(normalizedUrl)) {
          continue;
        }

        seenFolders.add(normalizedUrl);
        folderItems.push({ url: normalizedUrl, title });
        continue;
      }

      if (!isLikelyDocumentUrl(href)) {
        continue;
      }

      if (seenDocuments.has(normalizedUrl)) {
        continue;
      }

      seenDocuments.add(normalizedUrl);
      documentItems.push({ url: normalizedUrl, title });
    }

    return {
      folders: folderItems,
      documents: documentItems
    };
  }, {
    browseMainContainers: SELECTORS.browseMainContainers,
    folderLinks: SELECTORS.folderLinks,
    documentLinks: SELECTORS.documentLinks
  }, START_URL);
}

async function openBrowseFolder(page, folderUrl) {
  const normalizedUrl = normalizeFolderUrl(folderUrl);
  await page.goto(normalizedUrl, {
    waitUntil: 'domcontentloaded',
    timeout: TIMINGS.navigationTimeoutMs
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(TIMINGS.postNavigationPauseMs);
}

async function crawlWorkspaceDocuments(page) {
  const discoveredDocuments = new Map();
  const discoveredFolders = new Set();
  const queuedFolderUrls = new Set();
  const queue = [
    {
      url: normalizeFolderUrl(BROWSE_URL),
      pathParts: []
    }
  ];

  queuedFolderUrls.add(normalizeFolderUrl(BROWSE_URL));

  let loopCount = 0;
  while (queue.length) {
    loopCount += 1;
    if (loopCount > TIMINGS.crawlLoopLimit) {
      throw new Error('Folder crawl exceeded the safety loop limit.');
    }

    const currentFolder = queue.shift();
    const normalizedFolderUrl = normalizeFolderUrl(currentFolder.url);

    if (discoveredFolders.has(normalizedFolderUrl)) {
      continue;
    }

    log('INFO', `Opening folder: ${formatFolderPath(currentFolder.pathParts)} -> ${normalizedFolderUrl}`);
    await openBrowseFolder(page, normalizedFolderUrl);
    discoveredFolders.add(normalizedFolderUrl);

    const entries = await collectFolderPageEntries(page);

    for (const documentItem of entries.documents) {
      const normalizedDocUrl = normalizeDocUrl(documentItem.url);
      if (!isLikelyDocumentUrl(normalizedDocUrl)) {
        continue;
      }

      if (!discoveredDocuments.has(normalizedDocUrl)) {
        discoveredDocuments.set(normalizedDocUrl, {
          url: normalizedDocUrl,
          title: documentItem.title || extractDocId(normalizedDocUrl),
          folderPathParts: currentFolder.pathParts.slice()
        });
      }
    }

    for (const folderItem of entries.folders) {
      const normalizedChildFolderUrl = normalizeFolderUrl(folderItem.url);
      if (!isLikelyFolderUrl(normalizedChildFolderUrl)) {
        continue;
      }

      if (
        normalizedChildFolderUrl === normalizedFolderUrl ||
        discoveredFolders.has(normalizedChildFolderUrl) ||
        queuedFolderUrls.has(normalizedChildFolderUrl)
      ) {
        continue;
      }

      queue.push({
        url: normalizedChildFolderUrl,
        pathParts: currentFolder.pathParts.concat([
          folderItem.title || 'Untitled Folder'
        ])
      });
      queuedFolderUrls.add(normalizedChildFolderUrl);
    }

    log(
      'INFO',
      `Folder crawl progress: ${discoveredFolders.size} folders visited, ${discoveredDocuments.size} unique documents discovered.`
    );
  }

  return Array.from(discoveredDocuments.values());
}

async function getDocumentTitle(page, fallbackTitle, docUrl) {
  for (const selector of SELECTORS.documentTitles) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) {
      continue;
    }

    if (!(await safeIsVisible(locator))) {
      continue;
    }

    try {
      let text = await locator.textContent();
      if (!text) {
        text = await locator.inputValue().catch(() => '');
      }
      text = String(text || '').replace(/\s+/g, ' ').trim();
      if (text) {
        return text;
      }
    } catch {
      // Continue trying other selectors.
    }
  }

  if (fallbackTitle && fallbackTitle.trim()) {
    return fallbackTitle.trim();
  }

  return extractDocId(docUrl);
}

async function clickFirstVisibleLocator(candidates, actionLabel) {
  for (const locator of candidates) {
    if (await safeIsVisible(locator)) {
      await locator.click({ timeout: TIMINGS.menuWaitMs });
      return true;
    }
  }

  throw new Error(`Could not find a visible control for ${actionLabel}.`);
}

async function openDocumentMenu(page) {
  const roleCandidates = [
    page.getByRole('button', { name: /more/i }).first(),
    page.getByRole('button', { name: /menu/i }).first(),
    page.getByRole('button', { name: /actions/i }).first()
  ];

  const selectorCandidates = SELECTORS.documentMenuButtons.map((selector) =>
    page.locator(selector).first()
  );

  await clickFirstVisibleLocator(
    [...roleCandidates, ...selectorCandidates],
    'document menu'
  );

  await page.waitForTimeout(TIMINGS.postClickPauseMs);
}

async function findMenuItem(page, labelPattern) {
  const roleItem = page.getByRole('menuitem', { name: labelPattern }).first();
  if (await safeIsVisible(roleItem)) {
    return roleItem;
  }

  const genericText = page.getByText(labelPattern, { exact: false }).first();
  if (await safeIsVisible(genericText)) {
    return genericText;
  }

  return null;
}

async function triggerHtmlExport(page) {
  const exportItem = await findMenuItem(page, MENU_LABELS.export);
  if (!exportItem) {
    throw new Error('Could not find Export menu item.');
  }

  await exportItem.hover().catch(() => {});
  await exportItem.click({ timeout: TIMINGS.menuWaitMs }).catch(async () => {
    await exportItem.hover({ timeout: TIMINGS.menuWaitMs });
  });

  await page.waitForTimeout(TIMINGS.postClickPauseMs);

  const htmlItem = await findMenuItem(page, MENU_LABELS.html);
  if (!htmlItem) {
    throw new Error('Could not find HTML export menu item.');
  }

  const downloadPromise = page.waitForEvent('download', {
    timeout: TIMINGS.downloadTimeoutMs
  });

  await htmlItem.click({ timeout: TIMINGS.menuWaitMs });
  return downloadPromise;
}

async function downloadExport(page, doc) {
  const normalizedUrl = normalizeDocUrl(doc.url);
  await page.goto(normalizedUrl, {
    waitUntil: 'domcontentloaded',
    timeout: TIMINGS.navigationTimeoutMs
  });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(TIMINGS.postClickPauseMs);

  const resolvedTitle = await getDocumentTitle(page, doc.title, normalizedUrl);
  log('INFO', `Opened document: ${resolvedTitle}`);

  await openDocumentMenu(page);
  const downloadPromise = await triggerHtmlExport(page);
  const download = await downloadPromise;

  const failure = await download.failure();
  if (failure) {
    throw new Error(`Download failed before save: ${failure}`);
  }

  const suggestedName = await download
    .suggestedFilename()
    .catch(() => 'document.html');
  const extension = path.extname(suggestedName) || '.html';
  const safeBase = sanitizeFilename(resolvedTitle, 'untitled');
  const relativeFolderPath = buildRelativeFolderPath(doc.folderPathParts || []);
  const outputPath = buildUniqueFilePath(
    relativeFolderPath,
    safeBase,
    extension,
    normalizedUrl,
    page.__reservedExportPaths
  );
  const relativeOutputPath = path.relative(EXPORTS_DIR, outputPath);

  await download.saveAs(outputPath);

  log('INFO', `Download completed: ${relativeOutputPath}`);
  return {
    title: resolvedTitle,
    relativePath: relativeOutputPath
  };
}

async function exportDocumentWithRetries(page, doc, state) {
  const normalizedUrl = normalizeDocUrl(doc.url);

  if (isExportedAndPresent(state, normalizedUrl)) {
    const existing = state.exported[normalizedUrl];
    log('INFO', `Skip already exported: ${existing.title || doc.title || normalizedUrl}`);
    return { skipped: true, relativePath: existing.relativePath || existing.filename };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      log(
        'INFO',
        `Exporting (${attempt}/${MAX_RETRIES}): ${doc.title || normalizedUrl}`
      );

      const result = await downloadExport(page, doc);
      state.exported[normalizedUrl] = {
        sourceUrl: normalizedUrl,
        title: result.title,
        relativePath: result.relativePath,
        folderPathParts: doc.folderPathParts || [],
        exportedAt: new Date().toISOString()
      };
      delete state.failures[normalizedUrl];
      saveState(state);

      return { skipped: false, relativePath: result.relativePath };
    } catch (error) {
      log(
        'WARN',
        `Attempt ${attempt} failed for ${doc.title || normalizedUrl}: ${error.message}`
      );

      if (attempt === MAX_RETRIES) {
        state.failures[normalizedUrl] = {
          sourceUrl: normalizedUrl,
          title: doc.title || normalizedUrl,
          folderPathParts: doc.folderPathParts || [],
          failedAt: new Date().toISOString(),
          error: error.message
        };
        saveState(state);
        throw error;
      }

      await sleep(TIMINGS.betweenRetriesMs);
    }
  }

  throw new Error('Unexpected retry flow.');
}

async function main() {
  ensureDir(EXPORTS_DIR);
  ensureDir(PROFILE_DIR);

  const state = loadState();
  const reservedPaths = new Set(
    Object.values(state.exported)
      .map((entry) => String(entry.relativePath || entry.filename || '').toLowerCase().trim())
      .filter(Boolean)
  );

  log('INFO', `Exports directory: ${EXPORTS_DIR}`);
  log('INFO', `State file: ${STATE_FILE}`);
  log('INFO', `Headless mode: ${HEADLESS ? 'enabled' : 'disabled'}`);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 }
  });

  context.setDefaultTimeout(TIMINGS.defaultTimeoutMs);

  try {
    const page = context.pages()[0] || (await context.newPage());
    page.__reservedExportPaths = reservedPaths;

    page.on('pageerror', (error) => {
      log('WARN', `Page error: ${error.message}`);
    });

    page.on('console', (message) => {
      if (message.type() === 'error') {
        log('WARN', `Browser console error: ${message.text()}`);
      }
    });

    await ensureLoggedIn(page);

    log('INFO', `Starting Quip folder crawl from ${BROWSE_URL}`);
    const documents = await crawlWorkspaceDocuments(page);

    if (!documents.length) {
      log(
        'WARN',
        'No document links were discovered. Adjust the browse and document selectors near the top of the script if Quip uses a different DOM structure in your workspace.'
      );
      return;
    }

    const uniqueDocs = [];
    const seenUrls = new Set();

    for (const documentItem of documents) {
      const normalized = normalizeDocUrl(documentItem.url);
      if (seenUrls.has(normalized)) {
        continue;
      }

      seenUrls.add(normalized);
      uniqueDocs.push({
        url: normalized,
        title: documentItem.title || extractDocId(normalized),
        folderPathParts: documentItem.folderPathParts || []
      });
    }

    log('INFO', `Collected ${uniqueDocs.length} unique documents to process.`);

    let successCount = 0;
    let skippedCount = 0;
    let failureCount = 0;

    for (const doc of uniqueDocs) {
      try {
        const result = await exportDocumentWithRetries(page, doc, state);
        if (result.skipped) {
          skippedCount += 1;
        } else {
          successCount += 1;
        }
      } catch (error) {
        failureCount += 1;
        log('ERROR', `Failed to export ${doc.title || doc.url}: ${error.message}`);
      }
    }

    log(
      'INFO',
      `Finished. Success: ${successCount}, skipped: ${skippedCount}, failed: ${failureCount}.`
    );
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  log('ERROR', error.stack || error.message || String(error));
  process.exitCode = 1;
});
