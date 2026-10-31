const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const appRoot = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');

// Evaluate the actual main process code with Electron startup disabled and
// controllable child processes. File writes and the render queue remain real.
function loadBackend(overrides = {}) {
  const renders = [], timers = [], logs = [];
  const watcher = new EventEmitter();
  const mocks = {
    electron: {
      app: { isPackaged: false, getPath: () => os.tmpdir(), whenReady: () => ({ then() {} }), on() {} },
      ipcMain: { on() {}, handle() {} },
    },
    'node-pty': {},
    chokidar: { watch: () => watcher },
    child_process: {
      execFile: (bin, args, options, callback) => renders.push({ bin, args, options, callback }),
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = new EventEmitter();
        child.stdin.write = () => {};
        child.kill = () => {};
        children.push(child);
        return child;
      },
    },
    ...overrides,
  };
  const context = vm.createContext({
    require: (name) => mocks[name] || require(name.startsWith('./') ? path.join(appRoot, name) : name),
    __dirname: appRoot,
    process: { env: {}, platform: process.platform, argv: [], execPath: '/opt/ClawSCAD/clawscad' },
    console: { error: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
  });
  vm.runInContext(source + '\n;globalThis.backend = { writeClaudeMd, initWorkspace, startFileWatcher, processRenderQueue, OPENSCAD_BIN };', context);
  return { ...context.backend, renders, timers, logs, watcher };
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-backend-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function renderContext(dir, files) {
  const messages = [];
  return {
    workspaceDir: dir,
    renderQueue: files.map((file) => path.join(dir, file)),
    state: { active: null },
    window: { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (channel, data) => messages.push({ channel, data }) } },
    messages,
  };
}

// An ASCII STL of one triangle spanning 10 x 20 x 0 mm.
const MESH = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 20 0\nendloop\nendfacet\nendsolid t\n';

function completeRender(request, err = null, stderr = '') {
  if (!err) fs.writeFileSync(request.args[1], MESH);
  request.callback(err, '', stderr);
}

test('watcher errors are contained and later file events remain usable', () => {
  const backend = loadBackend();
  backend.startFileWatcher({ workspaceDir: 'workspace' });
  assert.doesNotThrow(() => backend.watcher.emit('error', new Error('ENOSPC')));
  assert.equal(backend.logs.length, 1);
  assert.doesNotThrow(() => backend.watcher.emit('change', 'notes.txt'));
});

test('CLAUDE.md preserves custom text while updating only its managed rules', (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'CLAUDE.md');
  const backend = loadBackend();
  const custom = '# My instructions\r\nUse our existing parts library.\r\n';
  fs.writeFileSync(file, custom);
  backend.writeClaudeMd({ workspaceDir: dir }, [dir]);
  const first = fs.readFileSync(file, 'utf8');
  assert.ok(first.endsWith(custom));
  const prefix = 'User notes before the block.\r\n';
  const suffix = '\r\nUser notes after the block.\r\n';
  fs.writeFileSync(file, prefix + first + suffix);
  const other = path.join(dir, 'other-project');
  backend.writeClaudeMd({ workspaceDir: dir }, [dir, other]);
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.startsWith(prefix));
  assert.ok(updated.endsWith(custom + suffix));
  assert.ok(updated.includes(other));
  assert.equal(updated.split('<!-- clawscad:rules:start -->').length - 1, 1);
  backend.writeClaudeMd({ workspaceDir: dir }, [dir, other]);
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
});

test('CLAUDE.md read failures do not overwrite an unreadable custom file', (t) => {
  const dir = workspace(t);
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, 'Custom rules');
  const backend = loadBackend({ fs: {
    ...fs,
    readFileSync: (target, ...args) => {
      if (target === file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.readFileSync(target, ...args);
    },
  } });
  assert.throws(() => backend.writeClaudeMd({ workspaceDir: dir }, [dir]), /denied/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'Custom rules');
});

test('a fresh workspace receives exactly one managed CLAUDE.md block', (t) => {
  const dir = workspace(t);
  const backend = loadBackend();
  backend.writeClaudeMd({ workspaceDir: dir }, [dir]);
  backend.writeClaudeMd({ workspaceDir: dir }, [dir]);
  const text = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
  assert.equal(text.split('<!-- clawscad:rules:start -->').length - 1, 1);
  assert.ok(text.includes('`render_views`'));
  assert.ok(!text.includes('render_perspectives'));
});

test('an STL fallback is limited to its model and the next model uses 3MF', (t) => {
  const backend = loadBackend();
  const dir = workspace(t);
  const ctx = renderContext(dir, ['first.scad', 'second.scad']);
  backend.processRenderQueue(ctx);
  completeRender(backend.renders[0], Object.assign(new Error('3MF failed'), { code: 1 }));
  completeRender(backend.renders[1]);
  completeRender(backend.renders[2]);
  assert.deepEqual(backend.renders.map((r) => path.extname(r.args[1])), ['.3mf', '.stl', '.3mf']);
  assert.deepEqual(ctx.messages.filter((m) => m.channel === 'model:update').map((m) => m.data.format), ['stl', '3mf']);
  assert.equal(ctx.stlFallbackFor, null);
  assert.equal(ctx.isRendering, false);
});

for (const [code, properties, fault] of [
  ['ENOENT', {}, 'environment'], ['EACCES', {}, 'environment'], ['EPERM', {}, 'environment'],
  ['ETIMEDOUT', {}, 'timeout'], [null, { killed: true, signal: 'SIGTERM' }, 'timeout'],
]) {
  test(`${code || 'terminated render'} does not retry or ask Claude to rewrite the model`, (t) => {
    const backend = loadBackend();
    const dir = workspace(t);
    const ctx = renderContext(dir, ['model.scad']);
    ctx.ptyProcess = { write: () => assert.fail('unexpected Claude input') };
    backend.processRenderQueue(ctx);
    completeRender(backend.renders[0], Object.assign(new Error('render failed'), { code, ...properties }));
    assert.equal(backend.renders.length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'RENDER_ERRORS.md')), false);
    assert.equal(backend.timers.length, 0);
    assert.equal(ctx.messages.find((m) => m.channel === 'render:error').data.fault, fault);
    assert.equal(ctx.isRendering, false);
  });
}

test('a genuine model error writes the error report without typing into Claude', (t) => {
  const backend = loadBackend();
  const dir = workspace(t);
  const ctx = renderContext(dir, ['broken.scad']);
  ctx.ptyProcess = { write: () => assert.fail('unexpected Claude input') };
  backend.processRenderQueue(ctx);
  const err = Object.assign(new Error('parser error'), { code: 1 });
  completeRender(backend.renders[0], err, 'ERROR: syntax error');
  completeRender(backend.renders[1], err, 'ERROR: syntax error');
  assert.match(fs.readFileSync(path.join(dir, 'RENDER_ERRORS.md'), 'utf8'), /syntax error/);
  assert.equal(backend.timers.length, 0);
  assert.equal(ctx.messages.find((m) => m.channel === 'render:error').data.fault, 'model');
  assert.equal(ctx.stlFallbackFor, null);
});

test('renders run with OPENSCADPATH pointing at the bundled libs', (t) => {
  const backend = loadBackend();
  const dir = workspace(t);
  backend.processRenderQueue(renderContext(dir, ['model.scad']));
  const { env } = backend.renders[0].options;
  assert.equal(env.OPENSCADPATH.split(path.delimiter)[0], path.join(appRoot, 'vendors', 'libs'));
});

const libsDir = path.join(appRoot, 'vendors', 'libs');
const openscadBin = process.env.OPENSCAD_BINARY;
const canRenderBosl = fs.existsSync(path.join(libsDir, 'BOSL2', 'std.scad')) && Boolean(openscadBin) && fs.existsSync(openscadBin);
test('BOSL2 renders through OPENSCADPATH', { skip: !canRenderBosl && 'needs vendors/libs/BOSL2 and OPENSCAD_BINARY' }, async (t) => {
  const dir = workspace(t);
  const scad = path.join(dir, 'bosl.scad');
  const stl = path.join(dir, 'bosl.stl');
  fs.writeFileSync(scad, 'include <BOSL2/std.scad>\ncuboid(10, rounding=2);\n');
  const env = { ...process.env, OPENSCADPATH: libsDir, APPIMAGE_EXTRACT_AND_RUN: '1' };
  await new Promise((resolve, reject) => {
    execFile(openscadBin, ['-o', stl, scad], { env, timeout: 120000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
  assert.ok(fs.statSync(stl).size > 0);
});

test('the main process no longer carries its own MCP client', () => {
  assert.ok(!/McpClient|mcpClient|openscad-mcp-server/.test(source));
  const preload = fs.readFileSync(path.join(appRoot, 'preload.js'), 'utf8');
  assert.ok(!/mcp/i.test(preload));
});

test('writeRenderErrors no longer types into the Claude terminal', () => {
  const body = source.slice(source.indexOf('function writeRenderErrors'), source.indexOf('function clearRenderErrors'));
  assert.ok(body.length > 0);
  assert.ok(!/ptyProcess|setTimeout/.test(body));
});

test('initWorkspace registers the bundled MCP server and hook and keeps other settings', (t) => {
  const dir = workspace(t);
  const settingsFile = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile));
  const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] };
  const staleHook = { matcher: 'Write', hooks: [{ type: 'command', command: 'node /old/clawscad-hook.js' }] };
  fs.writeFileSync(settingsFile, JSON.stringify({
    model: 'opus',
    mcpServers: { other: { command: 'x' }, openscad: { command: 'npx' } },
    hooks: { PostToolUse: [userHook, staleHook], Stop: [userHook] },
  }));
  const backend = loadBackend();
  backend.initWorkspace({ workspaceDir: dir });
  backend.initWorkspace({ workspaceDir: dir });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hookConfig = path.join(dir, '.claude', 'clawscad-hook.json');
  assert.deepEqual(settings.hooks.Stop, [userHook]);
  assert.deepEqual(settings.hooks.PostToolUse, [userHook, {
    matcher: 'Write|Edit|MultiEdit',
    hooks: [{
      type: 'command',
      command: `ELECTRON_RUN_AS_NODE=1 '/opt/ClawSCAD/clawscad' '${path.join(appRoot, 'dist', 'clawscad-hook.js')}' '${hookConfig}'`,
      timeout: 90,
    }],
  }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(hookConfig, 'utf8')), {
    openscadPath: backend.OPENSCAD_BIN, openscadLibPath: path.join(appRoot, 'vendors', 'libs'),
  });
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.mcpServers.other, { command: 'x' });
  assert.deepEqual(settings.mcpServers.openscad, {
    command: '/opt/ClawSCAD/clawscad',
    args: [path.join(appRoot, 'dist', 'mcp-server.js')],
    env: { ELECTRON_RUN_AS_NODE: '1', OPENSCAD_PATH: backend.OPENSCAD_BIN, OPENSCADPATH: path.join(appRoot, 'vendors', 'libs') },
  });
});

test('a successful render writes RENDER_STATUS.md and a failure removes it', (t) => {
  const backend = loadBackend();
  const dir = workspace(t);
  const ctx = renderContext(dir, ['good.scad', 'bad.scad']);
  ctx.ptyProcess = { write() {} };
  backend.processRenderQueue(ctx);
  // 3MF fails, so the bbox is read from the STL fallback.
  completeRender(backend.renders[0], Object.assign(new Error('3MF failed'), { code: 1 }));
  completeRender(backend.renders[1]);
  const status = fs.readFileSync(path.join(dir, 'RENDER_STATUS.md'), 'utf8');
  assert.match(status, /good\.scad/);
  assert.match(status, /Size: 10 x 20 x 0 mm/);
  const err = Object.assign(new Error('parser error'), { code: 1 });
  completeRender(backend.renders[2], err, 'ERROR: syntax error');
  completeRender(backend.renders[3], err, 'ERROR: syntax error');
  assert.equal(fs.existsSync(path.join(dir, 'RENDER_STATUS.md')), false);
  assert.ok(fs.existsSync(path.join(dir, 'RENDER_ERRORS.md')));
});
