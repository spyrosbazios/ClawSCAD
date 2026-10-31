#!/usr/bin/env node
/**
 * Downloads the OpenSCAD libraries bundled with ClawSCAD into vendors/libs/.
 * Run manually:  node scripts/download-libs.js
 * Run for CI:    node scripts/download-libs.js --force
 *
 * vendors/libs ships as resources/libs and is exported as OPENSCADPATH.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { download } = require('./download-openscad');

const ROOT = path.join(__dirname, '..');
const LIBS_DIR = path.join(ROOT, 'vendors', 'libs');

const LIBS = [
  {
    name: 'BOSL2',
    tag: 'v2.0.779',
    url: 'https://github.com/BelfrySCAD/BOSL2/archive/refs/tags/v2.0.779.tar.gz',
    marker: 'std.scad',
    strip: ['tests', 'docs', 'examples', 'images', 'scripts', 'tutorials', '.github',
      'README.md', 'CONTRIBUTING.md', 'TESTING.md', 'WRITING_DOCS.md', 'CLAUDE.md'],
  },
];

async function install(lib, force) {
  const dest = path.join(LIBS_DIR, lib.name);
  if (!force && fs.existsSync(path.join(dest, lib.marker))) {
    console.log(`${lib.name} already present at vendors/libs — skipping (use --force to re-download).`);
    return;
  }
  // The archive is untrusted data: extract it into a fresh empty directory.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `clawscad-${lib.name}-`));
  try {
    const archive = path.join(work, 'lib.tar.gz');
    const out = path.join(work, 'out');
    fs.mkdirSync(out);
    console.log(`Downloading ${lib.name} ${lib.tag}...`);
    await download(lib.url, archive);
    execFileSync('tar', ['-xzf', archive, '-C', out]);
    const entries = fs.readdirSync(out);
    if (entries.length !== 1) throw new Error(`${lib.name} archive has an unexpected layout`);
    const src = path.join(out, entries[0]);
    if (!fs.existsSync(path.join(src, lib.marker))) {
      throw new Error(`${lib.name} archive does not contain ${lib.marker}`);
    }
    for (const dir of lib.strip) fs.rmSync(path.join(src, dir), { recursive: true, force: true });
    fs.mkdirSync(LIBS_DIR, { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true });
    console.log(`  → ${dest}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const force = process.argv.includes('--force');
  for (const lib of LIBS) await install(lib, force);
}

main().catch((e) => {
  console.error('\nLibrary download failed:', e.message);
  process.exit(1);
});
