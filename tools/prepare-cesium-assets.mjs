import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';

// The 3D theater loads Cesium's prebuilt bundle from /vendor, the same way the
// flat map self-hosts its MapLibre worker: no CDN, and nothing for Turbopack to
// transpile (the engine is ~6 MB of already-built JavaScript plus the workers,
// WASM decoders and imagery it fetches at runtime from a sibling path).
const root = new URL('../', import.meta.url);
const source = new URL('node_modules/cesium/', root);
const { version } = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
const vendor = new URL('public/vendor/cesium/', root);
const target = new URL(`${version}/`, vendor);

/* Unlike the MapLibre worker, this directory is NOT committed: it is 22 MB and
   every file in it is reproducible from the exact-pinned dependency. Every path
   that ships the console runs `npm run build`, whose prebuild step is this
   script, so a build can never go out without it. */
const staged = await stat(new URL('Cesium.js', target)).then(() => true, () => false);
if (!staged) {
  await mkdir(target, { recursive: true });
  for (const entry of ['Cesium.js', 'Assets', 'ThirdParty', 'Widgets', 'Workers']) {
    await cp(new URL(`Build/Cesium/${entry}`, source), new URL(entry, target), { recursive: true });
  }
  await cp(new URL('LICENSE.md', source), new URL('LICENSE.md', target));
  console.log(`prepare-cesium-assets: staged cesium ${version}`);
}

// Same reasoning as the map worker: a stale version directory surviving a bump
// is how a broken asset URL passes locally and 404s in production.
for (const entry of await readdir(vendor, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== version) {
    await rm(new URL(`${entry.name}/`, vendor), { recursive: true, force: true });
    console.log(`prepare-cesium-assets: pruned stale cesium ${entry.name}`);
  }
}
