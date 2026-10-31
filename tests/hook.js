const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const hookPath = path.resolve(__dirname, '..', 'dist', 'clawscad-hook.js');

function findOpenSCAD() {
  const bin = process.env.OPENSCAD_BINARY || 'openscad';
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 60000, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' } });
    return bin;
  } catch {
    return null;
  }
}

const openscad = findOpenSCAD();
const withOpenSCAD = openscad ? test : test.skip;
let cwd, config;

before(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad hook test-'));
  config = path.join(cwd, 'hook config.json');
  fs.writeFileSync(config, JSON.stringify({ openscadPath: openscad || 'openscad' }));
});

after(() => fs.rmSync(cwd, { recursive: true, force: true }));

function runHook(input, configPath = config) {
  const res = spawnSync(process.execPath, [hookPath, configPath], { input: JSON.stringify(input), encoding: 'utf8', timeout: 120000 });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout ? JSON.parse(res.stdout) : null;
}

function writeEvent(file) {
  return { hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, file), content: '' } };
}

test('the hook bundle exists', () => assert.ok(fs.existsSync(hookPath), 'run npm run build first'));

test('non-.scad and out-of-workspace writes produce no output', () => {
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'x');
  assert.equal(runHook(writeEvent('notes.txt')), null);
  assert.equal(runHook({ ...writeEvent('x.scad'), tool_input: { file_path: path.join(os.tmpdir(), 'elsewhere.scad') } }), null);
});

test('a missing OpenSCAD binary is not reported to Claude', () => {
  fs.writeFileSync(path.join(cwd, 'any.scad'), 'cube(1);\n');
  const missing = path.join(cwd, 'missing.json');
  fs.writeFileSync(missing, JSON.stringify({ openscadPath: path.join(cwd, 'no-such-openscad') }));
  assert.equal(runHook(writeEvent('any.scad'), missing), null);
});

withOpenSCAD('a good file reports its measurements as additional context', () => {
  fs.writeFileSync(path.join(cwd, 'good.scad'), 'cube([10, 20, 5]);\n');
  const out = runHook(writeEvent('good.scad'));
  assert.equal(out.decision, undefined);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /good\.scad rendered OK\. bbox size 10×20×5 mm, volume 1000 mm³, 1 shell\./);
});

withOpenSCAD('a broken file blocks with line diagnostics', () => {
  fs.writeFileSync(path.join(cwd, 'bad.scad'), 'cube(10);\ncube(;\n');
  const out = runHook(writeEvent('bad.scad'));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /line 2/);
  assert.match(out.reason, /NEW fixed \.scad file/);
});
