export const MAX_SOURCES = 12;
export const MAX_TOKEN_LENGTH = 12000;

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const META_KEYS = new Set([
  'background', 'logo', 'releaseInfo', 'runtime', 'imdbRating', 'genres',
  'cast', 'director', 'language', 'country', 'awards', 'website', 'certification'
]);

function asString(value, label, max = 240, required = false) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new Error(`${label} is required.`);
  if (result.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
  return result;
}

export function assertPublicHttps(value, label = 'URL') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid absolute URL.`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`);
  if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.test') ||
      host.endsWith('.invalid') || host.endsWith('.onion') || host.includes(':') ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    throw new Error(`${label} must use a public domain name.`);
  }
  return url;
}

export function sanitizeConfig(input) {
  if (!input || typeof input !== 'object' || input.version !== 1 || !Array.isArray(input.sources)) {
    throw new Error('Configuration must be a version 1 source list.');
  }
  if (input.sources.length < 1 || input.sources.length > MAX_SOURCES) {
    throw new Error(`Add between 1 and ${MAX_SOURCES} source pages.`);
  }

  const usedIds = new Set();
  const sources = input.sources.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`Source ${index + 1} is invalid.`);
    const name = asString(raw.name, `Source ${index + 1} name`, 48, true);
    const id = asString(raw.id, `Source ${index + 1} ID`, 40, true).toLowerCase();
    if (!SAFE_ID.test(id)) throw new Error(`Source ${index + 1} ID may use lowercase letters, numbers, _ and -.`);
    if (usedIds.has(id)) throw new Error(`The source ID "${id}" is duplicated.`);
    usedIds.add(id);

    const pageUrl = asString(raw.pageUrl, `${name} page URL`, 2048, true);
    assertPublicHttps(pageUrl, `${name} page URL`);
    const source = {
      id,
      name,
      pageUrl,
      itemSelector: asString(raw.itemSelector, `${name} item selector`, 200, true),
      titleSelector: asString(raw.titleSelector, `${name} title selector`, 200, true),
      titleAttribute: asString(raw.titleAttribute || 'text', `${name} title attribute`, 40),
      descriptionSelector: asString(raw.descriptionSelector, `${name} description selector`, 200),
      descriptionAttribute: asString(raw.descriptionAttribute || 'text', `${name} description attribute`, 40),
      posterSelector: asString(raw.posterSelector, `${name} poster selector`, 200),
      posterAttribute: asString(raw.posterAttribute || 'src', `${name} poster attribute`, 40),
      detailLinkSelector: asString(raw.detailLinkSelector, `${name} detail link selector`, 200),
      detailLinkAttribute: asString(raw.detailLinkAttribute || 'href', `${name} detail link attribute`, 40),
      streamSelector: asString(raw.streamSelector, `${name} video URL selector`, 200, true),
      streamAttribute: asString(raw.streamAttribute || 'src', `${name} video URL attribute`, 40),
      streamFromDetail: raw.streamFromDetail === true,
      metaFields: []
    };

    if (!source.itemSelector || !source.titleSelector || !source.streamSelector) {
      throw new Error(`${name} needs item, title, and video URL selectors.`);
    }
    if (source.streamFromDetail && !source.detailLinkSelector) {
      throw new Error(`${name} needs a detail link selector when the video URL is on the detail page.`);
    }
    if (raw.metaFields !== undefined && !Array.isArray(raw.metaFields)) {
      throw new Error(`${name} additional fields must be a list.`);
    }
    if ((raw.metaFields || []).length > META_KEYS.size) {
      throw new Error(`${name} supports up to ${META_KEYS.size} additional Stremio fields.`);
    }
    source.metaFields = (raw.metaFields || []).map((field, fieldIndex) => {
      if (!field || !META_KEYS.has(field.key)) throw new Error(`${name} additional field ${fieldIndex + 1} has an unsupported Stremio field name.`);
      return {
        key: field.key,
        selector: asString(field.selector, `${name} additional field selector`, 200, true),
        attribute: asString(field.attribute || 'text', `${name} additional field attribute`, 40)
      };
    });
    return source;
  });

  return { version: 1, sources };
}
