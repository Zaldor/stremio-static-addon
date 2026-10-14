import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { analyzeHtml, extractMediaUrl, inspectDetailMedia } from '../worker/analyzer.js';
import { mapGeminiSuggestions, redactHtmlForGemini } from '../worker/gemini.js';
import { encodeConfig } from '../worker/config.js';
import worker from '../worker/index.js';

const listingUrl = 'https://memories.example/videos/';

test('learns a repeated card pattern and validates fields across the first samples', () => {
  const html = `<!doctype html><html><head><title>Summer memories</title></head><body>
    <section class="gallery">
      <article class="video-card"><a class="watch" href="/watch/one"><h2 class="video-title">First holiday</h2></a><img class="poster" src="/posters/one.jpg"><p class="description">A sunny first trip.</p><video><source src="/media/one.mp4"></video></article>
      <article class="video-card"><a class="watch" href="/watch/two"><h2 class="video-title">Second holiday</h2></a><img class="poster" src="/posters/two.jpg"><p class="description">A weekend by the sea.</p><video><source src="/media/two.mp4"></video></article>
      <article class="video-card"><a class="watch" href="/watch/three"><h2 class="video-title">Third holiday</h2></a><img class="poster" src="/posters/three.jpg"><p class="description">A walk in the mountains.</p><video><source src="/media/three.mp4"></video></article>
    </section>
  </body></html>`;

  const result = analyzeHtml(html, listingUrl);
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.equal(candidate.suggestions.itemSelector, 'section.gallery > article.video-card');
  assert.equal(candidate.suggestions.streamFromDetail, false);
  assert.equal(candidate.suggestions.streamSelector, 'video > source');
  assert.equal(candidate.diagnostics.matchedCards, 3);
  assert.equal(candidate.diagnostics.titleMatches, 3);
  assert.equal(candidate.diagnostics.directMedia, 3);
  assert.deepEqual(candidate.sample.map(item => item.title), ['First holiday', 'Second holiday', 'Third holiday']);
});

test('marks detail-page streams when repeated cards only contain watch links', () => {
  const html = `<main><div class="memory"><a href="/watch/a"><h3 class="title">Memory A</h3></a></div>
    <div class="memory"><a href="/watch/b"><h3 class="title">Memory B</h3></a></div></main>`;
  const candidate = analyzeHtml(html, listingUrl).candidates[0];
  assert.ok(candidate);
  assert.equal(candidate.suggestions.streamFromDetail, true);
  assert.equal(candidate.suggestions.detailLinkSelector, 'a');
  assert.equal(candidate.diagnostics.detailLinks, 2);
});

test('finds media URLs in common player markup and JSON-LD', () => {
  const playerHtml = '<html><body><video controls><source src="/media/party.m3u8"></video></body></html>';
  const player = inspectDetailMedia(playerHtml, 'https://memories.example/watch/party');
  assert.equal(player.url, 'https://memories.example/media/party.m3u8');
  assert.equal(player.selector, 'video source');

  const structuredHtml = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'VideoObject',
    name: 'Family party',
    contentUrl: 'https://cdn.memories.example/party.mp4',
    thumbnailUrl: 'https://cdn.memories.example/party.jpg'
  })}</script></head><body></body></html>`;
  const structured = inspectDetailMedia(structuredHtml, 'https://memories.example/watch/party');
  assert.equal(structured.url, 'https://cdn.memories.example/party.mp4');
  assert.equal(structured.kind, 'structured');
});

test('automatic stream detection falls back when a configured selector misses', () => {
  const html = '<article><a href="/media/clip.webm">Play clip</a></article>';
  const $ = load(html);
  assert.equal(extractMediaUrl($, $('article')[0], listingUrl, 'video source', 'src'), 'https://memories.example/media/clip.webm');
});

test('reports no pattern when a page has no useful video title or media data', () => {
  const result = analyzeHtml('<html><body><div><span>Welcome</span><span>About</span></div></body></html>', listingUrl);
  assert.deepEqual(result.candidates, []);
});

test('ignores repeated navigation menus that resemble titled link cards', () => {
  const html = `<html><body><nav class="site-menu"><ul class="site-menu__list">
    <li class="site-menu__item"><a href="/film"><h3 class="title">Film</h3></a></li>
    <li class="site-menu__item"><a href="/series"><h3 class="title">Series</h3></a></li>
    <li class="site-menu__item"><a href="/sports"><h3 class="title">Sports</h3></a></li>
  </ul></nav></body></html>`;
  assert.deepEqual(analyzeHtml(html, listingUrl).candidates, []);
});

test('does not promote generic navigation-like links without media evidence', () => {
  const html = `<html><body><main><ul>
    <li><a href="/programmi/film"><h3>Film</h3></a></li>
    <li><a href="/programmi/series"><h3>Series</h3></a></li>
    <li><a href="/sport"><h3>Sports</h3></a></li>
  </ul></main></body></html>`;
  assert.deepEqual(analyzeHtml(html, listingUrl).candidates, []);
});

test('analysis endpoint checks same-site detail pages and reports learned media selectors', async t => {
  const pages = new Map([
    ['https://memories.example/videos/', `<main><article class="memory"><a class="watch" href="/watch/a"><h2 class="title">Party A</h2></a></article><article class="memory"><a class="watch" href="/watch/b"><h2 class="title">Party B</h2></a></article></main>`],
    ['https://memories.example/watch/a', '<video><source src="/media/a.mp4"></video>'],
    ['https://memories.example/watch/b', '<video><source src="/media/b.mp4"></video>']
  ]);
  t.mock.method(globalThis, 'fetch', async input => {
    const html = pages.get(String(input));
    if (!html) return new Response('not found', { status: 404 });
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  });

  const response = await worker.fetch(new Request('https://stremio.juzemaru.com/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.77' },
    body: JSON.stringify({ pageUrl: 'https://memories.example/videos/' })
  }), {});
  assert.equal(response.status, 200);
  const data = await response.json();
  const candidate = data.candidates[0];
  assert.equal(candidate.diagnostics.detailPagesTested, 2);
  assert.equal(candidate.diagnostics.detailPagesWithMedia, 2);
  assert.equal(candidate.suggestions.streamSelector, 'video source');
  assert.equal(candidate.sample[0].mediaUrl, 'https://memories.example/media/a.mp4');
});

test('rendered analysis also renders a bounded set of detail pages to learn media', async t => {
  const pages = new Map([
    ['https://memories.example/videos/', `<main><article class="memory"><a href="/watch/a"><h2 class="title">Memory A</h2></a></article><article class="memory"><a href="/watch/b"><h2 class="title">Memory B</h2></a></article></main>`],
    ['https://memories.example/watch/a', '<video><source src="/media/a.m3u8"></video>'],
    ['https://memories.example/watch/b', '<video><source src="/media/b.m3u8"></video>']
  ]);
  const calls = [];
  const env = { BROWSER: { quickAction: async (action, options) => {
    calls.push({ action, url: options.url });
    const html = pages.get(options.url);
    return html ? new Response(html) : new Response('not found', { status: 404 });
  } } };
  const response = await worker.fetch(new Request('https://stremio.juzemaru.com/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.78' },
    body: JSON.stringify({ pageUrl: 'https://memories.example/videos/', rendered: true })
  }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  const candidate = data.candidates[0];
  assert.equal(data.rendered, true);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.action === 'content'));
  assert.equal(candidate.diagnostics.detailPagesTested, 2);
  assert.equal(candidate.diagnostics.detailPagesWithMedia, 2);
  assert.equal(candidate.suggestions.streamSelector, 'video source');
  assert.equal(candidate.sample[0].mediaUrl, 'https://memories.example/media/a.m3u8');
});

test('manifest exposes the configuration page inside Stremio add-on settings', async () => {
  const config = { version: 1, sources: [{
    id: 'holidays', name: 'Holidays', pageUrl: 'https://memories.example/videos/',
    itemSelector: '.video-card', titleSelector: '.title', streamSelector: 'video source',
    streamFromDetail: false
  }] };
  const token = encodeConfig(config);
  const response = await worker.fetch(new Request(`https://stremio.juzemaru.com/${token}/manifest.json`), {});
  assert.equal(response.status, 200);
  const manifest = await response.json();
  assert.equal(manifest.behaviorHints.configurable, true);
  assert.equal(manifest.catalogs[0].name, 'Holidays');
});

test('serves the API response helper module through the static asset binding', async () => {
  let requestedPath = '';
  const env = { ASSETS: { fetch: async request => {
    requestedPath = new URL(request.url).pathname;
    return new Response('export async function readApiJson() {}', {
      headers: { 'content-type': 'text/javascript; charset=utf-8' }
    });
  } } };
  const response = await worker.fetch(new Request('https://stremio.juzemaru.com/api-response.js'), env);
  assert.equal(response.status, 200);
  assert.equal(requestedPath, '/api-response.js');
  assert.match(await response.text(), /readApiJson/);
});

test('page preview returns Stremio-shaped metadata and resolved direct streams', async t => {
  const html = `<article class="video-card"><h2 class="title">Family holiday</h2>
    <p class="description">A week by the sea</p><img class="poster" src="/poster.jpg">
    <time datetime="2024">2024</time><video><source src="/media/holiday.mp4"></video></article>`;
  t.mock.method(globalThis, 'fetch', async input => String(input) === 'https://memories.example/videos/'
    ? new Response(html, { status: 200 })
    : new Response('not found', { status: 404 }));

  const response = await worker.fetch(new Request('https://stremio.juzemaru.com/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: {
      id: 'holidays', name: 'Holidays', pageUrl: 'https://memories.example/videos/',
      itemSelector: '.video-card', titleSelector: '.title', titleAttribute: 'text',
      descriptionSelector: '.description', descriptionAttribute: 'text',
      posterSelector: '.poster', posterAttribute: 'src',
      streamSelector: 'video source', streamAttribute: 'src', streamFromDetail: false,
      metaFields: [{ key: 'releaseInfo', selector: 'time', attribute: 'datetime' }]
    } })
  }), {});
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.matches, 1);
  assert.equal(output.catalogResponse.metas[0].name, 'Family holiday');
  assert.equal(output.catalogResponse.metas[0].description, 'A week by the sea');
  assert.equal(output.catalogResponse.metas[0].poster, 'https://memories.example/poster.jpg');
  assert.equal(output.catalogResponse.metas[0].releaseInfo, '2024');
  assert.deepEqual(output.streamResponses[0].response.streams[0], {
    name: 'Holidays', title: 'Personal video', url: 'https://memories.example/media/holiday.mp4'
  });
});

test('page preview accepts source pages larger than the legacy 1.5 MB limit', async t => {
  const card = '<article class="video-card"><h2 class="title">A large-page memory</h2><video><source src="/media/memory.mp4"></video></article>';
  const html = `<main>${card}</main><!--${'large page padding '.repeat(90_000)}-->`;
  assert.ok(new TextEncoder().encode(html).byteLength > 1_500_000);
  t.mock.method(globalThis, 'fetch', async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));

  const response = await worker.fetch(new Request('https://stremio.juzemaru.com/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: {
      id: 'large-page', name: 'Large page', pageUrl: 'https://memories.example/videos/',
      itemSelector: '.video-card', titleSelector: '.title', titleAttribute: 'text',
      streamSelector: 'video source', streamAttribute: 'src', streamFromDetail: false
    } })
  }), {});
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.matches, 1);
  assert.equal(output.catalogResponse.metas[0].name, 'A large-page memory');
});

test('page preview checks configured selectors on detail pages', async t => {
  const pages = new Map([
    ['https://memories.example/videos/', '<article class="video-card"><a class="watch" href="/watch/one"><h2 class="title">Birthday</h2></a></article>'],
    ['https://memories.example/watch/one', '<video><source src="/media/birthday.mp4"></video>']
  ]);
  t.mock.method(globalThis, 'fetch', async input => {
    const html = pages.get(String(input));
    return html ? new Response(html, { status: 200 }) : new Response('not found', { status: 404 });
  });

  const response = await worker.fetch(new Request('https://stremio.juzemaru.com/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: {
      id: 'birthdays', name: 'Birthdays', pageUrl: 'https://memories.example/videos/',
      itemSelector: '.video-card', titleSelector: '.title', titleAttribute: 'text',
      detailLinkSelector: 'a.watch', detailLinkAttribute: 'href',
      streamSelector: 'video source', streamAttribute: 'src', streamFromDetail: true
    } })
  }), {});
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.catalogResponse.metas[0].name, 'Birthday');
  assert.equal(output.streamResponses[0].checked, true);
  assert.equal(output.streamResponses[0].response.streams[0].url, 'https://memories.example/media/birthday.mp4');
});

test('Gemini redaction removes page URLs, original identifiers and page text before model use', () => {
  const html = `<main class="private-holiday-grid" id="alice-family"><article class="private-video-card"><a class="secret-watch" href="https://private.example/2026/family-party?token=secret"><h2 class="private-title">Alice's 40th birthday</h2></a><video><source src="https://media.private.example/alice-family.mp4"></video></article></main>`;
  const redacted = redactHtmlForGemini(html);
  for (const secret of ['private.example', 'family-party', 'token=secret', 'alice-family', 'private-holiday-grid', 'secret-watch', 'Alice', 'birthday']) {
    assert.equal(redacted.markup.includes(secret), false, `redacted markup leaked ${secret}`);
  }
  assert.match(redacted.markup, /__URL_1__/);
  assert.equal(redacted.urlValues.get('__URL_1__'), 'https://private.example/2026/family-party?token=secret');
  assert.equal(redacted.urlValues.get('__URL_2__'), 'https://media.private.example/alice-family.mp4');
  const suggestions = mapGeminiSuggestions({
    itemSelector: 'main.c1 > article.c2', titleSelector: 'h2.c4', descriptionSelector: '',
    posterSelector: '', detailLinkSelector: 'a.c3', streamSelector: 'video > source',
    titleAttribute: 'text', descriptionAttribute: 'text', posterAttribute: 'src',
    detailLinkAttribute: 'href', streamAttribute: 'src', streamFromDetail: false
  }, redacted);
  assert.equal(suggestions.itemSelector, 'main.private-holiday-grid > article.private-video-card');
  assert.equal(suggestions.titleSelector, 'h2.private-title');
});

test('Gemini redaction bounds oversized page structure', () => {
  const attrs = Array.from({ length: 24 }, (_, index) => `data-long-attribute-${index}="private-${index}"`).join(' ');
  const page = `<main>${Array.from({ length: 360 }, (_, index) => `<article ${attrs}><h2>Private memory ${index}</h2></article>`).join('')}</main>`;
  const redacted = redactHtmlForGemini(page);
  assert.ok(redacted.markup.length <= 24_000, `redacted structure had ${redacted.markup.length} chars`);
  assert.equal(redacted.markup.includes('private-0'), false);
  assert.equal(redacted.markup.includes('Private memory'), false);
  assert.match(redacted.markup, /<article/);
});

test('Gemini analysis sends only redacted structure and validates mapped selectors on the original page', async t => {
  const pageUrl = 'https://private.example/holidays/?private=alice';
  const html = `<html><head><title>Alice private family memories</title></head><body><main class="private-grid"><article class="private-card"><a class="private-link" href="https://private.example/watch/a?token=one"><h2 class="private-title">Alice birthday</h2></a><video><source src="https://media.private.example/a-family.mp4"></video></article><article class="private-card"><a class="private-link" href="https://private.example/watch/b?token=two"><h2 class="private-title">Family holiday</h2></a><video><source src="https://media.private.example/b-family.mp4"></video></article></main></body></html>`;
  const calls = [];
  const key = 'test-gemini-api-key-that-must-not-leak';
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === pageUrl) return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.includes('generativelanguage.googleapis.com')) {
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        itemSelector: 'main.c1 > article.c2', titleSelector: 'h2.c4', titleAttribute: 'text',
        descriptionSelector: '', descriptionAttribute: 'text', posterSelector: '', posterAttribute: 'src',
        detailLinkSelector: 'a.c3', detailLinkAttribute: 'href', streamSelector: 'video > source',
        streamAttribute: 'src', streamFromDetail: false
      }) }] } }] });
    }
    return new Response('not found', { status: 404 });
  });
  const response = await worker.fetch(new Request('https://stremio.juzemaru.com/api/gemini-analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.90' },
    body: JSON.stringify({ pageUrl, rendered: false, apiKey: key })
  }), {});
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.geminiModel, 'gemini-3.8-flash');
  assert.equal(output.candidates[0].suggestions.itemSelector, 'main.private-grid > article.private-card');
  assert.deepEqual(output.candidates[0].sample.map(item => item.title), ['Alice birthday', 'Family holiday']);
  assert.equal(output.candidates[0].diagnostics.directMedia, 2);
  const geminiCall = calls.find(call => call.url.includes('generativelanguage.googleapis.com'));
  assert.ok(geminiCall);
  assert.equal(new Headers(geminiCall.init.headers).get('x-goog-api-key'), key);
  const prompt = JSON.parse(geminiCall.init.body).contents[0].parts[0].text;
  const payload = JSON.parse(geminiCall.init.body);
  assert.equal(payload.generationConfig.thinkingConfig.thinkingLevel, 'low');
  for (const secret of [pageUrl, 'private.example', 'media.private.example', 'token=one', 'Alice birthday', 'private-grid', 'private-card']) {
    assert.equal(prompt.includes(secret), false, `Gemini prompt leaked ${secret}`);
  }
  assert.match(prompt, /__URL_1__/);
  assert.equal(JSON.stringify(output).includes(key), false);
});
