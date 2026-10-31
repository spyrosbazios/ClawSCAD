// ClawSCAD's OpenSCAD MCP server (stdio). Bundled to dist/mcp-server.js and
// registered in each workspace's .claude/settings.json by main.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { readMesh, measureMesh } = require('./geometry');
const { parse: parseParams } = require('./scad-params');

const OPENSCAD = process.env.OPENSCAD_PATH || process.env.OPENSCAD_BINARY || 'openscad';
const TIMEOUT_MS = 120000;

const VIEWS = {
  iso: { rot: [55, 0, 25], projection: 'perspective' },
  front: { rot: [90, 0, 0], projection: 'ortho' },
  back: { rot: [90, 0, 180], projection: 'ortho' },
  left: { rot: [90, 0, 270], projection: 'ortho' },
  right: { rot: [90, 0, 90], projection: 'ortho' },
  top: { rot: [0, 0, 0], projection: 'ortho' },
  bottom: { rot: [180, 0, 0], projection: 'ortho' },
};
// Section keeps the half-space below the plane; look at the cut face from the positive side.
const SECTION_VIEW = { x: 'right', y: 'back', z: 'top' };

class ToolFailure extends Error {}

function openscadEnv() {
  const env = { ...process.env };
  if (OPENSCAD.endsWith('.AppImage')) env.APPIMAGE_EXTRACT_AND_RUN = '1';
  // Inline code is evaluated from a temp file; keep workspace-relative include/use working.
  env.OPENSCADPATH = [process.cwd(), process.env.OPENSCADPATH].filter(Boolean).join(path.delimiter);
  return env;
}

// Manifold (OpenSCAD 2024+) is far faster than CGAL on boolean-heavy models.
// Probed once per server process; older binaries lack the flag.
let backendArgs;
function probeBackend() {
  backendArgs ??= new Promise((resolve) => {
    execFile(OPENSCAD, ['--help'], { timeout: TIMEOUT_MS, env: openscadEnv() }, (err, stdout, stderr) => {
      resolve(!err && /manifold/i.test(`${stdout}${stderr}`) ? ['--backend=Manifold'] : []);
    });
  });
  return backendArgs;
}

async function runOpenSCAD(args) {
  const backend = await probeBackend();
  return new Promise((resolve) => {
    execFile(OPENSCAD, [...args, ...backend], { timeout: TIMEOUT_MS, killSignal: 'SIGKILL', env: openscadEnv(), maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && (err.killed || err.signal)) {
          resolve({ ok: false, timeout: true, output: `timeout: OpenSCAD did not finish within ${TIMEOUT_MS / 1000} s` });
        } else if (err && typeof err.code === 'string') {
          resolve({ ok: false, timeout: false, output: `cannot run OpenSCAD (${OPENSCAD}): ${err.code}` });
        } else {
          resolve({ ok: !err, timeout: false, output: `${stdout}${stderr}` });
        }
      });
  });
}

// Matches e.g. `ERROR: Parser error: syntax error in file bad.scad, line 3`
// and `WARNING: Ignoring unknown variable "q" in file a.scad, line 2`.
function parseDiagnostics(output) {
  const out = [];
  const re = /^(ERROR|WARNING|TRACE):\s*(.*)$/gm;
  let m;
  while ((m = re.exec(output)) !== null) {
    const line = /line\s+(\d+)/.exec(m[2]);
    out.push({ level: m[1].toLowerCase(), message: m[2].trim(), line: line ? Number(line[1]) : null });
  }
  return out;
}

const sourceShape = {
  file: z.string().optional().describe('.scad file path, relative to the workspace'),
  code: z.string().optional().describe('Inline OpenSCAD code'),
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-mcp-'));
}

// Returns an absolute .scad path to feed OpenSCAD.
function resolveSource({ file, code }, dir) {
  if ((file === undefined) === (code === undefined)) throw new ToolFailure('Pass exactly one of `file` or `code`.');
  if (file !== undefined) {
    const abs = path.resolve(process.cwd(), file);
    if (!fs.existsSync(abs)) throw new ToolFailure(`File not found: ${file}`);
    return abs;
  }
  const abs = path.join(dir, 'input.scad');
  fs.writeFileSync(abs, code);
  return abs;
}

function text(value) {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) };
}

function failure(result) {
  const diagnostics = parseDiagnostics(result.output);
  return { isError: true, content: [text({ ok: false, timeout: result.timeout, diagnostics, output: result.output.slice(-2000) })] };
}

function cameraArgs(view, size) {
  const { rot, projection } = VIEWS[view];
  return [`--camera=0,0,0,${rot.join(',')},0`, '--viewall', '--autocenter', `--projection=${projection}`,
    `--imgsize=${size},${size}`, '--colorscheme=Tomorrow'];
}

async function renderPng(scadPath, view, size, dir, extra = []) {
  const png = path.join(dir, `${view}-${Math.random().toString(36).slice(2)}.png`);
  const result = await runOpenSCAD(['-o', png, ...extra, ...cameraArgs(view, size), scadPath]);
  if (!result.ok) return { result };
  return { result, data: fs.readFileSync(png).toString('base64') };
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Runs a tool body with a private temp dir and converts ToolFailure into an MCP error.
function handler(fn) {
  return async (args) => {
    const dir = tempDir();
    try {
      return await fn(args, dir);
    } catch (err) {
      if (err instanceof ToolFailure) return { isError: true, content: [text(err.message)] };
      throw err;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function measureSource(scadPath, dir) {
  const stl = path.join(dir, 'measure.stl');
  const result = await runOpenSCAD(['-o', stl, scadPath]);
  if (!result.ok) return { result };
  return { result, stats: measureMesh(readMesh(stl)) };
}

const server = new McpServer({ name: 'clawscad-openscad', version: '1.0.0' });

server.registerTool('check', {
  description: 'Fast syntax/evaluation check without building geometry. Run first after writing a .scad file; returns ERROR/WARNING lines.',
  inputSchema: sourceShape,
}, handler(async (args, dir) => {
  const scad = resolveSource(args, dir);
  const result = await runOpenSCAD(['-o', path.join(dir, 'out.csg'), scad]);
  if (result.timeout) return failure(result);
  const diagnostics = parseDiagnostics(result.output).filter((d) => d.level !== 'trace');
  const ok = result.ok && !diagnostics.some((d) => d.level === 'error');
  return { content: [text({ ok, diagnostics })] };
}));

server.registerTool('measure', {
  description: 'Build the mesh and report bounding box (min/max/size, mm), volume (mm^3), triangle count and disconnected shells. Use to verify dimensions against the request.',
  inputSchema: sourceShape,
}, handler(async (args, dir) => {
  const { result, stats } = await measureSource(resolveSource(args, dir), dir);
  if (!stats) return failure(result);
  const warnings = parseDiagnostics(result.output).filter((d) => d.level === 'warning');
  return { content: [text({ ...stats, units: 'mm', warnings })] };
}));

server.registerTool('render_views', {
  description: 'Render PNG images from standard camera angles. Use after measure to visually confirm shape, features and colors.',
  inputSchema: {
    ...sourceShape,
    views: z.array(z.enum(Object.keys(VIEWS))).optional().describe('Default ["iso","front","top","right"]'),
    size: z.number().int().min(64).max(2048).optional().describe('Image width/height in px, default 512'),
  },
}, handler(async (args, dir) => {
  const scad = resolveSource(args, dir);
  const views = args.views && args.views.length ? args.views : ['iso', 'front', 'top', 'right'];
  const size = args.size || 512;
  const renders = await mapLimited(views, 2, (view) => renderPng(scad, view, size, dir));
  const failed = renders.find((r) => !r.data);
  if (failed) return failure(failed.result);
  const content = [];
  renders.forEach((r, i) => {
    content.push(text(`View: ${views[i]}`));
    content.push({ type: 'image', data: r.data, mimeType: 'image/png' });
  });
  return { content };
}));

server.registerTool('section', {
  description: 'Cut the model with a plane and render the cut face. Use to inspect hidden internals: wall thickness, holes, cavities.',
  inputSchema: {
    ...sourceShape,
    axis: z.enum(['x', 'y', 'z']).describe('Plane normal; geometry with coordinate <= offset is kept'),
    offset: z.number().optional().describe('Plane position in mm, default 0'),
    size: z.number().int().min(64).max(2048).optional().describe('Image size in px, default 512'),
  },
}, handler(async (args, dir) => {
  const scad = resolveSource(args, dir);
  const body = `include <${scad.replace(/\\/g, '/')}>`;
  const offset = args.offset || 0;
  const big = 100000;
  const shift = { x: [offset - big, -big / 2, -big / 2], y: [-big / 2, offset - big, -big / 2], z: [-big / 2, -big / 2, offset - big] }[args.axis];
  const wrapper = path.join(dir, 'section.scad');
  fs.writeFileSync(wrapper, `intersection() {\n  union() {\n${body}\n  }\n  translate([${shift.join(',')}]) cube(${big});\n}\n`);
  const view = SECTION_VIEW[args.axis];
  // Preview mode frames the huge cutting cube; a full render frames only the result.
  // --render takes an optional value, so it must precede other --options, not the file.
  const r = await renderPng(wrapper, view, args.size || 512, dir, ['--render']);
  if (!r.data) return failure(r.result);
  return { content: [text(`Section ${args.axis} <= ${offset} mm, viewed from ${view}`), { type: 'image', data: r.data, mimeType: 'image/png' }] };
}));

server.registerTool('export', {
  description: 'Export the model to a file (stl, 3mf, amf, off, png). Use only when the user asks for an export.',
  inputSchema: {
    ...sourceShape,
    format: z.enum(['stl', '3mf', 'amf', 'off', 'png']),
    out: z.string().describe('Output path, relative to the workspace'),
  },
}, handler(async (args, dir) => {
  const scad = resolveSource(args, dir);
  const out = path.resolve(process.cwd(), args.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const extra = args.format === 'png' ? cameraArgs('iso', 1024) : [];
  const result = await runOpenSCAD(['-o', out, `--export-format=${args.format}`, ...extra, scad]);
  if (!result.ok || !fs.existsSync(out)) return failure(result);
  return { content: [text({ path: out, bytes: fs.statSync(out).size })] };
}));

server.registerTool('params', {
  description: 'List the model\'s Customizer parameters: top-level assignments before the first module/function, with /* [Group] */ sections and // [min:step:max] or // [a, b] annotations. Read-only; no render.',
  inputSchema: sourceShape,
}, handler(async (args, dir) => {
  const scad = resolveSource(args, dir);
  return { content: [text(parseParams(fs.readFileSync(scad, 'utf8')))] };
}));

server.connect(new StdioServerTransport()).catch((err) => {
  console.error('clawscad-openscad MCP server failed:', err);
  process.exit(1);
});
