import { chromium } from 'playwright';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { isIP } from 'node:net';
import dns from 'node:dns/promises';

const CONTENT_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '.content',
  '.post',
  '#content',
  'body',
];

const STRIP_TAGS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'footer',
  'header',
  'aside',
  'svg',
  'dialog',
  'template',
];

const STRIP_SELECTORS = [
  '[role="navigation"]',
  '[role="banner"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-hidden="true"]',
  '[hidden]',
];

const BLOCKED_RESOURCE_TYPES = new Set(['font', 'media']);
const MIN_CONTENT_LENGTH = 200;
const IMAGE_PATH_FILTER = /favicon|\/icon|\/logo|sprite|\.ico/i;
const MIN_IMAGE_DIMENSION = 50;
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const MAX_CONCURRENCY =
  process.env.MAX_CONCURRENCY && Number(process.env.MAX_CONCURRENCY) > 0
    ? Number(process.env.MAX_CONCURRENCY)
    : 4;

let browser = null;
let launching = null;
let sharedContext = null;
let contextPromise = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (launching) return launching;
  launching = chromium
    .launch({ headless: true })
    .then((b) => {
      browser = b;
      b.on('disconnected', () => {
        if (browser === b) browser = null;
        sharedContext = null;
      });
      launching = null;
      return b;
    })
    .catch((err) => {
      launching = null;
      throw err;
    });
  return launching;
}

async function getContext() {
  if (sharedContext) return sharedContext;
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const b = await getBrowser();
    const ctx = await b.newContext();
    await ctx.route('**/*', (route) => {
      if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
        return route.abort();
      }
      return route.continue();
    });
    ctx.on('close', () => {
      if (sharedContext === ctx) sharedContext = null;
    });
    sharedContext = ctx;
    contextPromise = null;
    return ctx;
  })().catch((err) => {
    contextPromise = null;
    throw err;
  });
  return contextPromise;
}

export async function closeBrowser() {
  const b = browser;
  const ctx = sharedContext;
  browser = null;
  sharedContext = null;
  if (ctx) await ctx.close().catch(() => {});
  if (b) await b.close().catch(() => {});
}

function createSemaphore(max) {
  let active = 0;
  const queue = [];
  return async function run(fn) {
    if (active >= max) {
      await new Promise((resolve) => queue.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

const semaphore = createSemaphore(MAX_CONCURRENCY);

function blockedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isPrivateV4(ip) {
  const parts = ip.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isPrivateV4(v4Mapped[1]);
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true;
  return false;
}

async function assertPublicHost(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw blockedError('Invalid URL', 'INVALID_URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw blockedError(
      `Protocol not allowed: ${parsed.protocol}`,
      'PROTOCOL_NOT_ALLOWED',
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(host);
  if (literalFamily === 4) {
    if (isPrivateV4(host)) {
      throw blockedError(`Address blocked: ${host}`, 'BLOCKED_ADDRESS');
    }
    return;
  }
  if (literalFamily === 6) {
    if (isPrivateV6(host)) {
      throw blockedError(`Address blocked: ${host}`, 'BLOCKED_ADDRESS');
    }
    return;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (err) {
    throw blockedError(`DNS lookup failed: ${err.message}`, 'BLOCKED_ADDRESS');
  }
  for (const { address, family } of addrs) {
    const blocked =
      family === 4 ? isPrivateV4(address) : isPrivateV6(address);
    if (blocked) {
      throw blockedError(
        `Address blocked: ${host} → ${address}`,
        'BLOCKED_ADDRESS',
      );
    }
  }
}

function buildTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  td.use(gfm);
  return td;
}

const turndown = buildTurndown();

function postProcess(markdown) {
  return markdown
    .replace(/\[(!\[[^\]]*\]\([^)]*\))\]\([^)]*\)/g, '$1')
    .replace(/!\[.*?\]\(data:.*?\)/g, '')
    .split('\n')
    .filter((line) => !/^\s*[-*]\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(markdown) {
  return markdown.split(/\s+/).filter(Boolean).length;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function normalizeWhitespace(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
}

function parseAttributes(source) {
  const attrs = {};
  const attrRegex =
    /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRegex.exec(source))) {
    const [, rawName, v1, v2, v3] = match;
    attrs[rawName.toLowerCase()] = v1 ?? v2 ?? v3 ?? '';
  }
  return attrs;
}

function createElementNode(tagName, attributes = {}) {
  return {
    type: 'element',
    tagName,
    attributes: { ...attributes },
    children: [],
    parent: null,
  };
}

function createTextNode(text) {
  return {
    type: 'text',
    text,
    parent: null,
  };
}

function appendChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
}

function parseHtml(html) {
  const root = createElementNode('#document');
  const stack = [root];
  const tagRegex = /<!--[\s\S]*?-->|<\/?([A-Za-z0-9:-]+)([^>]*?)\/?>/g;
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(html))) {
    const [raw, rawTagName = '', attrSource = ''] = match;
    if (match.index > lastIndex) {
      appendChild(
        stack[stack.length - 1],
        createTextNode(html.slice(lastIndex, match.index)),
      );
    }

    lastIndex = tagRegex.lastIndex;

    if (raw.startsWith('<!--')) continue;

    const isClosing = raw.startsWith('</');
    const tagName = rawTagName.toLowerCase();

    if (isClosing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const node = createElementNode(tagName, parseAttributes(attrSource));
    appendChild(stack[stack.length - 1], node);

    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(tagName);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  if (lastIndex < html.length) {
    appendChild(stack[stack.length - 1], createTextNode(html.slice(lastIndex)));
  }

  return root;
}

function getAttribute(node, name) {
  if (!node || node.type !== 'element') return null;
  const value = node.attributes[name.toLowerCase()];
  return value == null ? null : value;
}

function hasClass(node, className) {
  const raw = getAttribute(node, 'class');
  if (!raw) return false;
  return raw.split(/\s+/).includes(className);
}

function matchesSelector(node, selector) {
  if (!node || node.type !== 'element') return false;

  if (/^[a-z][a-z0-9:-]*$/i.test(selector)) {
    return node.tagName === selector.toLowerCase();
  }

  if (selector.startsWith('.')) {
    return hasClass(node, selector.slice(1));
  }

  if (selector.startsWith('#')) {
    return getAttribute(node, 'id') === selector.slice(1);
  }

  const attrMatch = selector.match(
    /^\[([^\]=~*^$]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/,
  );
  if (attrMatch) {
    const [, rawName, v1, v2, v3] = attrMatch;
    const name = rawName.toLowerCase();
    const value = getAttribute(node, name);
    if (v1 == null && v2 == null && v3 == null) {
      return value != null;
    }
    const expected = (v1 ?? v2 ?? v3 ?? '').trim();
    return value === expected;
  }

  const compoundMatch = selector.match(
    /^([a-z][a-z0-9:-]*)\[([^\]=~*^$]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]$/i,
  );
  if (compoundMatch) {
    const [, tagName, rawName, v1, v2, v3] = compoundMatch;
    if (node.tagName !== tagName.toLowerCase()) return false;
    const value = getAttribute(node, rawName.toLowerCase());
    if (v1 == null && v2 == null && v3 == null) {
      return value != null;
    }
    const expected = (v1 ?? v2 ?? v3 ?? '').trim();
    return value === expected;
  }

  return false;
}

function findFirst(node, selector) {
  if (!node || node.type !== 'element') return null;
  if (matchesSelector(node, selector)) return node;
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    const found = findFirst(child, selector);
    if (found) return found;
  }
  return null;
}

function findAll(node, selector, results = []) {
  if (!node || node.type !== 'element') return results;
  if (matchesSelector(node, selector)) results.push(node);
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    findAll(child, selector, results);
  }
  return results;
}

function getTextContent(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  return node.children.map(getTextContent).join('');
}

function serializeNode(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  if (node.tagName === '#document') {
    return node.children.map(serializeNode).join('');
  }

  const attrs = Object.entries(node.attributes)
    .map(([name, value]) =>
      value === '' ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`,
    )
    .join('');

  if (VOID_TAGS.has(node.tagName)) {
    return `<${node.tagName}${attrs}>`;
  }

  return `<${node.tagName}${attrs}>${node.children
    .map(serializeNode)
    .join('')}</${node.tagName}>`;
}

function serializeInnerHtml(node) {
  if (!node || node.type !== 'element') return '';
  return node.children.map(serializeNode).join('');
}

function cloneNode(node) {
  if (node.type === 'text') {
    return createTextNode(node.text);
  }
  const copy = createElementNode(node.tagName, node.attributes);
  for (const child of node.children) {
    appendChild(copy, cloneNode(child));
  }
  return copy;
}

function removeMatching(node, selectors) {
  if (!node || node.type !== 'element') return;
  node.children = node.children.filter((child) => {
    if (child.type !== 'element') return true;
    if (selectors.some((selector) => matchesSelector(child, selector))) {
      return false;
    }
    removeMatching(child, selectors);
    return true;
  });
  for (const child of node.children) {
    child.parent = node;
  }
}

function isVisuallyHidden(node) {
  const style = (getAttribute(node, 'style') || '').toLowerCase();
  if (!style) return false;
  return (
    style.includes('display:none') ||
    style.includes('display: none') ||
    style.includes('visibility:hidden') ||
    style.includes('visibility: hidden') ||
    style.includes('opacity:0') ||
    style.includes('opacity: 0')
  );
}

function stripHiddenNodes(node) {
  if (!node || node.type !== 'element') return;
  node.children = node.children.filter((child) => {
    if (child.type !== 'element') return true;
    if (isVisuallyHidden(child)) {
      return false;
    }
    stripHiddenNodes(child);
    return true;
  });
  for (const child of node.children) {
    child.parent = node;
  }
}

function absolutizeUrl(raw, baseUrl) {
  if (!raw) return null;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

function parseDimension(value) {
  if (!value) return null;
  const match = String(value).match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLinksAndImages(node, baseUrl) {
  if (!node || node.type !== 'element') return;
  if (node.tagName === 'img') {
    const absSrc = absolutizeUrl(getAttribute(node, 'src'), baseUrl);
    if (absSrc && !absSrc.startsWith('data:')) {
      node.attributes.src = absSrc;
    }
  }
  if (node.tagName === 'a') {
    const absHref = absolutizeUrl(getAttribute(node, 'href'), baseUrl);
    if (absHref) {
      node.attributes.href = absHref;
    }
  }
  for (const child of node.children) {
    normalizeLinksAndImages(child, baseUrl);
  }
}

function selectContentNode(root, minLength) {
  for (const selector of CONTENT_SELECTORS) {
    const candidate = findFirst(root, selector);
    if (!candidate) continue;
    const textLength = normalizeWhitespace(getTextContent(candidate)).length;
    if (textLength >= minLength || selector === 'body') {
      return candidate;
    }
  }
  return findFirst(root, 'body') || root;
}

function extractMetaImageFromTree(root, baseUrl) {
  for (const selector of [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
  ]) {
    const node = findFirst(root, selector);
    const content = getAttribute(node, 'content');
    const abs = absolutizeUrl(content, baseUrl);
    if (abs) return abs;
  }
  return null;
}

function extractBodyImagesFromTree(node, baseUrl) {
  const images = [];
  for (const img of findAll(node, 'img')) {
    const src = absolutizeUrl(getAttribute(img, 'src'), baseUrl);
    if (!src || src.startsWith('data:') || IMAGE_PATH_FILTER.test(src)) {
      continue;
    }

    const width = parseDimension(getAttribute(img, 'width'));
    const height = parseDimension(getAttribute(img, 'height'));
    if (
      width != null &&
      height != null &&
      (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION)
    ) {
      continue;
    }

    images.push({
      src,
      alt: normalizeWhitespace(getAttribute(img, 'alt') || ''),
      width,
      height,
    });
  }
  return dedupeImages(images);
}

function dedupeImages(images) {
  const seen = new Set();
  return images.filter((image) => {
    const key = `${image.src}|${image.alt}|${image.width}|${image.height}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function finalizeResult({ title, url, html, contentLength, images, metaImage }) {
  const rawMarkdown = turndown.turndown(html || '');
  const markdown = postProcess(rawMarkdown);
  return {
    title: title || '',
    url,
    markdown,
    images: images || [],
    metaImage: metaImage || null,
    crawledAt: new Date().toISOString(),
    wordCount: countWords(markdown),
    contentLength:
      contentLength != null ? contentLength : normalizeWhitespace(markdown).length,
  };
}

function toPublicResult(result) {
  const { contentLength: _contentLength, ...publicResult } = result;
  return publicResult;
}

async function fetchStaticPage(url, timeout) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
    headers: {
      'user-agent': 'obnofi-crawler/1.0',
      accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    throw new Error(`Fetch failed with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (
    contentType &&
    !/text\/html|application\/xhtml\+xml/i.test(contentType)
  ) {
    throw new Error(`Unsupported content-type: ${contentType}`);
  }

  const html = await response.text();
  return extractStaticContent(html, response.url || url);
}

function extractStaticContent(html, baseUrl) {
  const root = parseHtml(html);
  const contentNode = selectContentNode(root, MIN_CONTENT_LENGTH);
  const workingNode = cloneNode(contentNode);

  normalizeLinksAndImages(workingNode, baseUrl);
  stripHiddenNodes(workingNode);
  removeMatching(workingNode, STRIP_TAGS);
  removeMatching(workingNode, STRIP_SELECTORS);

  const textContent = normalizeWhitespace(getTextContent(workingNode));
  const titleNode = findFirst(root, 'title');
  const title = normalizeWhitespace(getTextContent(titleNode));
  const images = extractBodyImagesFromTree(workingNode, baseUrl);
  const metaImage = extractMetaImageFromTree(root, baseUrl);

  return finalizeResult({
    title,
    url: baseUrl,
    html: serializeInnerHtml(workingNode),
    contentLength: textContent.length,
    images,
    metaImage,
  });
}

async function crawlWithPlaywright(url, options) {
  const {
    timeout = 15000,
    waitFor = 'domcontentloaded',
    spa = false,
  } = options;

  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: waitFor, timeout });

    if (waitFor !== 'networkidle') {
      const idleTimeout = spa ? timeout : Math.min(timeout, 500);
      await page
        .waitForLoadState('networkidle', { timeout: idleTimeout })
        .catch(() => {});
    }

    const extracted = await page.evaluate(
      (args) => {
        const {
          selectors,
          stripTags,
          stripSelectors,
          minLength,
          imagePathFilterSource,
          minImageDimension,
        } = args;

        let target = null;
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const textLength = (el.textContent || '').trim().length;
          if (textLength >= minLength || selector === 'body') {
            target = el;
            break;
          }
        }
        if (!target) target = document.body;

        target.querySelectorAll('img').forEach((img) => {
          const abs = img.src;
          if (abs && !abs.startsWith('data:')) img.setAttribute('src', abs);
        });
        target.querySelectorAll('a[href]').forEach((a) => {
          const abs = a.href;
          if (abs) a.setAttribute('href', abs);
        });

        const bodyImages = [];
        const imageFilter = new RegExp(imagePathFilterSource, 'i');
        for (const img of target.querySelectorAll('img')) {
          const src = img.src;
          if (!src || src.startsWith('data:') || imageFilter.test(src)) {
            continue;
          }
          const width = Number.isFinite(img.naturalWidth) ? img.naturalWidth : 0;
          const height = Number.isFinite(img.naturalHeight)
            ? img.naturalHeight
            : 0;
          if (width < minImageDimension || height < minImageDimension) {
            continue;
          }
          bodyImages.push({
            src,
            alt: (img.getAttribute('alt') || '').trim(),
            width: width || null,
            height: height || null,
          });
        }

        const metaImage =
          document.querySelector('meta[property="og:image"]')?.content ||
          document.querySelector('meta[name="og:image"]')?.content ||
          document.querySelector('meta[property="twitter:image"]')?.content ||
          document.querySelector('meta[name="twitter:image"]')?.content ||
          null;

        const SKIP_ATTR = 'data-obnofi-skip';
        const marked = [];
        const visit = (el) => {
          const style = window.getComputedStyle(el);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
          ) {
            el.setAttribute(SKIP_ATTR, '1');
            marked.push(el);
            return;
          }
          const children = el.children;
          for (let i = 0; i < children.length; i++) visit(children[i]);
        };
        visit(target);

        const clone = target.cloneNode(true);
        try {
          for (const tag of stripTags) {
            clone.querySelectorAll(tag).forEach((node) => node.remove());
          }
          for (const sel of stripSelectors) {
            clone.querySelectorAll(sel).forEach((node) => node.remove());
          }
          clone
            .querySelectorAll(`[${SKIP_ATTR}]`)
            .forEach((node) => node.remove());
        } finally {
          for (const el of marked) el.removeAttribute(SKIP_ATTR);
        }

        const seen = new Set();
        const images = bodyImages.filter((image) => {
          const key = `${image.src}|${image.alt}|${image.width}|${image.height}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        return {
          title: document.title || '',
          html: clone.innerHTML,
          contentLength: (clone.textContent || '').trim().length,
          images,
          metaImage: metaImage
            ? new URL(metaImage, document.baseURI).href
            : null,
        };
      },
      {
        selectors: CONTENT_SELECTORS,
        stripTags: STRIP_TAGS,
        stripSelectors: STRIP_SELECTORS,
        minLength: MIN_CONTENT_LENGTH,
        imagePathFilterSource: IMAGE_PATH_FILTER.source,
        minImageDimension: MIN_IMAGE_DIMENSION,
      },
    );

    return finalizeResult({
      title: extracted.title,
      url,
      html: extracted.html,
      contentLength: extracted.contentLength,
      images: extracted.images,
      metaImage: extracted.metaImage,
    });
  } finally {
    await page.close().catch(() => {});
  }
}

export async function prewarm() {
  await getContext();
}

export async function crawl(url, options = {}) {
  return semaphore(() => crawlImpl(url, options));
}

async function crawlImpl(url, options) {
  const {
    spa = false,
    timeout = 15000,
  } = options;

  await assertPublicHost(url);

  if (!spa) {
    try {
      const fetched = await fetchStaticPage(url, timeout);
      if (fetched.contentLength >= MIN_CONTENT_LENGTH) {
        return toPublicResult(fetched);
      }
    } catch {}
  }

  const rendered = await crawlWithPlaywright(url, options);
  return toPublicResult(rendered);
}
