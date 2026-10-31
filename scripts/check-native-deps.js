// Fails if an installed native addon is not N-API. ClawSCAD does not rebuild
// native modules for Electron (no electron-rebuild), which is only safe because
// N-API binaries are ABI-stable across Node and Electron. A non-N-API addon
// would load under `npm start` yet throw on require() in the packaged app.
const fs = require('fs');
const path = require('path');

const MODULES = path.join(__dirname, '..', 'node_modules');

function packageDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => !n.startsWith('.')).flatMap((name) => {
    const full = path.join(dir, name);
    if (name.startsWith('@')) return packageDirs(full);
    if (!fs.existsSync(path.join(full, 'package.json'))) return [];
    return [full, ...packageDirs(path.join(full, 'node_modules'))];
  });
}

function isNative(dir) {
  return fs.existsSync(path.join(dir, 'binding.gyp')) || fs.existsSync(path.join(dir, 'prebuilds'));
}

function isNapi(pkg) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  return Boolean(deps['node-addon-api'] || deps['node-api-headers'] || (pkg.binary && pkg.binary.napi_versions));
}

if (!fs.existsSync(MODULES)) {
  process.stderr.write('node_modules is missing; run npm install first\n');
  process.exit(1);
}

const offenders = packageDirs(MODULES).filter(isNative).flatMap((dir) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return isNapi(pkg) ? [] : [`${pkg.name}@${pkg.version} (${path.relative(MODULES, dir)})`];
});

if (offenders.length) {
  process.stderr.write(`Native dependencies that are not N-API (would break the packaged Electron app):\n  ${offenders.join('\n  ')}\n`);
  process.exit(1);
}
