import { load as loadHtml } from 'cheerio';
import { assertPublicHttps, decodeBase64Url, decodeConfig, encodeBase64Url, sanitizeConfig } from './config.js';

const MAX_HTML_BYTES = 1_500_000;
const MAX_ITEMS = 100;
const PAGE_CACHE_MS = 30_000;
const pageCache = new Map();

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

async function readLimitedBody(responseBody) {
  if (!responseBody) return '';
  const reader = responseBody.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      await reader.cancel();
      throw new Error('The source page is larger than 1.5 MB.');
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
      if (declaredLength > MAX_HTML_BYTES) throw new Error('The source page is larger than 1.5 MB.');
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
      : readField(card, source.streamSelector, source.streamAttribute, url, true);
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
    name: 'My Memories',
    description: 'Personal video memories from your own web pages.',
    types: ['movie'],
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
      const value = readField($(html), source.streamSelector, source.streamAttribute, url, true);
      if (!value) throw new Error(`No video URL matched the selector for "${source.name}".`);
      return value;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('No video URL')) throw error;
      throw new Error(`Invalid video URL selector for "${source.name}".`);
    }
  });
}

async function preview(sourceInput) {
  const singleConfig = sanitizeConfig({ version: 1, sources: [sourceInput] });
  const source = singleConfig.sources[0];
  const items = await getSourceItems(source, true);
  return {
    source: source.name,
    matches: items.length,
    sample: items.slice(0, 5).map(item => ({
      name: item.meta.name,
      description: item.meta.description || '',
      poster: item.meta.poster || '',
      videoUrl: source.streamFromDetail ? item.detailUrl : item.directStreamUrl
    }))
  };
}

async function serveAsset(env, request, path = '/') {
  if (!env.ASSETS) return response('Configurator asset is missing.', 500, 'text/plain; charset=utf-8', request.method);
  const assetUrl = new URL(path, request.url);
  const assetRequest = new Request(assetUrl, { method: 'GET', headers: request.headers });
  const asset = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(asset.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : asset.body, { status: asset.status, headers });
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
    if (url.pathname === '/config-template.json') {
      return serveAsset(env, request, '/config-template.json');
    }
    if (url.pathname === '/api/preview' && method === 'POST') {
      try {
        const rawBody = await request.text();
        if (new TextEncoder().encode(rawBody).byteLength > 16_000) throw new Error('Preview configuration is too large.');
        const body = JSON.parse(rawBody);
        return json(await preview(body.source), 200, method);
      } catch (error) {
        return errorJson(error, 400, method);
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

