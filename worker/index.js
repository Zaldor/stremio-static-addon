import { load as loadHtml } from 'cheerio';
import { assertPublicHttps, decodeBase64Url, decodeConfig, encodeBase64Url, sanitizeConfig } from './config.js';
import { analyzeHtml, extractMediaUrl, inspectDetailMedia } from './analyzer.js';
import { askGeminiForSelectors, mapGeminiSuggestions, redactHtmlForGemini } from './gemini.js';
import INLINE_ASSETS from './inline-assets.js';

const MAX_HTML_BYTES = 8_000_000;
const HTML_TOO_LARGE_MESSAGE = 'The source page exceeds the 8 MB processing limit. Try a lighter listing page with fewer embedded scripts or videos.';
const MAX_ITEMS = 100;
const PAGE_CACHE_MS = 30_000;
const pageCache = new Map();
const analysisRequests = new Map();
const renderedRequests = new Map();
const geminiRequests = new Map();

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store'
};

function response(body, status = 200, contentType = 'application/json; charset=utf-8', method = 'GET') {
  const headers = new Headers(corsHeaders);
  headers.set('Content-Type', contentType);
  return new Response(method === 'HEAD' ? null : body, { status, headers });
}

function json(value, status = 200, method = 'GET') {
  return response(JSON.stringify(value), status, 'application/json; charset=utf-8', method);
}

function errorJson(error, status = 400, method = 'GET') {
  return json({ error: error instanceof Error ? error.message : 'Request failed.' }, status, method);
}

function publicUrl(value, base, label) {
  let url;
  try {
    url = base ? new URL(value, base) : new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL.`);
  }
  return assertPublicHttps(url.href, label).href;
}

async function readLimitedBody(responseBody, limit = MAX_HTML_BYTES, tooLargeMessage = HTML_TOO_LARGE_MESSAGE) {
  if (!responseBody) return '';
  const reader = responseBody.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(tooLargeMessage);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

async function fetchHtml(inputUrl) {
  let url = publicUrl(inputUrl, undefined, 'Source URL');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2' }
      });
      if (result.status >= 300 && result.status < 400) {
        const location = result.headers.get('Location');
        if (!location) throw new Error('The source redirected without a destination.');
        url = publicUrl(location, url, 'Redirect URL');
        continue;
      }
      if (!result.ok) throw new Error(`The source returned HTTP ${result.status}.`);
      const declaredLength = Number(result.headers.get('Content-Length') || 0);
      if (declaredLength > MAX_HTML_BYTES) throw new Error(HTML_TOO_LARGE_MESSAGE);
      const html = await readLimitedBody(result.body);
      return { html, url };
    }
    throw new Error('The source redirected too many times.');
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The source page took too long to respond.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function select(scope, selector) {
  if (!selector) return null;
  const found = scope.find(selector).first();
  if (found.length) return found;
  if (typeof scope.is === 'function' && scope.is(selector)) return scope;
  return found;
}

function readField(scope, selector, attribute, baseUrl, valueIsUrl = false) {
  if (!selector) return '';
  const match = select(scope, selector);
  if (!match || !match.length) return '';
  const value = attribute === 'text' ? match.text() : match.attr(attribute);
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  if (!valueIsUrl) return trimmed.slice(0, 1000);
  try {
    return publicUrl(trimmed, baseUrl, 'Extracted media URL');
  } catch {
    return '';
  }
}

function requestKey(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

function allowRequest(map, request, intervalMs, maxEntries = 1200) {
  const now = Date.now();
  const key = requestKey(request);
  const previous = map.get(key) || 0;
  if (now - previous < intervalMs) return false;
  map.set(key, now);
  if (map.size > maxEntries) {
    for (const [entryKey, timestamp] of map) {
      if (now - timestamp > 60_000) map.delete(entryKey);
      if (map.size <= maxEntries) break;
    }
  }
  return true;
}

function parseMetaFields(scope, fields, baseUrl) {
  const values = {};
  for (const field of fields || []) {
    const isUrl = field.key === 'website' || field.key === 'background' || field.key === 'logo';
    let value = readField(scope, field.selector, field.attribute, baseUrl, isUrl);
    if (!value) continue;
    if (['genres', 'cast', 'director'].includes(field.key)) {
      value = value.split(/[,;|]/).map(part => part.trim()).filter(Boolean).slice(0, 30);
      if (!value.length) continue;
    } else if (field.key === 'imdbRating') {
      const rating = Number.parseFloat(value);
      if (!Number.isFinite(rating)) continue;
      value = Math.max(0, Math.min(10, rating));
    }
    values[field.key] = value;
  }
  return values;
}

function makeMeta(source, scope, baseUrl, stableKey) {
  const name = readField(scope, source.titleSelector, source.titleAttribute, baseUrl).slice(0, 180);
  if (!name) return null;
  const meta = { id: '', type: 'movie', name };
  const description = readField(scope, source.descriptionSelector, source.descriptionAttribute, baseUrl);
  const poster = readField(scope, source.posterSelector, source.posterAttribute, baseUrl, true);
  if (description) meta.description = description.slice(0, 700);
  if (poster) meta.poster = poster;
  Object.assign(meta, parseMetaFields(scope, source.metaFields, baseUrl));
  const idPayload = { sourceId: source.id, key: stableKey };
  meta.id = `memory_${encodeBase64Url(idPayload)}`;
  return meta;
}

function cacheKey(source) {
  return JSON.stringify(source);
}

async function getSourceItems(source, force = false) {
  const key = cacheKey(source);
  const cached = pageCache.get(key);
  if (!force && cached && Date.now() - cached.createdAt < PAGE_CACHE_MS) return cached.items;

  const { html, url } = await fetchHtml(source.pageUrl);
  const $ = loadHtml(html);
  let cards;
  try {
    cards = $(source.itemSelector);
  } catch {
    throw new Error(`Invalid item selector for "${source.name}".`);
  }
  const items = [];
  cards.each((index, element) => {
    if (items.length >= MAX_ITEMS) return;
    const card = $(element);
    const detailUrl = source.detailLinkSelector
      ? readField(card, source.detailLinkSelector, source.detailLinkAttribute, url, true)
      : '';
    const directStreamUrl = source.streamFromDetail
      ? ''
      : extractMediaUrl($, element, url, source.streamSelector, source.streamAttribute);
    const stableKey = source.streamFromDetail ? detailUrl : directStreamUrl;
    if (!stableKey) return;
    const meta = makeMeta(source, card, url, stableKey);
    if (!meta) return;
    items.push({ meta, detailUrl, directStreamUrl, stableKey, index });
  });
  const entry = { createdAt: Date.now(), items };
  pageCache.set(key, entry);
  if (pageCache.size > 60) pageCache.delete(pageCache.keys().next().value);
  return items;
}

function makeManifest(config) {
  return {
    id: 'org.juzemaru.stremio-memory-archive',
    version: '1.0.0',
    name: 'JuzeReel',
    description: 'A personal video memory catalog from your own web pages.',
    types: ['movie'],
    behaviorHints: { configurable: true },
    catalogs: config.sources.map(source => ({
      type: 'movie',
      id: source.id,
      name: source.name,
      extra: [
        { name: 'search', isRequired: false },
        { name: 'skip', isRequired: false }
      ]
    })),
    resources: [
      { name: 'catalog', types: ['movie'] },
      { name: 'meta', types: ['movie'], idPrefixes: ['memory_'] },
      { name: 'stream', types: ['movie'], idPrefixes: ['memory_'] }
    ]
  };
}

function readItemKey(id) {
  if (!id.startsWith('memory_')) throw new Error('Unknown item ID.');
  const payload = decodeBase64Url(id.slice('memory_'.length));
  if (!payload || typeof payload.sourceId !== 'string' || typeof payload.key !== 'string') {
    throw new Error('Unknown item ID.');
  }
  return payload;
}

function decodeExtra(segments, url) {
  const extra = {};
  const raw = segments.join('/').replace(/\.json$/, '');
  for (const part of raw.split('&')) {
    if (!part) continue;
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    const key = decodeURIComponent(part.slice(0, equals));
    const value = decodeURIComponent(part.slice(equals + 1));
    extra[key] = value;
  }
  for (const [key, value] of url.searchParams) extra[key] = value;
  return extra;
}

function parseStreamFromDetail(source, detailUrl) {
  return fetchHtml(detailUrl).then(({ html, url }) => {
    let $;
    try {
      $ = loadHtml(html);
      const value = extractMediaUrl($, $.root(), url, source.streamSelector, source.streamAttribute);
      if (!value) throw new Error(`No video URL matched the selector for "${source.name}".`);
      return value;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('No video URL')) throw error;
      throw new Error(`Invalid video URL selector for "${source.name}".`);
    }
  });
}

async function fetchRenderedHtml(env, inputUrl) {
  const url = publicUrl(inputUrl, undefined, 'Source URL');
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== 'function') {
    throw new Error('Rendered-page analysis is not enabled on this deployment. Try the regular analysis or use static HTML selectors.');
  }
  const result = await env.BROWSER.quickAction('content', {
    url,
    gotoOptions: { waitUntil: 'networkidle2' }
  });
  if (!result || typeof result.text !== 'function') throw new Error('The rendered page service returned an unexpected response.');
  if (!result.ok) throw new Error(`Rendered page request returned HTTP ${result.status}.`);
  const html = await readLimitedBody(result.body);
  const finalUrl = publicUrl(result.url || url, url, 'Rendered page URL');
  return { html, url: finalUrl };
}

async function analyzePage(env, body) {
  if (!body || typeof body.pageUrl !== 'string' || !body.pageUrl.trim()) throw new Error('Enter a page URL to analyze.');
  const rendered = body.rendered === true;
  const page = rendered ? await fetchRenderedHtml(env, body.pageUrl.trim()) : await fetchHtml(body.pageUrl.trim());
  const result = analyzeHtml(page.html, page.url);
  result.rendered = rendered;

  let detailPagesRemaining = 2;
  for (const candidate of result.candidates) {
    if (!detailPagesRemaining) break;
    if (!candidate.suggestions.streamFromDetail) continue;
    const origin = new URL(page.url).origin;
    const detailUrls = [...new Set(candidate.sample.map(item => item.detailUrl).filter(Boolean))]
      .filter(value => {
        try { return new URL(value).origin === origin; } catch { return false; }
      })
      .slice(0, detailPagesRemaining);
    let learnedMedia = false;
    for (const detailUrl of detailUrls) {
      detailPagesRemaining -= 1;
      candidate.diagnostics.detailPagesTested += 1;
      try {
        const detail = rendered
          ? await fetchRenderedHtml(env, detailUrl)
          : await fetchHtml(detailUrl);
        if (new URL(detail.url).origin !== origin) continue;
        const media = inspectDetailMedia(detail.html, detail.url);
        if (!media) continue;
        candidate.diagnostics.detailPagesWithMedia += 1;
        const sample = candidate.sample.find(item => item.detailUrl === detailUrl);
        if (sample) sample.mediaUrl = media.url;
        if (!learnedMedia) {
          learnedMedia = true;
          if (media.selector) {
            candidate.suggestions.streamSelector = media.selector;
            candidate.suggestions.streamAttribute = media.attribute || 'src';
          }
          candidate.mediaDiscovery = media.kind === 'structured' ? 'structured data' : 'video markup';
        }
      } catch {
        // A sample detail page can be unavailable independently of its listing page.
      }
    }
    if (learnedMedia) candidate.confidence = Math.min(0.92, Number((candidate.confidence + 0.20).toFixed(2)));
  }
  return result;
}

function analyzeGeminiCandidate(html, pageUrl, suggestions) {
  const $ = loadHtml(html);
  for (const selector of Object.values(suggestions).filter(value => typeof value === 'string' && value)) {
    try { $.root().find(selector); }
    catch { throw new Error('Gemini returned invalid CSS selector syntax. Review the suggestions or try the regular analyzer.'); }
  }
  let cards;
  try { cards = $(suggestions.itemSelector).toArray().slice(0, 100); }
  catch { throw new Error('Gemini returned invalid CSS selector syntax. Review the suggestions or try the regular analyzer.'); }
  if (!cards.length) throw new Error('Gemini selectors did not match any video items on the original page. Review them or try the regular analyzer.');
  const samples = cards.slice(0, 5).map(card => {
    const scope = $(card);
    const title = readField(scope, suggestions.titleSelector, suggestions.titleAttribute, pageUrl);
    const description = readField(scope, suggestions.descriptionSelector, suggestions.descriptionAttribute, pageUrl);
    const rawPoster = readField(scope, suggestions.posterSelector, suggestions.posterAttribute, pageUrl);
    let posterUrl = '';
    try { if (rawPoster) posterUrl = publicUrl(rawPoster, pageUrl, 'Poster URL'); } catch {}
    let detailUrl = '';
    try { if (suggestions.detailLinkSelector) detailUrl = readField(scope, suggestions.detailLinkSelector, suggestions.detailLinkAttribute, pageUrl, true); } catch {}
    let mediaUrl = '';
    if (!suggestions.streamFromDetail) {
      try { mediaUrl = extractMediaUrl($, card, pageUrl, suggestions.streamSelector, suggestions.streamAttribute); } catch {}
    }
    return { title, description, posterUrl, detailUrl, mediaUrl };
  });
  const titleMatches = samples.filter(item => item.title).length;
  if (!titleMatches) throw new Error('Gemini selectors matched items but found no titles on the original page. Review them or try the regular analyzer.');
  const detailLinks = samples.filter(item => item.detailUrl).length;
  const directMedia = samples.filter(item => item.mediaUrl).length;
  const streamFromDetail = Boolean(suggestions.detailLinkSelector && detailLinks >= Math.ceil(samples.length * 0.5) &&
    (suggestions.streamFromDetail || directMedia < Math.ceil(samples.length * 0.5)));
  if (streamFromDetail) suggestions.streamFromDetail = true;
  else suggestions.streamFromDetail = false;
  if (!directMedia && !suggestions.streamFromDetail) throw new Error('The suggested selectors found no video URL or detail page link in the original page. Review them or try the regular analyzer.');
  const confidence = Math.min(0.95, 0.45 + 0.25 * titleMatches / samples.length +
    0.2 * Math.max(directMedia, detailLinks) / samples.length +
    0.1 * Math.min(cards.length, 10) / 10);
  return {
    confidence: Number(confidence.toFixed(2)),
    suggestions,
    diagnostics: {
      matchedCards: cards.length,
      sampledCards: samples.length,
      titleMatches,
      detailLinks,
      posters: samples.filter(item => item.posterUrl).length,
      descriptions: samples.filter(item => item.description).length,
      directMedia,
      semanticHint: true,
      detailPagesTested: 0,
      detailPagesWithMedia: 0
    },
    sample: samples.map(({ title, detailUrl, posterUrl, mediaUrl }) => ({ title, detailUrl, posterUrl, mediaUrl }))
  };
}

async function analyzeWithGemini(env, body) {
  if (!body || typeof body.pageUrl !== 'string' || !body.pageUrl.trim()) throw new Error('Enter a page URL to analyze.');
  if (typeof body.apiKey !== 'string' || body.apiKey.trim().length < 20 || body.apiKey.trim().length > 512) {
    throw new Error('Enter a valid Gemini API key. The key is used for this request and is not saved.');
  }
  const rendered = body.rendered === true;
  const page = rendered ? await fetchRenderedHtml(env, body.pageUrl.trim()) : await fetchHtml(body.pageUrl.trim());
  const redacted = redactHtmlForGemini(page.html);
  const geminiResult = await askGeminiForSelectors(body.apiKey.trim(), redacted.markup);
  const suggestions = mapGeminiSuggestions(geminiResult.selectors, redacted);
  const candidate = analyzeGeminiCandidate(page.html, page.url, suggestions);

  if (candidate.suggestions.streamFromDetail) {
    const origin = new URL(page.url).origin;
    const detailUrls = [...new Set(candidate.sample.map(item => item.detailUrl).filter(Boolean))]
      .filter(value => { try { return new URL(value).origin === origin; } catch { return false; } })
      .slice(0, 2);
    let learnedMedia = false;
    for (const detailUrl of detailUrls) {
      candidate.diagnostics.detailPagesTested += 1;
      try {
        const detail = rendered ? await fetchRenderedHtml(env, detailUrl) : await fetchHtml(detailUrl);
        if (new URL(detail.url).origin !== origin) continue;
        const media = inspectDetailMedia(detail.html, detail.url);
        if (!media) continue;
        candidate.diagnostics.detailPagesWithMedia += 1;
        const sample = candidate.sample.find(item => item.detailUrl === detailUrl);
        if (sample) sample.mediaUrl = media.url;
        if (!learnedMedia && media.selector) {
          learnedMedia = true;
          candidate.suggestions.streamSelector = media.selector;
          candidate.suggestions.streamAttribute = media.attribute || 'src';
        }
      } catch {
        // A sampled detail page can fail independently of the listing page.
      }
    }
    if (learnedMedia) candidate.confidence = Math.min(0.98, Number((candidate.confidence + 0.12).toFixed(2)));
  }
  return {
    pageTitle: loadHtml(page.html)('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 180),
    rendered,
    geminiModel: geminiResult.model,
    privacy: 'Gemini received only a redacted structural sketch. Page URLs, host names, text, original classes and IDs were withheld; selectors were mapped and checked locally.',
    candidates: [candidate],
    notes: ['Gemini suggestions were checked against the original page. Review the samples before applying them.']
  };
}

async function preview(sourceInput) {
  const singleConfig = sanitizeConfig({ version: 1, sources: [sourceInput] });
  const source = singleConfig.sources[0];
  const items = await getSourceItems(source, true);
  const samples = items.slice(0, 5);
  const streamResponses = [];
  let detailChecks = 0;

  for (const item of samples) {
    if (source.streamFromDetail && detailChecks >= 3) {
      streamResponses.push({
        metaId: item.meta.id,
        checked: false,
        note: 'Detail-page stream checks are limited to three sample items.'
      });
      continue;
    }

    try {
      let streamUrl = item.directStreamUrl;
      if (source.streamFromDetail) {
        detailChecks += 1;
        streamUrl = await parseStreamFromDetail(source, item.detailUrl);
      }
      streamResponses.push({
        metaId: item.meta.id,
        checked: true,
        response: {
          streams: [{ name: source.name, title: 'Personal video', url: streamUrl }]
        }
      });
    } catch (error) {
      streamResponses.push({
        metaId: item.meta.id,
        checked: true,
        response: { streams: [] },
        error: error instanceof Error ? error.message : 'Could not resolve a playable video URL.'
      });
    }
  }

  return {
    source: source.name,
    matches: items.length,
    catalogResponse: { metas: samples.map(item => item.meta) },
    streamResponses
  };
}

async function serveAsset(env, request, path = '/') {
  const assetPath = path === '/' ? '/index.html' : path;
  if (env.ASSETS) {
    const assetUrl = new URL(path, request.url);
    const assetRequest = new Request(assetUrl, { method: 'GET', headers: request.headers });
    const asset = await env.ASSETS.fetch(assetRequest);
    const headers = new Headers(asset.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers });
  }
  const body = INLINE_ASSETS[assetPath];
  if (typeof body !== 'string') return response('Configurator asset is missing.', 500, 'text/plain; charset=utf-8', request.method);
  const contentType = assetPath.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : assetPath.endsWith('.json') ? 'application/json; charset=utf-8'
      : 'text/html; charset=utf-8';
  return response(body, 200, contentType, request.method);
}

function sourceById(config, id) {
  return config.sources.find(source => source.id === id);
}

export default {
  async fetch(request, env) {
    const method = request.method.toUpperCase();
    if (method === 'OPTIONS') return response(null, 204);
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405, method);
    }

    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/' || url.pathname === '/configure' || url.pathname === '/configure/') {
      return serveAsset(env, request);
    }
    if (url.pathname === '/config.js') {
      return serveAsset(env, request, '/config.js');
    }
    if (url.pathname === '/api-response.js') {
      return serveAsset(env, request, '/api-response.js');
    }
    if (url.pathname === '/config-template.json') {
      return serveAsset(env, request, '/config-template.json');
    }
    if (url.pathname === '/api/preview' && method === 'POST') {
      try {
        const rawBody = await readLimitedBody(request.body, 16_000, 'Preview configuration is too large.');
        const body = JSON.parse(rawBody);
        return json(await preview(body.source), 200, method);
      } catch (error) {
        return errorJson(error, 400, method);
      }
    }
    if (url.pathname === '/api/analyze' && method === 'POST') {
      try {
        if (!allowRequest(analysisRequests, request, 4_000)) {
          return errorJson(new Error('Please wait a few seconds before analyzing another page.'), 429, method);
        }
        const rawBody = await readLimitedBody(request.body, 4_000, 'Analysis request is too large.');
        const body = JSON.parse(rawBody);
        if (body?.rendered === true && !allowRequest(renderedRequests, request, 60_000)) {
          return errorJson(new Error('Rendered-page analysis is limited to one request per minute. Try again shortly.'), 429, method);
        }
        return json(await analyzePage(env, body), 200, method);
      } catch (error) {
        return errorJson(error, error instanceof SyntaxError ? 400 : 400, method);
      }
    }
    if (url.pathname === '/api/gemini-analyze' && method === 'POST') {
      try {
        if (!allowRequest(geminiRequests, request, 15_000)) {
          return errorJson(new Error('Please wait 15 seconds before starting another Gemini analysis.'), 429, method);
        }
        const rawBody = await readLimitedBody(request.body, 8_000, 'Gemini analysis request is too large.');
        const body = JSON.parse(rawBody);
        if (body?.rendered === true && !allowRequest(renderedRequests, request, 60_000)) {
          return errorJson(new Error('Rendered-page analysis is limited to one request per minute. Try again shortly.'), 429, method);
        }
        return json(await analyzeWithGemini(env, body), 200, method);
      } catch (error) {
        return errorJson(error, error instanceof SyntaxError ? 400 : 400, method);
      }
    }
    if (url.pathname === '/manifest.json') {
      return json({ error: 'Set up a source page first at the add-on homepage.' }, 400, method);
    }

    const token = segments[0];
    let config;
    try {
      config = decodeConfig(token);
    } catch (error) {
      return errorJson(error, 400, method);
    }

    if (segments.length === 2 && segments[1] === 'configure') return serveAsset(env, request);
    if (segments.length === 2 && segments[1] === 'config.json') return json(config, 200, method);
    if (segments.length === 2 && segments[1] === 'manifest.json') return json(makeManifest(config), 200, method);
    if (segments.length < 4) return json({ error: 'Not found.' }, 404, method);

    const [resource, type, idPart, ...extraParts] = segments.slice(1);
    const id = decodeURIComponent(idPart.replace(/\.json$/, ''));
    if (type !== 'movie') return json({ error: 'Unsupported media type.' }, 404, method);

    try {
      if (resource === 'catalog') {
        const source = sourceById(config, id);
        if (!source) return json({ metas: [] }, 200, method);
        const extra = decodeExtra(extraParts, url);
        const search = (extra.search || '').trim().toLocaleLowerCase();
        const skip = Math.max(0, Number.parseInt(extra.skip || '0', 10) || 0);
        let items = await getSourceItems(source);
        if (search) items = items.filter(item =>
          `${item.meta.name} ${item.meta.description || ''} ${(item.meta.genres || []).join(' ')}`
            .toLocaleLowerCase().includes(search));
        return json({ metas: items.slice(skip, skip + 100).map(item => item.meta) }, 200, method);
      }

      if (resource === 'meta') {
        const itemKey = readItemKey(id);
        const source = sourceById(config, itemKey.sourceId);
        if (!source) return json({ meta: null }, 200, method);
        const items = await getSourceItems(source);
        const item = items.find(entry => entry.stableKey === itemKey.key);
        return json({ meta: item?.meta || null }, 200, method);
      }

      if (resource === 'stream') {
        const itemKey = readItemKey(id);
        const source = sourceById(config, itemKey.sourceId);
        if (!source) return json({ streams: [] }, 200, method);
        let streamUrl;
        if (source.streamFromDetail) {
          streamUrl = await parseStreamFromDetail(source, publicUrl(itemKey.key, undefined, 'Detail page URL'));
        } else {
          streamUrl = publicUrl(itemKey.key, undefined, 'Video URL');
        }
        return json({ streams: [{ name: source.name, title: 'Personal video', url: streamUrl }] }, 200, method);
      }
      return json({ error: 'Not found.' }, 404, method);
    } catch (error) {
      return errorJson(error, 502, method);
    }
  }
};

