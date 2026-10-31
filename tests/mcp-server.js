const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const { readMesh, measureMesh } = require('../mcp/geometry');

const serverPath = path.resolve(__dirname, '..', 'mcp', 'server.js');

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
let client, cwd;

before(async () => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-mcp-test-'));
  const env = { ...process.env };
  if (openscad) env.OPENSCAD_PATH = openscad;
  client = new Client({ name: 'clawscad-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env, cwd }));
});

after(async () => {
  await client.close();
  fs.rmSync(cwd, { recursive: true, force: true });
});

const json = (result) => JSON.parse(result.content[0].text);

test('server lists the ClawSCAD tool set', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['check', 'export', 'measure', 'render_views', 'section']);
});

test('a tool rejects calls without exactly one source', async () => {
  const result = await client.callTool({ name: 'check', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /exactly one/);
});

withOpenSCAD('check accepts valid code', { timeout: 150000 }, async () => {
  const out = json(await client.callTool({ name: 'check', arguments: { code: 'cube(10);' } }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.diagnostics, []);
});

withOpenSCAD('check reports a syntax error with its line', { timeout: 150000 }, async () => {
  fs.writeFileSync(path.join(cwd, 'bad.scad'), '// broken\ncube(10)\nsphere(;\n');
  const out = json(await client.callTool({ name: 'check', arguments: { file: 'bad.scad' } }));
  assert.equal(out.ok, false);
  const error = out.diagnostics.find((d) => d.level === 'error');
  assert.ok(error, JSON.stringify(out));
  assert.equal(error.line, 3);
});

withOpenSCAD('measure reports bounding box, volume and shells', { timeout: 150000 }, async () => {
  const out = json(await client.callTool({ name: 'measure', arguments: { code: 'cube(10); translate([20,0,0]) cube(5);' } }));
  assert.deepEqual(out.bbox.size, [25, 10, 10]);
  assert.equal(out.volume, 1125);
  assert.equal(out.shells, 2);
  const cube = json(await client.callTool({ name: 'measure', arguments: { code: 'cube(10);' } }));
  assert.deepEqual(cube.bbox.size, [10, 10, 10]);
  assert.equal(cube.volume, 1000);
  assert.equal(cube.shells, 1);
});

withOpenSCAD('render_views and section return labelled PNG images', { timeout: 300000 }, async () => {
  const views = await client.callTool({ name: 'render_views', arguments: { code: 'cube(10);', views: ['iso', 'top'], size: 128 } });
  assert.deepEqual(views.content.map((c) => c.type), ['text', 'image', 'text', 'image']);
  assert.equal(Buffer.from(views.content[1].data, 'base64').subarray(1, 4).toString(), 'PNG');
  fs.writeFileSync(path.join(cwd, 'tube.scad'), 'difference() { cylinder(h=20, r=10); cylinder(h=50, r=6, center=true); }\n');
  const section = await client.callTool({ name: 'section', arguments: { file: 'tube.scad', axis: 'x', size: 128 } });
  assert.equal(section.isError, undefined, JSON.stringify(section));
  assert.equal(section.content[1].type, 'image');
});

withOpenSCAD('export writes the requested format', { timeout: 150000 }, async () => {
  const out = json(await client.callTool({ name: 'export', arguments: { code: 'cube(3);', format: '3mf', out: 'out/c.3mf' } }));
  assert.ok(out.bytes > 0);
  const mesh = readMesh(path.join(cwd, 'out', 'c.3mf'));
  assert.deepEqual(measureMesh(mesh).bbox.size, [3, 3, 3]);
});
