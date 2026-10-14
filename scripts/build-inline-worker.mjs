import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedConfig = path.join(root, 'wrangler.inline.generated.toml');
const inlineAssetModule = path.join(root, 'worker', 'inline-assets.js');
const outputDir = process.argv[2] || await mkdtemp('/tmp/juzereel-inline-worker-');
const originalModule = await readFile(inlineAssetModule, 'utf8');
const configText = await readFile(path.join(root, 'wrangler.toml'), 'utf8');
const assets = {};

for (const file of ['index.html', 'api-response.js', 'config.js', 'config-template.json']) {
  assets[`/${file}`] = await readFile(path.join(root, 'site', file), 'utf8');
}

const buildConfig = configText.replace(/\n\[assets\][\s\S]*?(?=\n\[browser\]|\n\[\[|$)/, '');
if (buildConfig === configText) throw new Error('Could not remove the Wrangler assets binding for the inline build.');

try {
  await writeFile(inlineAssetModule, `export default ${JSON.stringify(assets)};\n`);
  await writeFile(generatedConfig, buildConfig);
  const code = await new Promise((resolve, reject) => {
    const child = spawn('npx', ['wrangler', 'deploy', '--dry-run', '--minify', '--config', generatedConfig, '--outdir', outputDir], {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit']
    });
    child.on('error', reject);
    child.on('exit', value => value === 0 ? resolve(value) : reject(new Error(`Wrangler exited with status ${value}.`)));
  });
  void code;
  console.log(path.join(outputDir, 'index.js'));
} finally {
  await writeFile(inlineAssetModule, originalModule);
  await rm(generatedConfig, { force: true });
}
