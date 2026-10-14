import { load } from 'cheerio';
import { assertPublicHttps } from './config.js';

const MAX_SCAN_NODES = 2600;
const MAX_GROUPS = 30;
const MAX_CARDS = 100;
const MEDIA_PATH = /\.(?:mp4|m4v|webm|mov|mkv|m3u8|mpd|ts)(?:$|[?#])/i;
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'path', 'nav', 'footer', 'header', 'aside', 'menu', 'dialog', 'button', 'form']);
const NAV_MARKER = /(?:^|[-_])(?:nav(?:igation)?|menu|header|footer|sidebar|breadcrumb|pagination|social|cookie)(?:$|[-_])/i;
const STREAM_KEYS = /^(?:contenturl|video(?:url|src)?|stream(?:url|src)?|playback(?:url)?|manifest(?:url)?|file|src|url)$/i;
const STRUCTURED_DIRECT_KEYS = /^(?:contenturl|video(?:url|src)?|streamurl|playbackurl|manifesturl|file)$/i;
const IMAGE_KEYS = /image|poster|thumbnail|logo|avatar|icon|subtitle|caption/i;
const VIDEO_HINT = /(?:video|film|movie|episode|episodi|clip|stream|reel|memory|memories|gallery|media|watch)/i;
const MEDIA_ROUTE = /(?:^|\/)(?:videos?|films?|movies?|episodes?|episodi|watch|reels?|streams?|memories?)(?:\/|$)/i;

function tag(node) {
  return typeof node?.name === 'string' ? node.name.toLowerCase() : '';
}

function textOf($, node) {
  return $(node).text().replace(/\s+/g, ' ').trim();
}

function safeClassNames(node) {
  return String(node?.attribs?.class || '').split(/\s+/)
    .filter(name => /^[A-Za-z_][A-Za-z0-9_-]{0,40}$/.test(name))
    .filter(name => !/(?:^|[-_])(?:active|selected|current|hover|focus|visible|hidden)(?:$|[-_])/i.test(name))
    .filter(name => !/(?:^|[-_])(?:[a-f0-9]{10,}|\d{5,})(?:$|[-_])/i.test(name))
    .slice(0, 3);
}

function simpleSelector(node) {
  const name = tag(node);
  if (!name || name === 'html') return name || '*';
  const id = node.attribs?.id;
  if (id && /^[A-Za-z_][A-Za-z0-9_-]{0,60}$/.test(id)) return '#' + id;
  return name + safeClassNames(node).map(value => '.' + value).join('');
}

function sameTagSiblings($, node) {
  const parent = node.parent;
  if (!parent) return [node];
  return $(parent).children(tag(node)).toArray();
}

function uniquePath($, node) {
  const parts = [];
  let current = node;
  while (current && tag(current)) {
    let part = simpleSelector(current);
    const id = current.attribs?.id;
    if (!id) {
      const siblings = sameTagSiblings($, current);
      const sameSignature = siblings.filter(sibling => simpleSelector(sibling) === part);
      if (sameSignature.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += ':nth-of-type(' + index + ')';
      }
    }
    parts.unshift(part);
    const selector = parts.join(' > ');
    try {
      if ($(selector).length === 1) return selector;
    } catch {}
    if (id) return selector;
    current = current.parent;
  }
  return parts.join(' > ');
}

function nodesWithin($, scope) {
  const nodes = [scope];
  $(scope).find('*').each((_, node) => {
    if (nodes.length < MAX_SCAN_NODES) nodes.push(node);
  });
  return nodes;
}

function isExcludedContext(node) {
  let current = node;
  while (current && tag(current)) {
    const attrs = current.attribs || {};
    const markers = `${attrs.id || ''} ${attrs.class || ''} ${attrs.role || ''} ${attrs['aria-label'] || ''}`;
    if (SKIP_TAGS.has(tag(current)) || NAV_MARKER.test(markers)) return true;
    current = current.parent;
  }
  return false;
}

function relativeSelector($, scope, target) {
  if (scope === target) return simpleSelector(target);
  const parts = [];
  let current = target;
  while (current && current !== scope && tag(current)) {
    let part = simpleSelector(current);
    const siblings = sameTagSiblings($, current);
    const sameSignature = siblings.filter(sibling => simpleSelector(sibling) === part);
    if (sameSignature.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
    parts.unshift(part);
    current = current.parent;
  }
  if (current !== scope || !parts.length) return '';
  return parts.join(' > ');
}

function matchesWithin($, scope, selector) {
  if (!selector) return [];
  try {
    const matches = $(scope).find(selector).toArray();
    if (!matches.length && $(scope).is(selector)) return [scope];
    return matches;
  } catch {
    return [];
  }
}

function fieldValue($, scope, selector, attribute) {
  const node = matchesWithin($, scope, selector)[0];
  if (!node) return '';
  return attribute === 'text' ? textOf($, node) : String(node.attribs?.[attribute] || '').trim();
}

function absolutePublicUrl(value, baseUrl) {
  try {
    if (typeof value !== 'string' || !value.trim()) return '';
    const url = new URL(value.trim(), baseUrl);
    return assertPublicHttps(url.href, 'Detected URL').href;
  } catch {
    return '';
  }
}

function mediaLike(value, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    return MEDIA_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function titleCandidates($, card) {
  const nodes = nodesWithin($, card);
  return nodes.map((node, index) => {
    const name = tag(node);
    const text = textOf($, node);
    const attrs = node.attribs || {};
    const itemProp = String(attrs.itemprop || '').toLowerCase().split(/\s+/).includes('name');
    const classes = safeClassNames(node).join(' ');
    const titleAttr = attrs['aria-label'] || attrs.title || '';
    const value = text.length >= 2 ? text : titleAttr.trim();
    if (!value || value.length > 180 || SKIP_TAGS.has(name) || /^(?:read more|watch|play|more|view all)$/i.test(value)) return null;
    let score = 0;
    if (/^h[1-6]$/.test(name)) score += 5;
    if (itemProp) score += 7;
    if (/(?:title|name|caption|heading)/i.test(classes)) score += 6;
    if (name === 'a') score += 2;
    if (attrs['aria-label'] || attrs.title) score += 1;
    if (text.length > 110) score -= 3;
    if (node === card) score -= 2;
    return { node, index, score, value, attribute: text.length >= 2 ? 'text' : (attrs['aria-label'] ? 'aria-label' : 'title') };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index);
}

function inferTitle($, cards) {
  const first = cards[0];
  for (const candidate of titleCandidates($, first)) {
    const selector = relativeSelector($, first, candidate.node);
    if (!selector) continue;
    const values = cards.map(card => fieldValue($, card, selector, candidate.attribute));
    const coverage = values.filter(Boolean).length / cards.length;
    if (coverage >= 0.6) return { selector, attribute: candidate.attribute, coverage, values };
  }
  return { selector: '', attribute: 'text', coverage: 0, values: [] };
}

function findImageTargets($, card) {
  return nodesWithin($, card).filter(node => ['img', 'source'].includes(tag(node)));
}

function inferPoster($, cards) {
  const first = cards[0];
  const attrs = ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'poster'];
  for (const node of findImageTargets($, first)) {
    const selector = relativeSelector($, first, node);
    if (!selector) continue;
    for (const attribute of attrs) {
      const values = cards.map(card => fieldValue($, card, selector, attribute));
      const coverage = values.filter(value => value && !value.startsWith('data:')).length / cards.length;
      if (coverage >= 0.5) return { selector, attribute, coverage, values };
    }
  }
  return { selector: '', attribute: 'src', coverage: 0, values: [] };
}

function linkTargets($, card) {
  return nodesWithin($, card).filter(node => tag(node) === 'a' && node.attribs?.href);
}

function linkScore(node, title, label, baseUrl) {
  const href = String(node.attribs.href || '').trim();
  if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) return -100;
  const absolute = absolutePublicUrl(href, baseUrl);
  if (!absolute) return -50;
  const url = new URL(absolute);
  const titleValue = String(title || '').toLowerCase();
  let score = url.origin === new URL(baseUrl).origin ? 3 : 0;
  if (/\/(?:video|film|episode|episodi|watch|movie|show)\//i.test(url.pathname)) score += 5;
  if (/(?:login|account|privacy|cookie|facebook|instagram|youtube|terms|help)/i.test(url.pathname)) score -= 8;
  if (titleValue && label && (label.toLowerCase().includes(titleValue) || titleValue.includes(label.toLowerCase()))) score += 7;
  if (label.length >= 3 && label.length <= 150) score += 2;
  return score;
}

function inferLink($, cards, titles, baseUrl) {
  const first = cards[0];
  const candidates = linkTargets($, first).map((node, index) => {
    const selector = relativeSelector($, first, node);
    const href = absolutePublicUrl(node.attribs.href || '', baseUrl);
    const label = textOf($, node) || node.attribs['aria-label'] || node.attribs.title || '';
    return { node, index, selector, href, label, score: linkScore(node, titles[0], label, baseUrl) };
  }).filter(item => item.selector && item.href && item.score > -10).sort((a, b) => b.score - a.score || a.index - b.index);

  for (const candidate of candidates) {
    const values = cards.map(card => {
      const node = matchesWithin($, card, candidate.selector)[0];
      return node ? absolutePublicUrl(node.attribs?.href || '', baseUrl) : '';
    });
    const coverage = values.filter(Boolean).length / cards.length;
    if (coverage >= 0.6) return { selector: candidate.selector, attribute: 'href', coverage, values };
  }
  return { selector: '', attribute: 'href', coverage: 0, values: [] };
}

function mediaAttributeFor(node) {
  const name = tag(node);
  const attrs = ['src', 'data-src', 'data-video-url', 'data-stream', 'data-hls', 'data-file', 'href', 'content'];
  for (const attribute of attrs) {
    const value = node.attribs?.[attribute];
    if (!value) continue;
    if (mediaLike(value, 'https://example.invalid/')) return attribute;
    if (['data-video-url', 'data-stream', 'data-hls', 'data-file'].includes(attribute)) return attribute;
    if (['video', 'source'].includes(name) && ['src', 'data-src'].includes(attribute)) return attribute;
  }
  return '';
}

function inferDirectMedia($, cards, baseUrl) {
  const first = cards[0];
  const candidates = nodesWithin($, first)
    .map((node, index) => ({ node, index, attribute: mediaAttributeFor(node) }))
    .filter(item => item.attribute)
    .map(item => ({ ...item, selector: relativeSelector($, first, item.node) }))
    .filter(item => item.selector)
    .sort((a, b) => {
      const score = item => (['video', 'source'].includes(tag(item.node)) ? 8 : 0) + (item.attribute.startsWith('data-') ? 2 : 0) + (item.attribute === 'href' ? 1 : 0);
      return score(b) - score(a) || a.index - b.index;
    });

  for (const candidate of candidates) {
    const values = cards.map(card => {
      const node = matchesWithin($, card, candidate.selector)[0];
      return node ? absolutePublicUrl(node.attribs?.[candidate.attribute] || '', baseUrl) : '';
    });
    const coverage = values.filter(value => value && mediaLike(value, baseUrl)).length / cards.length;
    if (coverage >= 0.5) return { selector: candidate.selector, attribute: candidate.attribute, coverage, values };
  }
  return { selector: '', attribute: 'src', coverage: 0, values: [] };
}

function inferDescription($, cards) {
  const first = cards[0];
  const nodes = nodesWithin($, first).filter(node => {
    const cls = safeClassNames(node).join(' ');
    return /description|synopsis|summary|overview|caption|subtitle/i.test(cls);
  });
  for (const node of nodes) {
    const selector = relativeSelector($, first, node);
    if (!selector) continue;
    const values = cards.map(card => fieldValue($, card, selector, 'text'));
    const coverage = values.filter(value => value.length >= 12 && value.length <= 1000).length / cards.length;
    if (coverage >= 0.5) return { selector, attribute: 'text', coverage, values };
  }
  return { selector: '', attribute: 'text', coverage: 0, values: [] };
}

function groupSignature(node) {
  return tag(node) + '|' + safeClassNames(node).join('.');
}

function discoverGroups($) {
  const body = $('body')[0];
  if (!body) return [];
  const parents = [body, ...nodesWithin($, body).slice(1)];
  const selectorCache = new WeakMap();
  const groups = new Map();
  for (const parent of parents) {
    if (isExcludedContext(parent)) continue;
    const children = $(parent).children().toArray().filter(node => !SKIP_TAGS.has(tag(node)));
    if (children.length < 2) continue;
    const siblingGroups = new Map();
    for (const child of children) {
      if (isExcludedContext(child)) continue;
      const signature = groupSignature(child);
      if (!signature || signature === '|') continue;
      const group = siblingGroups.get(signature) || [];
      group.push(child);
      siblingGroups.set(signature, group);
    }
    for (const [signature, siblings] of siblingGroups) {
      if (siblings.length < 2 || siblings.length > MAX_CARDS) continue;
      let parentCss = selectorCache.get(parent);
      if (!parentCss) {
        parentCss = uniquePath($, parent);
        selectorCache.set(parent, parentCss);
      }
      const childCss = simpleSelector(siblings[0]);
      const selector = parentCss + ' > ' + childCss;
      let matches;
      try { matches = $(selector).toArray(); } catch { continue; }
      if (matches.length < 2 || matches.length > MAX_CARDS) continue;
      const key = selector;
      if (!groups.has(key)) groups.set(key, { selector, matches, signature });
      if (groups.size >= MAX_GROUPS) return [...groups.values()];
    }
  }
  return [...groups.values()];
}

function scoreGroup($, group, pageUrl) {
  const cards = group.matches.slice(0, 5);
  const title = inferTitle($, cards);
  if (!title.selector || title.coverage < 0.6) return null;
  const titles = title.values.map(value => value || '');
  const link = inferLink($, cards, titles, pageUrl);
  const poster = inferPoster($, cards);
  const description = inferDescription($, cards);
  const media = inferDirectMedia($, cards, pageUrl);
  if (link.coverage < 0.5 && media.coverage < 0.5) return null;
  const mediaRouteCoverage = link.values.filter(value => {
    try { return MEDIA_ROUTE.test(new URL(value).pathname); } catch { return false; }
  }).length / cards.length;
  const semanticHint = VIDEO_HINT.test(`${group.selector} ${group.signature}`);
  if (media.coverage < 0.5 && poster.coverage < 0.5 && description.coverage < 0.5 && !semanticHint && mediaRouteCoverage < 0.5) return null;

  const repeatedBonus = Math.min(group.matches.length, 12) / 12;
  const confidence = Math.min(media.coverage >= 0.5 ? 0.99 : 0.65,
    0.48 * title.coverage +
    0.28 * Math.max(link.coverage, media.coverage) +
    0.10 * poster.coverage +
    0.06 * description.coverage +
    0.08 * repeatedBonus);
  const streamFromDetail = media.coverage < 0.5 && link.coverage >= 0.5;
  const suggestions = {
    itemSelector: group.selector,
    titleSelector: title.selector,
    titleAttribute: title.attribute,
    descriptionSelector: description.selector,
    descriptionAttribute: description.attribute,
    posterSelector: poster.selector,
    posterAttribute: poster.attribute,
    detailLinkSelector: link.selector,
    detailLinkAttribute: link.attribute,
    streamSelector: media.selector || 'video source',
    streamAttribute: media.attribute || 'src',
    streamFromDetail
  };
  const sample = cards.slice(0, 3).map((card, index) => ({
    title: titles[index] || '',
    detailUrl: link.values[index] || '',
    posterUrl: poster.values[index] || '',
    mediaUrl: media.values[index] || ''
  }));
  return {
    confidence: Number(confidence.toFixed(2)),
    suggestions,
    diagnostics: {
      matchedCards: group.matches.length,
      sampledCards: cards.length,
      titleMatches: Math.round(title.coverage * cards.length),
      detailLinks: Math.round(link.coverage * cards.length),
      posters: Math.round(poster.coverage * cards.length),
      descriptions: Math.round(description.coverage * cards.length),
      directMedia: Math.round(media.coverage * cards.length),
      semanticHint,
      detailPagesTested: 0,
      detailPagesWithMedia: 0
    },
    sample
  };
}

function findSinglePage($, pageUrl) {
  const title = $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text().replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const media = findMediaCandidate($, $.root(), pageUrl);
  const poster = $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '';
  const description = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
  const titleSelector = $('h1').length ? 'h1' : ($('meta[property="og:title"]').length ? 'meta[property="og:title"]' : 'title');
  const titleAttribute = titleSelector.startsWith('meta') ? 'content' : 'text';
  return {
    confidence: media ? 0.8 : 0.55,
    suggestions: {
      itemSelector: 'body',
      titleSelector,
      titleAttribute,
      descriptionSelector: $('meta[property="og:description"]').length ? 'meta[property="og:description"]' : ($('meta[name="description"]').length ? 'meta[name="description"]' : ''),
      descriptionAttribute: 'content',
      posterSelector: $('meta[property="og:image"]').length ? 'meta[property="og:image"]' : ($('meta[name="twitter:image"]').length ? 'meta[name="twitter:image"]' : ''),
      posterAttribute: 'content',
      detailLinkSelector: '',
      detailLinkAttribute: 'href',
      streamSelector: media?.selector || 'video source',
      streamAttribute: media?.attribute || 'src',
      streamFromDetail: false
    },
    diagnostics: {
      matchedCards: 1,
      sampledCards: 1,
      titleMatches: 1,
      detailLinks: 0,
      posters: poster ? 1 : 0,
      directMedia: media ? 1 : 0,
      detailPagesTested: 0,
      detailPagesWithMedia: 0
    },
    sample: [{ title, detailUrl: '', posterUrl: absolutePublicUrl(poster, pageUrl), mediaUrl: media?.url || '' }]
  };
}

function parseStructuredMedia($, pageUrl) {
  const urls = [];
  const scriptSelectors = 'script[type="application/ld+json"],script[type="application/json"],script#__NEXT_DATA__';
  $(scriptSelectors).each((_, script) => {
    const raw = $(script).text();
    if (!raw || raw.length > 500_000) return;
    let data;
    try { data = JSON.parse(raw); } catch { return; }
    const visit = (value, key, depth) => {
      if (depth > 12 || urls.length >= 12 || IMAGE_KEYS.test(key)) return;
      if (typeof value === 'string') {
    if (STREAM_KEYS.test(key) && (mediaLike(value, pageUrl) || STRUCTURED_DIRECT_KEYS.test(key))) {
          const url = absolutePublicUrl(value, pageUrl);
          if (url) urls.push({ url, kind: 'structured' });
        }
        return;
      }
      if (Array.isArray(value)) {
        value.slice(0, 100).forEach(item => visit(item, key, depth + 1));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [childKey, child] of Object.entries(value).slice(0, 300)) visit(child, childKey, depth + 1);
      }
    };
    visit(data, '', 0);
  });
  return urls[0] || null;
}

export function findMediaCandidate($, scope, pageUrl) {
  const candidates = [
    ['video source', 'src', 10],
    ['video source', 'data-src', 9],
    ['video', 'src', 9],
    ['video', 'data-src', 8],
    ['source', 'src', 7],
    ['[data-video-url]', 'data-video-url', 7],
    ['[data-stream]', 'data-stream', 7],
    ['[data-hls]', 'data-hls', 7],
    ['meta[property="og:video"]', 'content', 6],
    ['meta[name="twitter:player:stream"]', 'content', 6],
    ['a[href]', 'href', 5]
  ];
  const found = [];
  for (const [selector, attribute, score] of candidates) {
    for (const node of matchesWithin($, scope, selector).slice(0, 10)) {
      const raw = String(node.attribs?.[attribute] || '').trim();
      if (!raw) continue;
      const url = absolutePublicUrl(raw, pageUrl);
      if (!url) continue;
      const isVideoNode = ['video', 'source'].includes(tag(node));
      const explicitMedia = ['data-video-url', 'data-stream', 'data-hls', 'data-file', 'content'].includes(attribute) &&
        (selector !== 'meta[property="og:video"]' || node.attribs?.property === 'og:video');
      if (!isVideoNode && !explicitMedia && !mediaLike(raw, pageUrl)) continue;
      found.push({ url, selector, attribute, score, kind: 'html' });
    }
  }
  found.sort((a, b) => b.score - a.score);
  if (found.length) return found[0];
  const structured = !tag(scope) || ['html', 'body'].includes(tag(scope))
    ? parseStructuredMedia($, pageUrl)
    : null;
  return structured ? { ...structured, selector: '', attribute: '', score: 4 } : null;
}

export function extractMediaUrl($, scope, pageUrl, preferredSelector = '', preferredAttribute = 'src') {
  if (preferredSelector) {
    const value = fieldValue($, scope, preferredSelector, preferredAttribute);
    const url = absolutePublicUrl(value, pageUrl);
    if (url) return url;
  }
  return findMediaCandidate($, scope, pageUrl)?.url || '';
}

export function analyzeHtml(html, pageUrl) {
  const $ = load(html);
  const groups = discoverGroups($);
  const candidates = groups
    .map(group => scoreGroup($, group, pageUrl))
    .filter(Boolean)
    .sort((a, b) => b.confidence - a.confidence || b.diagnostics.matchedCards - a.diagnostics.matchedCards)
    .slice(0, 3);
  const single = findSinglePage($, pageUrl);
  const candidatesHaveDirectMedia = candidates.some(candidate =>
    candidate.diagnostics.directMedia >= Math.ceil(candidate.diagnostics.sampledCards * 0.5));
  if (single && (!candidates.length || (single.diagnostics.directMedia > 0 && !candidatesHaveDirectMedia))) {
    candidates.unshift(single);
    candidates.splice(3);
  }
  const embeddedMedia = findMediaCandidate($, $.root(), pageUrl);
  return {
    pageUrl,
    pageTitle: $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 180),
    pageBytes: new TextEncoder().encode(html).byteLength,
    candidates,
    pageMedia: embeddedMedia ? { url: embeddedMedia.url, kind: embeddedMedia.kind } : null,
    notes: candidates.length
      ? ['Suggestions are inferred from repeated markup. Review the samples before applying them.']
      : ['No repeated video-card pattern was identified. The page may need rendered HTML or a manual CSS selector.']
  };
}

export function inspectDetailMedia(html, pageUrl) {
  const $ = load(html);
  return findMediaCandidate($, $.root(), pageUrl);
}
