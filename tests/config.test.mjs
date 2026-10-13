import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeConfig, encodeConfig, sanitizeConfig } from '../worker/config.js';

const validSource = {
  id: 'holidays',
  name: 'Holidays',
  pageUrl: 'https://memories.example/holidays/',
  itemSelector: '.video-card',
  titleSelector: '.title',
  titleAttribute: 'text',
  streamSelector: 'video source',
  streamAttribute: 'src',
  streamFromDetail: false,
  metaFields: [{ key: 'releaseInfo', selector: 'time', attribute: 'datetime' }]
};

test('configuration survives a URL-safe encode/decode round trip', () => {
  const config = { version: 1, sources: [{ ...validSource, name: 'Vacanze in Sicilia' }] };
  assert.deepEqual(decodeConfig(encodeConfig(config)), sanitizeConfig(config));
});

test('downloadable JSON starter template is valid and demonstrates multiple pages', async () => {
  const template = JSON.parse(await readFile(new URL('../site/config-template.json', import.meta.url), 'utf8'));
  const config = sanitizeConfig(template);
  assert.equal(config.sources.length, 2);
  assert.equal(config.sources[0].metaFields.length, 13);
  assert.equal(config.sources[1].id, 'parties');
});

test('configuration preserves multiple pages, selectors, attributes, and metadata fields', () => {
  const config = {
    version: 1,
    sources: [
      {
        ...validSource,
        name: 'Holidays',
        descriptionSelector: '.caption',
        descriptionAttribute: 'content',
        posterSelector: '.cover img',
        posterAttribute: 'data-src',
        detailLinkSelector: 'a.watch',
        detailLinkAttribute: 'href',
        streamFromDetail: true,
        metaFields: [
          { key: 'releaseInfo', selector: 'time', attribute: 'datetime' },
          { key: 'genres', selector: '.tag', attribute: 'text' }
        ]
      },
      {
        ...validSource,
        id: 'parties',
        name: 'Parties',
        pageUrl: 'https://memories.example/parties/',
        itemSelector: '.party',
        titleSelector: 'h2',
        titleAttribute: 'content',
        streamSelector: 'a.video',
        streamAttribute: 'href',
        streamFromDetail: false,
        metaFields: [{ key: 'cast', selector: '.people', attribute: 'content' }]
      }
    ]
  };

  const canonical = sanitizeConfig(config);
  assert.deepEqual(sanitizeConfig(JSON.parse(JSON.stringify(canonical))), canonical);
  assert.deepEqual(decodeConfig(encodeConfig(canonical)), canonical);
});

test('configuration rejects non-HTTPS pages and private hostnames', () => {
  assert.throws(() => sanitizeConfig({ version: 1, sources: [{ ...validSource, pageUrl: 'http://memories.example/' }] }), /HTTPS/);
  assert.throws(() => sanitizeConfig({ version: 1, sources: [{ ...validSource, pageUrl: 'https://localhost/' }] }), /public domain/);
  assert.throws(() => sanitizeConfig({ version: 1, sources: [{ ...validSource, pageUrl: 'https://192.168.1.4/' }] }), /public domain/);
});

test('configuration requires a video selector and a detail link for detail-page streams', () => {
  assert.throws(() => sanitizeConfig({ version: 1, sources: [{ ...validSource, streamSelector: '' }] }), /video URL selector/);
  assert.throws(() => sanitizeConfig({ version: 1, sources: [{ ...validSource, streamFromDetail: true }] }), /detail link selector/);
});

test('configuration limits sources and rejects duplicate identifiers', () => {
  assert.throws(() => sanitizeConfig({ version: 1, sources: Array.from({ length: 13 }, (_, i) => ({ ...validSource, id: `source-${i}`, name: `Source ${i}` })) }), /between 1 and 12/);
  assert.throws(() => sanitizeConfig({ version: 1, sources: [validSource, { ...validSource, name: 'Parties' }] }), /duplicated/);
  assert.throws(() => sanitizeConfig({ version: 1, sources: [{ ...validSource, metaFields: Array.from({ length: 14 }, (_, i) => ({ key: 'releaseInfo', selector: `.field-${i}` })) }] }), /up to 13 additional/);
});

