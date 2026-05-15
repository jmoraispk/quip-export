const fs = require('fs');
const path = require('path');
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
    '.navigation-controller-main.has-sidebar',
    '.navigation-controller-main.has-sidebar .folder-list-body',
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
    '.navigation-controller-main.has-sidebar .folder-list-body',
    '.navigation-controller-main.has-sidebar .navigation-controller-body.scrollable',
    '.navigation-controller-main.has-sidebar',
    '[role="main"]',
    'main',
    '[data-testid*="browse"]',
    '[data-testid*="folder"]',
    '[class*="browse"]',
    '[class*="content"]',
    '[class*="pane"]',
    '[class*="list"]'
  ],

  // Containers that are likely part of the left navigation and should not be
  // treated as the exportable file list.
  browseSidebarContainers: [
    '.drawer-body.scrollable.scrollable-composited',
    '[role="navigation"]',
    '[role="tree"]',
    'nav',
    'aside',
    '[class*="sidebar"]',
    '[class*="left"]'
  ],

  // Folder links are assumed to navigate within Quip's browse UI.
  folderLinks: [
    '.navigation-controller-main.has-sidebar .folder-list-row a[href*="/browse"]',
    '.navigation-controller-main.has-sidebar .folder-list-row a[href^="/browse"]',
    'a[href*="/browse"]',
    'a[href^="/browse"]'
  ],

  // Document links are assumed to open real Quip documents rather than browse
  // containers. If Quip renders documents without anchors, adjust this area.
  documentLinks: [
    '.navigation-controller-main.has-sidebar .folder-list-row a[href*="://quip.com/"]:not([href*="/browse"])',
    '.navigation-controller-main.has-sidebar .folder-list-row a[href^="/"]:not([href^="/browse"])',
    'a[href*="://quip.com/"]:not([href*="/browse"])',
    'a[href^="/"]:not([href^="/browse"])'
  ],

  browseRows: [
    '.navigation-controller-main.has-sidebar .folder-list-body .folder-list-row',
    '.navigation-controller-main.has-sidebar .folder-list-row'
  ],

  nestedFolderContainers: [
    '.folder-list-rows'
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
  ],

  contextMenuPopovers: [
    '.popover.spaceship-popover.visible .parts-menu.scrollable',
    '.popover.spaceship-popover.visible .parts-menu'
  ],

  contextMenuRows: [
    '.popover.spaceship-popover.visible .menu-row'
  ],

  contextMenuLabels: [
    '.parts-menu-label'
  ]
};

const MENU_LABELS = {
  export: /export/i,
  html: /^html$/i
};

const TIMINGS = {
  defaultTimeoutMs: 15000,
  navigationTimeoutMs: 45000,
  menuWaitMs: 8000,
  downloadTimeoutMs: 60000,
  postClickPauseMs: 700,
  postNavigationPauseMs: 1000,
  folderContentsLoadMs: 6000,
  postContextMenuPauseMs: 800,
  betweenRetriesMs: 2500,
  workspaceReadyPollMs: 1000,
  loginPollMs: 5000,
  loginReminderMs: 10000,
  maxLoginWaitMs: 5 * 60 * 1000,
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

  if (await looksLoggedIn(page)) {
    log('INFO', 'Quip login detected. Starting export.');
    return;
  }

  log('INFO', 'Log into Quip in the Chromium window. The exporter will start automatically once login is detected.');

  const deadline = Date.now() + TIMINGS.maxLoginWaitMs;
  let lastReminderAt = Date.now();

  while (Date.now() < deadline) {
    await page.waitForTimeout(TIMINGS.loginPollMs);

    if (await looksLoggedIn(page)) {
      log('INFO', 'Quip login detected. Starting export.');
      return;
    }

    if (Date.now() - lastReminderAt >= TIMINGS.loginReminderMs) {
      log('INFO', 'Waiting for Quip login...');
      lastReminderAt = Date.now();
    }
  }

  throw new Error('Timed out waiting for Quip login.');
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
  return page.evaluate(({ selectors, startUrl }) => {
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

    function getRowTitle(row) {
      const anchor = row.querySelector('a[href], a[aria-label]');
      if (anchor) {
        const title =
          normalizeWhitespace(anchor.getAttribute('aria-label')) ||
          normalizeWhitespace(anchor.getAttribute('title')) ||
          normalizeWhitespace(anchor.textContent) ||
          normalizeWhitespace(anchor.innerText);
        if (title) {
          return title;
        }
      }

      const clone = row.cloneNode(true);
      for (const nested of clone.querySelectorAll('.folder-list-rows')) {
        nested.remove();
      }

      return normalizeWhitespace(clone.textContent);
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

    function isSidebarLike(node) {
      if (!node || node === document.body) {
        return false;
      }

      if (
        node.matches &&
        selectors.browseSidebarContainers.some((selector) => {
          try {
            return node.matches(selector);
          } catch {
            return false;
          }
        })
      ) {
        return true;
      }

      const className = String(node.className || '').toLowerCase();
      return (
        className.includes('sidebar') ||
        className.includes('leftpane') ||
        className.includes('left-pane') ||
        className.includes('navigation')
      );
    }

    function pickRoot() {
      const exactRoot = document.querySelector('.navigation-controller-main.has-sidebar .folder-list-body');
      if (exactRoot && isVisible(exactRoot)) {
        return exactRoot;
      }

      const candidates = [];

      for (const selector of selectors.browseMainContainers) {
        for (const node of document.querySelectorAll(selector)) {
          if (!isVisible(node)) {
            continue;
          }

          if (isSidebarLike(node) || node.closest('nav, aside, [role="navigation"], [role="tree"]')) {
            continue;
          }

          const rect = node.getBoundingClientRect();
          const anchorCount = node.querySelectorAll('a[href]').length;
          const score =
            rect.width * rect.height +
            anchorCount * 1000 +
            rect.left * 5000 +
            rect.width * 100;
          candidates.push({ node, score });
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      return candidates[0] ? candidates[0].node : document.body;
    }

    function extractTitleFromRow(row, anchor) {
      const explicitTitle =
        normalizeWhitespace(anchor && anchor.getAttribute && anchor.getAttribute('aria-label')) ||
        normalizeWhitespace(anchor && anchor.getAttribute && anchor.getAttribute('title')) ||
        normalizeWhitespace(anchor && anchor.textContent) ||
        normalizeWhitespace(anchor && anchor.innerText);

      if (explicitTitle) {
        return explicitTitle;
      }

      const clone = row.cloneNode(true);
      for (const nested of clone.querySelectorAll('.folder-list-rows')) {
        nested.remove();
      }

      return normalizeWhitespace(clone.textContent) || 'Untitled';
    }

    function getNestedContainer(row) {
      const descendant = row.querySelector('.folder-list-rows');
      if (descendant) {
        return descendant;
      }

      const sibling = row.nextElementSibling;
      if (
        sibling &&
        sibling.matches &&
        selectors.nestedFolderContainers.some((selector) => sibling.matches(selector))
      ) {
        return sibling;
      }

      return null;
    }

    function buildFallbackDocumentKey(pathParts, title) {
      return `quip-fallback://${pathParts.join('/')}/${title}`;
    }

    function getRowExpandedState(row) {
      const expandedNode =
        row.querySelector('[aria-expanded]') ||
        row.querySelector('.list-item-row');

      if (!expandedNode) {
        return null;
      }

      const value = expandedNode.getAttribute('aria-expanded');
      return value === 'true' || value === 'false' ? value : null;
    }

    function visitNode(node, pathParts, folderItems, documentItems, seenFolders, seenDocuments) {
      if (!node || !isVisible(node)) {
        return;
      }

      if (node.matches && node.matches(selectors.rowSelector)) {
        const anchor = node.querySelector('a[href]');
        const href = anchor ? (anchor.href || anchor.getAttribute('href') || '') : '';
        const title = extractTitleFromRow(node, anchor);
        const normalizedUrl = href ? normalizeUrl(href) : '';
        const expandedState = getRowExpandedState(node);
        const nested = getNestedContainer(node);
        const folderLike = expandedState === 'true' || expandedState === 'false';

        if (folderLike) {
          const folderKey = `${pathParts.join('/')}/${title}`;
          if (!seenFolders.has(folderKey)) {
            seenFolders.add(folderKey);
            folderItems.push({
              url: normalizedUrl || `folder:${folderKey}`,
              title,
              pathParts: pathParts.slice(),
              expanded: expandedState === 'true' || Boolean(nested)
            });
          }

          if (nested) {
            visitNode(
              nested,
              pathParts.concat([title]),
              folderItems,
              documentItems,
              seenFolders,
              seenDocuments
            );
          }

          return;
        }

        if (!title) {
          return;
        }

        if (href && !isLikelyDocumentUrl(href)) {
          return;
        }

        const documentKey = normalizedUrl || buildFallbackDocumentKey(pathParts, title);
        if (!seenDocuments.has(documentKey)) {
          seenDocuments.add(documentKey);
          documentItems.push({
            url: documentKey,
            title,
            folderPathParts: pathParts.slice()
          });
        }
        return;
      }

      for (const child of Array.from(node.children || [])) {
        visitNode(child, pathParts, folderItems, documentItems, seenFolders, seenDocuments);
      }
    }

    const root = pickRoot();
    const folderItems = [];
    const documentItems = [];
    const seenFolders = new Set();
    const seenDocuments = new Set();
    visitNode(root, [], folderItems, documentItems, seenFolders, seenDocuments);

    return {
      folders: folderItems,
      documents: documentItems
    };
  }, {
    selectors: {
      browseMainContainers: SELECTORS.browseMainContainers,
      browseSidebarContainers: SELECTORS.browseSidebarContainers,
      folderLinks: SELECTORS.folderLinks,
      documentLinks: SELECTORS.documentLinks,
      rowSelector: SELECTORS.browseRows.join(','),
      nestedFolderContainers: SELECTORS.nestedFolderContainers
    },
    startUrl: START_URL
  });
}

async function openBrowseFolder(page, folderUrl) {
  const normalizedUrl = normalizeFolderUrl(folderUrl);
  await page.goto(normalizedUrl, {
    waitUntil: 'domcontentloaded',
    timeout: TIMINGS.navigationTimeoutMs
  });
  await page.waitForLoadState('domcontentloaded');

  try {
    await page.waitForLoadState('networkidle', { timeout: TIMINGS.folderContentsLoadMs });
  } catch {
    // Quip keeps long-lived sockets open; networkidle may never fire. Fall back
    // to the explicit workspace check below.
  }

  const ready = await waitForWorkspaceReady(page);
  if (!ready) {
    throw new Error(`Workspace did not finish loading at ${normalizedUrl}.`);
  }

  await page.waitForTimeout(TIMINGS.postNavigationPauseMs);
}

async function evaluateWithRetry(page, pageFunction, arg) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(pageFunction, arg);
    } catch (error) {
      lastError = error;
      const message = String(error && error.message || '');
      if (!/Execution context was destroyed|navigation|detached/i.test(message)) {
        throw error;
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(TIMINGS.postNavigationPauseMs);
    }
  }
  throw lastError;
}

async function markBrowseContentRoot(page) {
  return evaluateWithRetry(page, () => {
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

    for (const oldNode of document.querySelectorAll('[data-quip-export-root="true"]')) {
      oldNode.removeAttribute('data-quip-export-root');
    }

    const winner =
      document.querySelector('.navigation-controller-main.has-sidebar .folder-list-body') ||
      document.querySelector('.navigation-controller-main.has-sidebar .navigation-controller-body.scrollable') ||
      document.querySelector('.navigation-controller-main.has-sidebar') ||
      document.body;

    if (!isVisible(winner)) {
      return {
        tagName: winner.tagName,
        left: 0,
        top: 0,
        width: 0,
        height: 0
      };
    }

    winner.setAttribute('data-quip-export-root', 'true');

    const rect = winner.getBoundingClientRect();
    return {
      tagName: winner.tagName,
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  });
}

async function markNextCollapsedFolderToggle(page) {
  return page.evaluate(() => {
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

    function getRowTitle(row) {
      const anchor = row.querySelector('a[href], a[aria-label]');
      if (anchor) {
        const title =
          normalizeWhitespace(anchor.getAttribute('aria-label')) ||
          normalizeWhitespace(anchor.getAttribute('title')) ||
          normalizeWhitespace(anchor.textContent) ||
          normalizeWhitespace(anchor.innerText);
        if (title) {
          return title;
        }
      }

      const clone = row.cloneNode(true);
      for (const nested of clone.querySelectorAll('.folder-list-rows')) {
        nested.remove();
      }

      return normalizeWhitespace(clone.textContent) || 'Untitled Folder';
    }

    function getNestedContainer(row) {
      const descendant = row.querySelector('.folder-list-rows');
      if (descendant && isVisible(descendant)) {
        return descendant;
      }

      const sibling = row.nextElementSibling;
      if (
        sibling &&
        sibling.matches &&
        sibling.matches('.folder-list-rows') &&
        isVisible(sibling)
      ) {
        return sibling;
      }

      return null;
    }

    for (const oldNode of document.querySelectorAll('[data-quip-expand-target="true"]')) {
      oldNode.removeAttribute('data-quip-expand-target');
    }

    const root =
      document.querySelector('.navigation-controller-main.has-sidebar .folder-list-body') ||
      document.body;

    const rows = Array.from(root.querySelectorAll('.folder-list-row')).filter((row) => isVisible(row));

    for (const row of rows) {
      const expandedState =
        (row.querySelector('[aria-expanded]') || row.querySelector('.list-item-row'))
          ?.getAttribute('aria-expanded') || null;
      if (expandedState !== 'false') {
        continue;
      }

      const toggle = row.querySelector('.column-handle');
      if (!toggle || !isVisible(toggle)) {
        continue;
      }

      const isExpanded = Boolean(getNestedContainer(row));

      if (isExpanded) {
        continue;
      }

      toggle.setAttribute('data-quip-expand-target', 'true');
      return {
        found: true,
        title: getRowTitle(row)
      };
    }

    return { found: false, title: null };
  });
}

async function expandAllFoldersInCurrentTree(page) {
  let expandedCount = 0;
  let attempts = 0;

  while (true) {
    attempts += 1;
    if (attempts > TIMINGS.crawlLoopLimit) {
      throw new Error('Folder expansion exceeded the safety loop limit.');
    }

    const candidate = await markNextCollapsedFolderToggle(page);
    if (!candidate.found) {
      break;
    }

    log('INFO', `Expanding folder: ${candidate.title}`);
    await page.locator('[data-quip-expand-target="true"]').first().click({
      timeout: TIMINGS.menuWaitMs
    });
    expandedCount += 1;
    await page.waitForTimeout(TIMINGS.folderContentsLoadMs);
  }

  log('INFO', `Expanded ${expandedCount} folders in the right pane.`);
  return expandedCount;
}

async function markDocumentTargetInBrowsePage(page, doc) {
  return page.evaluate(({ startUrl, docUrl, docTitle, folderPathParts }) => {
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

    function getRowTitle(row) {
      const anchor = row.querySelector('a[href], a[aria-label]');
      if (anchor) {
        const title =
          normalizeWhitespace(anchor.getAttribute('aria-label')) ||
          normalizeWhitespace(anchor.getAttribute('title')) ||
          normalizeWhitespace(anchor.textContent) ||
          normalizeWhitespace(anchor.innerText);
        if (title) {
          return title;
        }
      }

      const clone = row.cloneNode(true);
      for (const nested of clone.querySelectorAll('.folder-list-rows')) {
        nested.remove();
      }

      return normalizeWhitespace(clone.textContent);
    }

    function normalizeUrl(rawUrl) {
      try {
        const url = new URL(rawUrl, startUrl);
        url.hash = '';
        url.search = '';
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
      } catch {
        return String(rawUrl || '').trim();
      }
    }

    for (const oldNode of document.querySelectorAll('[data-quip-export-target="true"]')) {
      oldNode.removeAttribute('data-quip-export-target');
    }

    const root =
      document.querySelector('.navigation-controller-main.has-sidebar .folder-list-body') ||
      document.querySelector('[data-quip-export-root="true"]') ||
      document.body;

    function getNestedContainer(row) {
      const descendant = row.querySelector('.folder-list-rows');
      if (descendant && isVisible(descendant)) {
        return descendant;
      }

      const sibling = row.nextElementSibling;
      if (sibling && sibling.matches && sibling.matches('.folder-list-rows') && isVisible(sibling)) {
        return sibling;
      }

      return null;
    }

    function visit(node, remainingPath) {
      if (!node || !isVisible(node)) {
        return null;
      }

      if (node.matches && node.matches('.folder-list-row')) {
        const rowTitle = getRowTitle(node);
        const expandedState =
          (node.querySelector('[aria-expanded]') || node.querySelector('.list-item-row'))
            ?.getAttribute('aria-expanded') || null;
        const nested = getNestedContainer(node);

        if (expandedState === 'true' || expandedState === 'false') {
          if (remainingPath.length && rowTitle.includes(remainingPath[0]) && nested) {
            const found = visit(nested, remainingPath.slice(1));
            if (found) {
              return found;
            }
          }
          return null;
        }

        if (!remainingPath.length) {
          const anchor = node.querySelector('a[href]');
          const href = anchor ? (anchor.href || anchor.getAttribute('href') || '') : '';

          if (href && normalizeUrl(href) === docUrl) {
            node.setAttribute('data-quip-export-target', 'true');
            return { found: true, strategy: 'path+url' };
          }

          if (rowTitle.toLowerCase().includes(normalizeWhitespace(docTitle).toLowerCase())) {
            node.setAttribute('data-quip-export-target', 'true');
            return { found: true, strategy: 'path+title' };
          }
        }

        return null;
      }

      for (const child of Array.from(node.children || [])) {
        const found = visit(child, remainingPath);
        if (found) {
          return found;
        }
      }

      return null;
    }

    const foundByPath = visit(root, Array.isArray(folderPathParts) ? folderPathParts : []);
    if (foundByPath) {
      return foundByPath;
    }

    const rows = Array.from(root.querySelectorAll('.folder-list-row')).filter((row) => isVisible(row));
    const wantedTitle = normalizeWhitespace(docTitle).toLowerCase();
    for (const row of rows) {
      if (
        (row.querySelector('[aria-expanded]') || row.querySelector('.list-item-row'))
          ?.hasAttribute('aria-expanded')
      ) {
        continue;
      }

      const text = getRowTitle(row).toLowerCase();
      if (text && text.includes(wantedTitle)) {
        row.setAttribute('data-quip-export-target', 'true');
        return { found: true, strategy: 'title-fallback' };
      }
    }

    return { found: false, strategy: 'none' };
  }, {
    startUrl: START_URL,
    docUrl: String(doc.url || '').startsWith('quip-fallback://')
      ? ''
      : normalizeDocUrl(doc.url),
    docTitle: doc.title || '',
    folderPathParts: doc.folderPathParts || []
  });
}

async function crawlWorkspaceDocuments(page) {
  await openBrowseFolder(page, BROWSE_URL);
  const rootInfo = await markBrowseContentRoot(page);
  log(
    'INFO',
    `Using browse pane at x=${rootInfo.left}, y=${rootInfo.top}, w=${rootInfo.width}, h=${rootInfo.height}`
  );

  const expandedCount = await expandAllFoldersInCurrentTree(page);

  const entries = await collectFolderPageEntries(page);
  const discoveredDocuments = new Map();

  for (const documentItem of entries.documents) {
    const normalizedDocUrl = String(documentItem.url || '').startsWith('quip-fallback://')
      ? documentItem.url
      : normalizeDocUrl(documentItem.url);

    if (!discoveredDocuments.has(normalizedDocUrl)) {
      discoveredDocuments.set(normalizedDocUrl, {
        url: normalizedDocUrl,
        title: documentItem.title || extractDocId(normalizedDocUrl),
        folderPathParts: documentItem.folderPathParts || [],
        folderUrl: normalizeFolderUrl(BROWSE_URL)
      });
    }
  }

  log(
    'INFO',
    `Folder crawl progress: ${expandedCount} folders expanded this run, ${entries.folders.length} folders discovered, ${discoveredDocuments.size} unique documents discovered.`
  );

  return {
    documents: Array.from(discoveredDocuments.values()),
    expandedFolderCount: expandedCount,
    discoveredFolderCount: entries.folders.length,
    discoveredDocumentCount: discoveredDocuments.size
  };
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

async function findVisibleContextMenuRow(page, labelPattern) {
  const rows = page.locator(SELECTORS.contextMenuRows.join(','));
  const count = await rows.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await safeIsVisible(row))) {
      continue;
    }

    const text = await row.textContent().catch(() => '');
    if (labelPattern.test(String(text || '').trim())) {
      return row;
    }
  }

  return null;
}

async function waitForContextMenu(page) {
  await page.waitForSelector(
    '.popover.spaceship-popover.visible .menu-row[data-item-id="export"], .popover.spaceship-popover.visible .parts-menu',
    {
      state: 'visible',
      timeout: TIMINGS.menuWaitMs
    }
  );
}

async function triggerHtmlExport(page) {
  let exportItem = page
    .locator('.popover.spaceship-popover.visible .menu-row[data-item-id="export"]')
    .first();

  if (!(await safeIsVisible(exportItem))) {
    exportItem = await findVisibleContextMenuRow(page, MENU_LABELS.export);
  }

  if (!exportItem || !(await safeIsVisible(exportItem))) {
    throw new Error('Could not find Export menu item.');
  }

  await exportItem.hover({ timeout: TIMINGS.menuWaitMs });
  await page.waitForTimeout(TIMINGS.postClickPauseMs);

  const ariaOwns = await exportItem.getAttribute('aria-owns').catch(() => null);
  if (ariaOwns) {
    await page.waitForSelector(`#${ariaOwns}`, {
      state: 'visible',
      timeout: TIMINGS.menuWaitMs
    }).catch(() => {});
  }

  let htmlItem = page
    .locator('.popover.spaceship-popover.visible .menu-row .parts-menu-label')
    .filter({ hasText: /^HTML$/ })
    .first();

  if (!(await safeIsVisible(htmlItem))) {
    const fallbackHtmlRow = await findVisibleContextMenuRow(page, MENU_LABELS.html);
    if (fallbackHtmlRow) {
      htmlItem = fallbackHtmlRow;
    }
  }

  if (!(await safeIsVisible(htmlItem))) {
    const genericHtml = await findMenuItem(page, MENU_LABELS.html);
    if (genericHtml) {
      htmlItem = genericHtml;
    }
  }

  if (!(await safeIsVisible(htmlItem))) {
    throw new Error('Could not find HTML export menu item.');
  }

  const downloadPromise = page.waitForEvent('download', {
    timeout: TIMINGS.downloadTimeoutMs
  });

  await htmlItem.click({ timeout: TIMINGS.menuWaitMs });
  return downloadPromise;
}

async function downloadExportFromBrowsePage(page, doc) {
  const normalizedUrl = String(doc.url || '').startsWith('quip-fallback://')
    ? doc.url
    : normalizeDocUrl(doc.url);

  const targetInfo = await markDocumentTargetInBrowsePage(page, doc);
  if (!targetInfo.found) {
    await openBrowseFolder(page, BROWSE_URL);
    await markBrowseContentRoot(page);
    await expandAllFoldersInCurrentTree(page);
  }

  const refreshedTargetInfo = targetInfo.found
    ? targetInfo
    : await markDocumentTargetInBrowsePage(page, doc);

  if (!refreshedTargetInfo.found) {
    throw new Error(`Could not locate file row in browse view for ${doc.title || normalizedUrl}`);
  }

  const target = page.locator('[data-quip-export-target="true"]').first();
  if (!(await safeIsVisible(target))) {
    throw new Error(`Located file row is not visible for ${doc.title || normalizedUrl}`);
  }

  await page.keyboard.press('Escape').catch(() => {});

  if (!page.__quipBrowsePaneActivated) {
    const activateBox = await target.boundingBox();
    const activatePosition = activateBox
      ? {
          x: Math.max(12, Math.min(40, Math.round(activateBox.width * 0.08))),
          y: Math.max(8, Math.round(activateBox.height / 2))
        }
      : undefined;

    log('INFO', 'Activating browse pane before first right-click.');
    await target.click({
      timeout: TIMINGS.menuWaitMs,
      position: activatePosition
    });
    await page.waitForTimeout(500);
    page.__quipBrowsePaneActivated = true;
  }

  log('INFO', `Right-clicking file row using ${refreshedTargetInfo.strategy} match: ${doc.title || normalizedUrl}`);
  const box = await target.boundingBox();
  const clickPositions = box
    ? [
        {
          x: Math.max(12, Math.min(40, Math.round(box.width * 0.08))),
          y: Math.max(8, Math.round(box.height / 2))
        },
        {
          x: Math.max(12, Math.min(28, Math.round(box.width * 0.05))),
          y: Math.max(8, Math.round(box.height / 2))
        }
      ]
    : [undefined];

  let menuOpened = false;
  let lastMenuError = null;

  for (const position of clickPositions) {
    try {
      await target.click({
        button: 'right',
        timeout: TIMINGS.menuWaitMs,
        position
      });
      await page.waitForTimeout(TIMINGS.postContextMenuPauseMs);
      await waitForContextMenu(page);
      menuOpened = true;
      break;
    } catch (error) {
      lastMenuError = error;
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }
  }

  if (!menuOpened) {
    throw new Error(
      `Right-click did not open the context menu for ${doc.title || normalizedUrl}: ${lastMenuError ? lastMenuError.message : 'unknown error'}`
    );
  }

  const resolvedTitle = doc.title || extractDocId(normalizedUrl);
  const downloadPromise = await triggerHtmlExport(page);
  const download = await downloadPromise;

  const failure = await download.failure();
  if (failure) {
    throw new Error(`Download failed before save: ${failure}`);
  }

  let suggestedName = 'document.html';
  try {
    suggestedName = download.suggestedFilename() || 'document.html';
  } catch {
    suggestedName = 'document.html';
  }
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

async function exportDocumentWithRetries(page, doc, state, progress) {
  const normalizedUrl = normalizeDocUrl(doc.url);
  const progressPrefix = progress
    ? `[${progress.current}/${progress.total}] `
    : '';

  if (isExportedAndPresent(state, normalizedUrl)) {
    const existing = state.exported[normalizedUrl];
    log('INFO', `${progressPrefix}Skip already exported: ${existing.title || doc.title || normalizedUrl}`);
    return { skipped: true, relativePath: existing.relativePath || existing.filename };
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      log(
        'INFO',
        `${progressPrefix}Exporting (${attempt}/${MAX_RETRIES}): ${doc.title || normalizedUrl}`
      );

      const result = await downloadExportFromBrowsePage(page, doc);
      state.exported[normalizedUrl] = {
        sourceUrl: normalizedUrl,
        title: result.title,
        relativePath: result.relativePath,
        folderPathParts: doc.folderPathParts || [],
        folderUrl: doc.folderUrl || null,
        exportedAt: new Date().toISOString()
      };
      delete state.failures[normalizedUrl];
      saveState(state);

      return { skipped: false, relativePath: result.relativePath };
    } catch (error) {
      log(
        'WARN',
        `${progressPrefix}Attempt ${attempt} failed for ${doc.title || normalizedUrl}: ${error.message}`
      );

      if (attempt === MAX_RETRIES) {
        state.failures[normalizedUrl] = {
          sourceUrl: normalizedUrl,
          title: doc.title || normalizedUrl,
          folderPathParts: doc.folderPathParts || [],
          folderUrl: doc.folderUrl || null,
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
    const crawlResult = await crawlWorkspaceDocuments(page);
    const documents = crawlResult.documents;

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
        folderPathParts: documentItem.folderPathParts || [],
        folderUrl: documentItem.folderUrl || BROWSE_URL
      });
    }

    log(
      'INFO',
      `Collected ${uniqueDocs.length} unique documents to process after discovering ${crawlResult.discoveredFolderCount} folders.`
    );

    let successCount = 0;
    let skippedCount = 0;
    let failureCount = 0;
    const totalDocs = uniqueDocs.length;

    for (const [index, doc] of uniqueDocs.entries()) {
      try {
        const result = await exportDocumentWithRetries(page, doc, state, {
          current: index + 1,
          total: totalDocs
        });
        if (result.skipped) {
          skippedCount += 1;
        } else {
          successCount += 1;
        }
      } catch (error) {
        failureCount += 1;
        log('ERROR', `[${index + 1}/${totalDocs}] Failed to export ${doc.title || doc.url}: ${error.message}`);
      }

      log(
        'INFO',
        `Progress: ${index + 1}/${totalDocs} processed. Success: ${successCount}, skipped: ${skippedCount}, failed: ${failureCount}.`
      );
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
