import { mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourcePath = path.join(root, 'src', 'addon.json');
const outputPath = path.join(root, 'dist');
const checkOnly = process.argv.includes('--check');
const allowedTypes = new Set(['movie']);
const safeId = /^[A-Za-z0-9_-]+$/;
const errors = [];

function fail(message) {
  errors.push(message);
}

function assertHttps(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') fail(`${label} must use HTTPS.`);
  } catch {
    fail(`${label} must be a valid absolute URL.`);
  }
}

let config;
try {
  config = JSON.parse(await readFile(sourcePath, 'utf8'));
} catch (error) {
  console.error(`Could not read ${path.relative(root, sourcePath)}: ${error.message}`);
  process.exit(1);
}

const manifest = config.manifest;
if (!manifest || !manifest.id || !manifest.name || !manifest.version || !manifest.description) {
  fail('manifest must define id, name, version, and description.');
}
if (!Array.isArray(config.catalogs) || config.catalogs.length === 0) {
  fail('Define at least one catalog.');
}

const catalogIds = new Set();
const itemIds = new Set();
const types = new Set();
const streamIdsByType = new Map();
const routes = [];

for (const catalog of config.catalogs ?? []) {
  if (!allowedTypes.has(catalog.type)) {
    fail(`Catalog "${catalog.id ?? '(unknown)'}" has unsupported type "${catalog.type}". This starter currently supports movies.`);
    continue;
  }
  if (!catalog.id || !safeId.test(catalog.id)) fail(`Catalog id "${catalog.id}" must use only letters, numbers, _ or -.`);
  if (!catalog.name) fail(`Catalog "${catalog.id}" needs a name.`);
  if (!Array.isArray(catalog.items)) fail(`Catalog "${catalog.id}" needs an items array.`);
  if (catalogIds.has(catalog.id)) fail(`Duplicate catalog id "${catalog.id}".`);
  catalogIds.add(catalog.id);
  types.add(catalog.type);

  const metas = [];
  for (const item of catalog.items ?? []) {
    if (!item.id || !safeId.test(item.id)) fail(`Item id "${item.id}" must use only letters, numbers, _ or -.`);
    if (item.type !== catalog.type) fail(`Item "${item.id}" type must match catalog "${catalog.id}".`);
    if (!item.name) fail(`Item "${item.id}" needs a name.`);
    if (item.poster) assertHttps(item.poster, `Poster for "${item.id}"`);
    const itemKey = `${item.type}:${item.id}`;
    if (itemIds.has(itemKey)) fail(`Duplicate item id "${item.id}" for type "${item.type}".`);
    itemIds.add(itemKey);

    const meta = { id: item.id, type: item.type, name: item.name };
    for (const key of ['poster', 'background', 'logo', 'description', 'releaseInfo', 'runtime', 'imdbRating', 'genres']) {
      if (item[key] !== undefined) meta[key] = item[key];
    }
    metas.push(meta);

    const streams = item.streams ?? [];
    if (!Array.isArray(streams)) {
      fail(`Streams for "${item.id}" must be an array.`);
      continue;
    }
    if (streams.length) {
      if (!streamIdsByType.has(item.type)) streamIdsByType.set(item.type, new Set());
      streamIdsByType.get(item.type).add(item.id);
      for (const [index, stream] of streams.entries()) {
        assertHttps(stream.url, `Stream ${index + 1} for "${item.id}"`);
        if (!stream.name) stream.name = 'Source';
      }
      routes.push({ file: path.join('stream', item.type, `${item.id}.json`), data: { streams } });
    }
  }
  routes.push({ file: path.join('catalog', catalog.type, `${catalog.id}.json`), data: { metas } });
}

if (errors.length) {
  console.error(errors.map(message => `- ${message}`).join('\n'));
  process.exit(1);
}

const resources = [{ name: 'catalog', types: [...types] }];
for (const [type, ids] of streamIdsByType) {
  resources.push({ name: 'stream', types: [type], idPrefixes: [...ids] });
}

const outputManifest = {
  ...manifest,
  types: [...types],
  catalogs: config.catalogs.map(({ type, id, name, extra }) => ({ type, id, name, ...(extra ? { extra } : {}) })),
  resources
};

if (checkOnly) {
  console.log(`Validated ${config.catalogs.length} catalog(s), ${itemIds.size} item(s), and ${routes.filter(route => route.file.startsWith('stream/')).length} stream route(s).`);
  process.exit(0);
}

await rm(outputPath, { recursive: true, force: true });
await mkdir(outputPath, { recursive: true });
await cp(path.join(root, 'site', 'index.html'), path.join(outputPath, 'index.html'));
await cp(path.join(root, '.nojekyll'), path.join(outputPath, '.nojekyll'));
await writeFile(path.join(outputPath, 'manifest.json'), `${JSON.stringify(outputManifest, null, 2)}\n`);

for (const route of routes) {
  const destination = path.join(outputPath, route.file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(route.data, null, 2)}\n`);
}

console.log(`Built ${config.catalogs.length} catalog(s), ${itemIds.size} item(s), and ${routes.filter(route => route.file.startsWith('stream/')).length} stream route(s) in dist/.`);
