const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const chokidar = require('chokidar');
const { execFile } = require('child_process');
const { readMesh, measureMesh } = require('./mcp/geometry');

// Resolve the OpenSCAD binary: prefer bundled copy, fall back to env / system.
// In packaged builds, extraResources lands at process.resourcesPath.
// In dev, look in the repo's vendors/ directory (populated by download-openscad.js).
function resourcesBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, 'vendors');
}

function resolveOpenSCAD() {
  const base = resourcesBase();
  const candidates = {
    linux:  path.join(base, 'openscad-linux.AppImage'),
    darwin: path.join(base, 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'),
    win32:  path.join(base, 'openscad-win', 'openscad.exe'),
  };
  const bundled = candidates[process.platform];
  if (bundled && fs.existsSync(bundled)) return bundled;
  return process.env.OPENSCAD_BINARY || 'openscad';
}
const OPENSCAD_BIN = resolveOpenSCAD();

// Bundled OpenSCAD libraries (BOSL2), resolved like the binary and populated
// by scripts/download-libs.js.
const OPENSCAD_LIBS = path.join(resourcesBase(), 'libs');

// OPENSCADPATH with the bundled libs first, keeping any user-configured paths.
function openscadPath() {
  const existing = process.env.OPENSCADPATH;
  return existing ? OPENSCAD_LIBS + path.delimiter + existing : OPENSCAD_LIBS;
}
// ClawSCAD's own MCP server, bundled by `npm run build` (mcp/server.js -> dist/mcp-server.js).
const MCP_SERVER = app.isPackaged
  ? path.join(process.resourcesPath, 'dist', 'mcp-server.js')
  : path.join(__dirname, 'dist', 'mcp-server.js');

// Resolve the Claude Code CLI binary. Checks the standalone installer location
// (~/.claude/local/claude), user/system PATH, and other common install paths.
// Returns null if not found — startTerminal will auto-install via npm in that case.
let _claudeBin = null;
function resolveClaude() {
  if (_claudeBin) return _claudeBin;
  const candidates = [
    path.join(os.homedir(), '.claude', 'local', 'claude'), // standalone installer
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/usr/local/bin/claude',
  ];
  // Search every directory on this process's PATH (catches npm global and others)
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    candidates.push(path.join(dir, 'claude'));
  }
  // On Windows the executable is claude.exe (standalone / ~/.local/bin) or
  // claude.cmd (npm global), so probe platform extensions before the bare name.
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const c of candidates) {
    for (const ext of exts) {
      try { if (fs.existsSync(c + ext)) { _claudeBin = c + ext; return c + ext; } } catch {}
    }
  }
  return null;
}

// Interactive shell to fall back to when Claude can't be launched. On Windows
// process.env.SHELL is unset, so a bare '/bin/bash' fallback would fail to spawn.
const DEFAULT_SHELL = process.platform === 'win32'
  ? (process.env.COMSPEC || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');

// Extra env vars needed when running OpenSCAD on specific platforms.
// On Linux, APPIMAGE_EXTRACT_AND_RUN=1 lets a bundled AppImage run inside
// the Electron AppImage without needing nested FUSE mounts.
function openscadEnv() {
  const env = { ...process.env, OPENSCADPATH: openscadPath() };
  if (process.platform === 'linux' && OPENSCAD_BIN.endsWith('.AppImage')) {
    env.APPIMAGE_EXTRACT_AND_RUN = '1';
  }
  return env;
}

// Manifold (OpenSCAD 2024+) is orders of magnitude faster than CGAL on
// boolean-heavy models. Probed once at startup; older binaries lack the flag.
let manifoldSupported = false;
function detectManifold() {
  return new Promise((resolve) => {
    execFile(OPENSCAD_BIN, ['--help'], { timeout: 30000, env: openscadEnv() }, (err, stdout, stderr) => {
      manifoldSupported = !err && /manifold/i.test(`${stdout}${stderr}`);
      resolve(manifoldSupported);
    });
  });
}
function backendArgs() {
  return manifoldSupported ? ['--backend=Manifold'] : [];
}
const STATE_FILE = 'clawscad.json';
const ACTIVE_FILE = 'active.scad';
const MAX_WINDOWS = 4;

// ── Multi-Window State ──────────────────────────────────────────────────
// Each BrowserWindow gets its own context: workspace, checkpoints, pty, watcher.
// Claude in each window sees all other open workspaces via CLAUDE.md.

const windows = new Map(); // webContents.id -> ctx

function getCtx(event) {
  return windows.get(event.sender.id);
}

// ── Open / Close Windows ────────────────────────────────────────────────

function openWindow(wsDir) {
  if (windows.size >= MAX_WINDOWS) return null;

  wsDir = wsDir || path.join(os.homedir(), 'clawscad-workspace');

  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    title: 'ClawSCAD',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0d0d1a',
    icon: path.join(__dirname, 'icon.png'),
  });

  Menu.setApplicationMenu(null);

  const ctx = {
    window: win,
    workspaceDir: wsDir,
    state: { checkpoints: {}, active: null },
    fileWatcher: null,
    ptyProcess: null,
    renderQueue: [],
    isRendering: false,
    stlFallbackFor: null,
  };

  const wcId = win.webContents.id;
  windows.set(wcId, ctx);

  win.loadFile('index.html');

  initWorkspace(ctx);
  loadState(ctx);
  startTerminal(ctx);
  startFileWatcher(ctx);

  win.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);

  win.webContents.once('did-finish-load', () => {
    sendCheckpoints(ctx);
    if (ctx.state.active && ctx.state.checkpoints[ctx.state.active]) {
      const cp = ctx.state.checkpoints[ctx.state.active];
      sendFileContent(ctx, cp.file);
      const scadPath = path.join(ctx.workspaceDir, cp.file);
      const tmfPath = scadPath.replace(/\.scad$/, '.3mf');
      const stlPath = scadToStl(scadPath);
      if (fs.existsSync(tmfPath)) {
        sendModel(ctx, tmfPath, '3mf');
      } else if (fs.existsSync(stlPath)) {
        sendModel(ctx, stlPath, 'stl');
      } else {
        enqueueRender(ctx, scadPath);
      }
    }
  });

  win.on('closed', () => {
    if (ctx.fileWatcher) ctx.fileWatcher.close();
    if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
    if (ctx.ptyProcess2) try { ctx.ptyProcess2.kill(); } catch {}
    ctx.window = null; // Mark as destroyed so ctxSend won't touch it
    windows.delete(wcId);
    updateAllClaudeMd();
  });

  updateAllClaudeMd();
  addRecentPath(wsDir);
  return ctx;
}

// ── Workspace Init ──────────────────────────────────────────────────────

const CLAUDE_MD_RULES = `## File Rules (NEVER break these)
- **NEVER modify or overwrite an existing .scad file.** Every .scad file is an immutable checkpoint. Overwriting one destroys the user's version history. Always create a NEW file.
- **Name each .scad file** with a short creative descriptive name in kebab-case (max 30 characters, no sequential numbers). The name should hint at what changed. Good: \`hollow-shaft-gear.scad\`, \`rounded-blue-body.scad\`, \`tapered-legs-v2.scad\`. Bad: \`model_003.scad\`, \`update.scad\`.
- **First line of every .scad file MUST be a comment** describing what this version adds or changes, e.g.: \`// Hollowed center, added 6 bolt holes around the flange\`. This is shown to the user as a tooltip in the checkpoint history.

## Colors — use them extensively
OpenSCAD's \`color()\` function is fully supported. **Color every part** of your models to make them visually clear:
\`\`\`scad
color("SteelBlue") body();
color([0.8, 0.2, 0.1]) accent_ring();
color("#44cc88", 0.8) transparent_cover();
\`\`\`
Supported formats: named colors (CSS/SVG names like "Red", "SteelBlue", "Gold"), \`[r,g,b]\` floats 0-1, \`[r,g,b,a]\` with alpha, hex \`"#rrggbb"\`, \`"#rrggbbaa"\`.
When the user asks to change colors, create a new file (never modify the old one) with the color changes.

## Libraries
BOSL2 is pre-installed (on \`OPENSCADPATH\`). **Prefer BOSL2 over hand-rolled \`hull()\`/\`minkowski()\` rounding** — it is faster to render and parametric by design.
\`\`\`scad
include <BOSL2/std.scad>       // shapes, attachments, rounding, sweeps
include <BOSL2/screws.scad>    // screw_hole(), screw()
include <BOSL2/threading.scad> // threaded_rod(), threaded_nut()
include <BOSL2/gears.scad>     // spur_gear(), rack()
\`\`\`
- \`cuboid(size, rounding=, chamfer=, edges=, anchor=)\` — box with rounded/chamfered edges; \`size\` is a scalar or \`[x,y,z]\`
- \`cyl(h, d=, rounding=, chamfer=, anchor=)\` — cylinder with rounded/chamfered ends (\`d1=\`/\`d2=\` for cones)
- \`tube(h, od=, id=, wall=, anchor=)\` — hollow cylinder; give two of od/id/wall
- \`prismoid(size1, size2, h, shift=, rounding=, chamfer=)\` — tapered box (\`size1\`/\`size2\` are bottom/top \`[x,y]\`)
- \`screw_hole("M3", length=, head="socket", counterbore=, oversize=, teardrop=)\` — clearance/threaded holes by spec
- \`threaded_rod(d, l, pitch, internal=)\` — ISO-style thread; \`internal=true\` for a nut cavity
- \`spur_gear(mod=, teeth=, thickness=, shaft_diam=)\` — gears that mesh when \`mod\` matches
- \`linear_sweep(region, height)\` — extrude a 2D path/region with BOSL2 anchors
- \`offset_sweep(path, height, bottom=os_circle(r=), top=os_chamfer(height=))\` — extrude with rounded/chamfered top/bottom edges
- **Attachments**: every BOSL2 shape has anchors (\`TOP\`, \`BOT\`, \`LEFT\`, \`FRONT+RIGHT\`, ...). \`anchor=BOT\` places the shape on the build plate; \`parent() attach(TOP) child();\` stacks a child on a face; \`position(TOP+LEFT) child();\` places without reorienting.
- **Subtraction**: \`diff() cuboid(20) tag("remove") attach(TOP) cyl(h=5, d=6);\` — tagged children are subtracted from the parent, so holes stay attached to the feature they cut.

## Parametric design (required)
Every .scad file has this structure — parameter block, then modules, then **one** top-level call:
\`\`\`scad
// Wall-mount bracket with two M4 holes
include <BOSL2/std.scad>
/* [Dimensions] */
width = 40;      // [20:1:100]
height = 30;     // [10:1:80]
wall = 2.4;      // [1.6:0.4:5]
/* [Fit] */
clearance = 0.25; // [0.1:0.05:0.5]
/* [Hidden] */
$fa = 2; $fs = 0.5;
hole_d = 4 + 2 * clearance;  // derived, never a duplicated literal
module bracket() { /* ... uses only the parameters above ... */ }
bracket();
\`\`\`
- Use Customizer syntax: \`/* [Group] */\` comments, \`// [min:step:max]\` ranges, \`/* [Hidden] */\` for derived values and \`$fa\`/\`$fs\`.
- Compute every derived value from parameters; never repeat a magic number. Changing one parameter must keep the part valid.
- FDM defaults: wall ≥ 1.6 mm (4 perimeters at 0.4 nozzle); clearance 0.2–0.3 mm for sliding fits, 0.1 mm for press fits; minimum feature 0.8 mm; overhangs ≤ 45° or chamfer them (use \`teardrop=true\` for horizontal holes).
- Smoothness via \`$fa = 2; $fs = 0.5;\` — never a giant global \`$fn\`.

## Workflow
1. Read \`active.scad\` to understand the current model.
2. Write a NEW .scad file (never modify an existing one).
3. Verify with the \`openscad\` MCP tools, in this order:
   1. \`check\` — fix every ERROR and WARNING.
   2. \`measure\` — compare bbox size (mm) with the requested dimensions; \`shells\` > 1 means disconnected parts.
   3. \`render_views\` — look at the images; confirm shape, features and colors.
4. If anything is wrong, write another NEW file with the fix and repeat step 3. Present only verified models.

## MCP Tools (\`openscad\` server)
Every tool takes \`file\` (workspace-relative path) OR \`code\` (inline OpenSCAD), never both.
- \`check\` — fast parse/evaluate; returns \`ok\` and \`diagnostics\` [{level, message, line}].
- \`measure\` — bbox {min,max,size}, volume (mm³), triangles, shells.
- \`render_views\` — PNGs; \`views\` from front|back|left|right|top|bottom|iso (default iso,front,top,right), \`size\` px (default 512).
- \`section\` — cut at \`axis\` x|y|z, \`offset\` mm; inspect walls, holes, cavities.
- \`export\` — \`format\` stl|3mf|amf|off|png to \`out\`; only when the user asks.

## Auto-Iteration
ClawSCAD renders every new .scad file itself:
- Success: \`RENDER_STATUS.md\` shows the file and its bounding box.
- Failure: errors go to \`RENDER_ERRORS.md\` and you are asked to fix them. Read it and write a NEW fixed file; keep going until the render is clean.`;

function updateAllClaudeMd() {
  // Filter out destroyed windows
  const live = Array.from(windows.values()).filter((c) => c.window !== null);
  const allWorkspaces = live.map((c) => c.workspaceDir);
  for (const ctx of live) {
    try { writeClaudeMd(ctx, allWorkspaces); } catch {}
  }
}

const CLAUDE_MD_START = '<!-- clawscad:rules:start -->';
const CLAUDE_MD_END = '<!-- clawscad:rules:end -->';

function buildClaudeMdBlock(ctx, allWorkspaces) {
  const others = allWorkspaces.filter((w) => w !== ctx.workspaceDir);
  let md = `# ClawSCAD Workspace — MANDATORY RULES\n\n${CLAUDE_MD_RULES}\n`;

  if (others.length > 0) {
    md += `\n## Multi-Project Context\n`;
    md += `ClawSCAD currently has ${allWorkspaces.length} projects open. You can reference designs across projects:\n`;
    for (const w of allWorkspaces) {
      const label = path.basename(w);
      if (w === ctx.workspaceDir) {
        md += `- **This workspace** (${label}): \`${w}\`\n`;
      } else {
        md += `- ${label}: \`${w}\`\n`;
      }
    }
    md += `\nTo import a part from another project:\n\`\`\`scad\nuse <${others[0]}/filename.scad>\n\`\`\`\n`;
    md += `You can read any file from these paths. If the user asks you to combine or reference designs from other projects, read the relevant .scad files directly.\n`;
  }

  return md.replace(/\n+$/, '');
}

function writeClaudeMd(ctx, allWorkspaces) {
  const filePath = path.join(ctx.workspaceDir, 'CLAUDE.md');
  const managed = `${CLAUDE_MD_START}\n${buildClaudeMdBlock(ctx, allWorkspaces)}\n${CLAUDE_MD_END}`;
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const start = existing.indexOf(CLAUDE_MD_START);
  const end = existing.indexOf(CLAUDE_MD_END, start + CLAUDE_MD_START.length);
  const output = start !== -1 && end !== -1
    ? existing.slice(0, start) + managed + existing.slice(end + CLAUDE_MD_END.length)
    : managed + (existing ? '\n\n' + existing : '\n');
  fs.writeFileSync(filePath, output);
}

function initWorkspace(ctx) {
  fs.mkdirSync(ctx.workspaceDir, { recursive: true });

  // MCP server config — merge into existing settings
  const claudeDir = path.join(ctx.workspaceDir, '.claude');
  const settingsFile = path.join(claudeDir, 'settings.json');
  fs.mkdirSync(claudeDir, { recursive: true });
  let settings = {};
  try {
    if (fs.existsSync(settingsFile)) {
      settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    }
  } catch {}
  if (!settings.mcpServers) settings.mcpServers = {};
  // Electron's own binary runs the bundled server as plain Node, so no system Node is needed.
  settings.mcpServers.openscad = {
    command: process.execPath,
    args: [MCP_SERVER],
    env: { ELECTRON_RUN_AS_NODE: '1', OPENSCAD_PATH: OPENSCAD_BIN, OPENSCADPATH: openscadPath() },
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// ── State Management ────────────────────────────────────────────────────

function statePath(ctx) {
  return path.join(ctx.workspaceDir, STATE_FILE);
}

function loadState(ctx) {
  try {
    if (fs.existsSync(statePath(ctx))) {
      ctx.state = JSON.parse(fs.readFileSync(statePath(ctx), 'utf-8'));
    }
  } catch {
    ctx.state = { checkpoints: {}, active: null };
  }
}

function saveState(ctx) {
  fs.writeFileSync(statePath(ctx), JSON.stringify(ctx.state, null, 2));
}

function generateId() {
  return 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function extractDescription(scadPath) {
  try {
    const content = fs.readFileSync(scadPath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) {
        const comment = trimmed.slice(2).trim();
        if (comment.length > 0) return comment;
      }
      if (trimmed.length > 0 && !trimmed.startsWith('//')) break;
    }
  } catch {}
  return '';
}

function getEncodedCwd(dir) {
  return dir.replace(/\//g, '-').replace(/^-/, '');
}

function detectCurrentSessionId(ctx) {
  const encoded = getEncodedCwd(ctx.workspaceDir);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  try {
    if (!fs.existsSync(projectDir)) return null;
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({
        name: path.basename(f, '.jsonl'),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].name : null;
  } catch {
    return null;
  }
}

function addCheckpoint(ctx, scadFile) {
  const basename = path.basename(scadFile);

  const existing = Object.values(ctx.state.checkpoints).find((c) => c.file === basename);
  if (existing) return;
  if (basename === ACTIVE_FILE) return;

  const description = extractDescription(scadFile);
  const sessionId = detectCurrentSessionId(ctx);

  const id = generateId();
  ctx.state.checkpoints[id] = {
    file: basename,
    parent: ctx.state.active,
    label: path.basename(basename, '.scad').replace(/[_-]/g, ' ').substring(0, 30),
    description,
    sessionId,
    created: new Date().toISOString(),
  };

  ctx.state.active = id;
  saveState(ctx);
  copyToActive(ctx, basename);
  sendCheckpoints(ctx);
  sendFileContent(ctx, basename);

  return id;
}

function selectCheckpoint(ctx, id) {
  if (!ctx.state.checkpoints[id]) return;
  ctx.state.active = id;
  saveState(ctx);

  const cp = ctx.state.checkpoints[id];
  copyToActive(ctx, cp.file);
  sendCheckpoints(ctx);
  sendFileContent(ctx, cp.file);

  const scadPath = path.join(ctx.workspaceDir, cp.file);
  const tmfPath = scadPath.replace(/\.scad$/, '.3mf');
  const stlPath = scadToStl(scadPath);
  if (fs.existsSync(tmfPath)) {
    sendModel(ctx, tmfPath, '3mf');
  } else if (fs.existsSync(stlPath)) {
    sendModel(ctx, stlPath, 'stl');
  } else {
    enqueueRender(ctx, scadPath);
  }
}

function copyToActive(ctx, scadFilename) {
  const src = path.join(ctx.workspaceDir, scadFilename);
  const dst = path.join(ctx.workspaceDir, ACTIVE_FILE);
  try { fs.copyFileSync(src, dst); } catch {}
}

function sendCheckpoints(ctx) {
  ctxSend(ctx, 'checkpoint:update', ctx.state);
}

// ── Render Queue ────────────────────────────────────────────────────────

function enqueueRender(ctx, scadPath) {
  ctx.renderQueue = ctx.renderQueue.filter((p) => p !== scadPath);
  ctx.renderQueue.push(scadPath);
  processRenderQueue(ctx);
}

function processRenderQueue(ctx) {
  if (ctx.isRendering || ctx.renderQueue.length === 0) return;
  ctx.isRendering = true;
  const scadPath = ctx.renderQueue.shift();
  // A 3MF failure affects only this file; later models still retain colour.
  const format = ctx.stlFallbackFor === scadPath ? 'stl' : '3mf';
  const outputExt = format === '3mf' ? '.3mf' : '.stl';
  const outputPath = scadPath.replace(/\.scad$/, outputExt);

  ctxSend(ctx, 'render:start', { file: path.basename(scadPath) });

  execFile(OPENSCAD_BIN, ['-o', outputPath, scadPath, ...backendArgs()], { timeout: 120000, env: openscadEnv() }, (err, stdout, stderr) => {
    ctx.isRendering = false;

    const fault = classifyRenderFailure(err, outputPath);
    if (fault) {
      if (format === '3mf' && fault === 'model') {
        ctx.stlFallbackFor = scadPath;
        ctx.renderQueue.unshift(scadPath);
        processRenderQueue(ctx);
        return;
      }
      ctx.stlFallbackFor = null;
      clearRenderStatus(ctx);
      const errorText = stderr || (err && err.message) || 'OpenSCAD produced no model';
      const errors = parseOpenSCADErrors(errorText);
      ctxSend(ctx, 'render:error', {
        file: path.basename(scadPath),
        error: errorText,
        errors,
        fault,
      });
      // Installation faults and timeouts do not mean the model needs rewriting.
      if (fault === 'model') writeRenderErrors(ctx, path.basename(scadPath), errorText, errors);
    } else {
      ctx.stlFallbackFor = null;
      if (stderr && stderr.includes('WARNING')) {
        ctxSend(ctx, 'render:warning', { file: path.basename(scadPath), warnings: stderr });
      }
      sendModel(ctx, outputPath, format);
      ctxSend(ctx, 'render:complete', { file: path.basename(scadPath) });
      clearRenderErrors(ctx);
      writeRenderStatus(ctx, path.basename(scadPath), outputPath);
    }

    processRenderQueue(ctx);
  });
}

function classifyRenderFailure(err, outputPath) {
  if (err) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(err.code)) return 'environment';
    if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') return 'timeout';
    return 'model';
  }
  try {
    const output = fs.statSync(outputPath);
    return output.isFile() && output.size > 0 ? null : 'model';
  } catch {
    return 'model';
  }
}

function parseOpenSCADErrors(stderr) {
  const errors = [];
  if (!stderr) return errors;
  const regex = /(?:ERROR|WARNING):\s*(.*?)(?:\s+in file\s+"([^"]+)",\s*line\s*(\d+))?$/gm;
  let match;
  while ((match = regex.exec(stderr)) !== null) {
    errors.push({ message: match[1], file: match[2] || '', line: match[3] ? parseInt(match[3]) : 0 });
  }
  return errors;
}

function writeRenderErrors(ctx, filename, errorText, errors) {
  // Write a RENDER_ERRORS.md that Claude can read to understand what went wrong
  const errFile = path.join(ctx.workspaceDir, 'RENDER_ERRORS.md');
  const errorLines = errors.map((e) => `- Line ${e.line}: ${e.message}`).join('\n');
  fs.writeFileSync(
    errFile,
    `# Render Failed: ${filename}\n\n` +
      `The last render of \`${filename}\` failed with errors.\n` +
      `**Create a NEW fixed .scad file** (never modify the broken one).\n\n` +
      `## Errors\n${errorLines || errorText}\n\n` +
      `## Raw Output\n\`\`\`\n${errorText.substring(0, 2000)}\n\`\`\`\n`
  );

  // Send a nudge to Claude's terminal — a visible prompt that there are errors to fix
  if (ctx.ptyProcess) {
    // Only nudge if Claude seems idle (don't interrupt mid-generation)
    // Write to pty so it appears in the conversation as user input
    const nudge =
      `The render of ${filename} failed. Read RENDER_ERRORS.md for details and create a fixed version.\n`;
    // Small delay to avoid interrupting Claude mid-output
    setTimeout(() => {
      if (ctx.ptyProcess) ctx.ptyProcess.write(nudge);
    }, 2000);
  }
}

function clearRenderErrors(ctx) {
  const errFile = path.join(ctx.workspaceDir, 'RENDER_ERRORS.md');
  try { if (fs.existsSync(errFile)) fs.unlinkSync(errFile); } catch {}
}

// The latest successful render, so Claude can confirm it without calling a tool.
function writeRenderStatus(ctx, filename, outputPath) {
  let geometry;
  try {
    const stats = measureMesh(readMesh(outputPath));
    geometry = stats.empty
      ? 'Empty model: no geometry was produced.'
      : `- Size: ${stats.bbox.size.join(' x ')} mm\n` +
        `- Min: [${stats.bbox.min.join(', ')}], Max: [${stats.bbox.max.join(', ')}]\n` +
        `- Volume: ${stats.volume} mm³, shells: ${stats.shells}`;
  } catch (err) {
    geometry = `Bounding box unavailable: ${err.message}`;
  }
  fs.writeFileSync(
    path.join(ctx.workspaceDir, 'RENDER_STATUS.md'),
    `# Render OK: ${filename}\n\nOutput: \`${path.basename(outputPath)}\`\n\n${geometry}\n`
  );
}

function clearRenderStatus(ctx) {
  const statusFile = path.join(ctx.workspaceDir, 'RENDER_STATUS.md');
  try { if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile); } catch {}
}

function scadToStl(scadPath) {
  return scadPath.replace(/\.scad$/, '.stl');
}

function sendModel(ctx, filePath, format) {
  try {
    const data = fs.readFileSync(filePath);
    ctxSend(ctx, 'model:update', {
      data,
      path: filePath,
      format: format || 'stl',
      checkpointId: ctx.state.active,
    });
  } catch {}
}

function ctxSend(ctx, channel, data) {
  try {
    if (ctx.window && !ctx.window.isDestroyed() && ctx.window.webContents && !ctx.window.webContents.isDestroyed()) {
      ctx.window.webContents.send(channel, data);
    }
  } catch {
    // Window was destroyed during send — safe to ignore
  }
}

function sendFileContent(ctx, scadFilename) {
  const filePath = path.join(ctx.workspaceDir, scadFilename);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    ctxSend(ctx, 'file:content', { path: filePath, name: scadFilename, content });
  } catch {}
}

// ── Session Discovery ───────────────────────────────────────────────────

function discoverSessions(ctx) {
  const encoded = getEncodedCwd(ctx.workspaceDir);
  const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
  const sessions = [];
  try {
    if (!fs.existsSync(projectDir)) return sessions;
    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const sessionId = path.basename(file, '.jsonl');
      const fp = path.join(projectDir, file);
      const stat = fs.statSync(fp);
      let firstMessage = '';
      try {
        const content = fs.readFileSync(fp, 'utf-8');
        for (const line of content.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message) {
              const msg = typeof entry.message === 'string'
                ? entry.message
                : entry.message.content || JSON.stringify(entry.message);
              firstMessage = msg.substring(0, 80);
              break;
            }
          } catch {}
        }
      } catch {}
      sessions.push({ sessionId, firstMessage, lastModified: stat.mtimeMs, date: stat.mtime.toISOString() });
    }
    sessions.sort((a, b) => b.lastModified - a.lastModified);
  } catch {}
  return sessions;
}

// ── Terminal ────────────────────────────────────────────────────────────

// Claude and anything it runs (openscad CLI, MCP server) inherit OPENSCADPATH
// so bundled libraries resolve exactly as they do in app renders.
function spawnPty(ctx, cmd, args, channel) {
  const proc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: ctx.workspaceDir,
    env: { ...process.env, COLORTERM: 'truecolor', OPENSCADPATH: openscadPath() },
  });
  proc.onData((data) => ctxSend(ctx, channel, data));
  return proc;
}

// Spawn a pty running the Claude Code CLI. If the binary can't be found (or
// fails to launch), drop the user into a normal shell with a hint on how to
// install it — we don't silently install global npm packages on their behalf.
function spawnClaude(ctx, args = []) {
  const bin = resolveClaude();
  if (bin) {
    try { return spawnPty(ctx, bin, args, 'terminal:data'); } catch {}
  }
  const proc = spawnPty(ctx, DEFAULT_SHELL, [], 'terminal:data');
  ctxSend(ctx, 'terminal:data',
    '\r\n\x1b[33mClaude Code CLI not found.\x1b[0m Install it from ' +
    'https://docs.claude.com/en/docs/claude-code/setup then restart the terminal.\r\n\r\n');
  return proc;
}

function startTerminal(ctx) {
  ctx.ptyProcess = spawnClaude(ctx, []);
  ctx.ptyProcess.onExit(() => {
    ctx.ptyProcess = spawnPty(ctx, DEFAULT_SHELL, [], 'terminal:data');
    ctx.ptyProcess.onExit(() => {});
  });
}

function restartTerminal(ctx, args = []) {
  if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
  ctx.ptyProcess = spawnClaude(ctx, args);
  ctx.ptyProcess.onExit(() => {
    ctx.ptyProcess = spawnPty(ctx, DEFAULT_SHELL, [], 'terminal:data');
    ctx.ptyProcess.onExit(() => {});
  });
}

// ── File Watcher ────────────────────────────────────────────────────────

function startFileWatcher(ctx) {
  ctx.fileWatcher = chokidar.watch(ctx.workspaceDir, {
    ignored: /(^|[/\\])(\.|node_modules|clawscad\.json)/,
    ignoreInitial: true,
    depth: 1,
    awaitWriteFinish: { stabilityThreshold: 200 },
  });
  ctx.fileWatcher.on('add', (fp) => handleFileEvent(ctx, fp));
  ctx.fileWatcher.on('change', (fp) => handleFileEvent(ctx, fp));
  ctx.fileWatcher.on('error', (err) => {
    console.warn(`File watcher error for ${ctx.workspaceDir}:`, err.message);
  });
}

function handleFileEvent(ctx, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);
  if (basename === ACTIVE_FILE) return;

  if (ext === '.scad') {
    const id = addCheckpoint(ctx, filePath);
    if (id) {
      enqueueRender(ctx, filePath);
    } else {
      const activeCp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
      if (activeCp && activeCp.file === basename) {
        enqueueRender(ctx, filePath);
      }
    }
  } else if (ext === '.stl') {
    const scadName = basename.replace(/\.stl$/, '.scad');
    const activeCp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
    if (activeCp && activeCp.file === scadName) {
      sendModel(ctx, filePath, 'stl');
    }
  }
}

// ── IPC Handlers ────────────────────────────────────────────────────────

ipcMain.on('terminal:input', (event, data) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess) ctx.ptyProcess.write(data);
});

ipcMain.handle('terminal2:spawn', (event) => {
  const ctx = getCtx(event);
  if (!ctx || ctx.ptyProcess2) return;
  try {
    ctx.ptyProcess2 = spawnPty(ctx, resolveClaude() || 'claude', [], 'terminal2:data');
  } catch {
    ctx.ptyProcess2 = spawnPty(ctx, DEFAULT_SHELL, [], 'terminal2:data');
  }
  ctx.ptyProcess2.onExit(() => { ctx.ptyProcess2 = null; });
});

ipcMain.handle('terminal2:kill', (event) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) {
    try { ctx.ptyProcess2.kill(); } catch {}
    ctx.ptyProcess2 = null;
  }
});

ipcMain.on('terminal2:input', (event, data) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) ctx.ptyProcess2.write(data);
});

ipcMain.on('terminal2:resize', (event, { cols, rows }) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess2) try { ctx.ptyProcess2.resize(cols, rows); } catch {}
});

ipcMain.on('terminal:resize', (event, { cols, rows }) => {
  const ctx = getCtx(event);
  if (ctx && ctx.ptyProcess) try { ctx.ptyProcess.resize(cols, rows); } catch {}
});

ipcMain.handle('workspace:get', (event) => {
  const ctx = getCtx(event);
  return ctx ? ctx.workspaceDir : '';
});

ipcMain.handle('file:read', (_, filePath) => {
  try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
});

ipcMain.handle('file:read-model', (_, filePath, format) => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = fs.readFileSync(filePath);
    return { data, format };
  } catch {
    return null;
  }
});

ipcMain.handle('file:save', (_, filePath, content) => {
  try { fs.writeFileSync(filePath, content, 'utf-8'); return true; } catch { return false; }
});

ipcMain.handle('checkpoint:list', (event) => {
  const ctx = getCtx(event);
  return ctx ? ctx.state : { checkpoints: {}, active: null };
});

ipcMain.handle('sessions:list', (event) => {
  const ctx = getCtx(event);
  return ctx ? discoverSessions(ctx) : [];
});

ipcMain.handle('sessions:new', (event) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, []);
});

ipcMain.handle('sessions:continue', (event) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, ['--continue']);
});

ipcMain.handle('sessions:resume', (event, sessionId) => {
  const ctx = getCtx(event);
  if (ctx) restartTerminal(ctx, ['--resume', sessionId]);
});

ipcMain.handle('checkpoint:select', (event, id) => {
  const ctx = getCtx(event);
  if (ctx) selectCheckpoint(ctx, id);
});

ipcMain.handle('checkpoint:restore-session', (event, id) => {
  const ctx = getCtx(event);
  if (!ctx) return false;
  const cp = ctx.state.checkpoints[id];
  if (cp && cp.sessionId) {
    restartTerminal(ctx, ['--resume', cp.sessionId]);
    return true;
  }
  return false;
});

ipcMain.handle('checkpoint:rename', (event, id, label) => {
  const ctx = getCtx(event);
  if (ctx && ctx.state.checkpoints[id]) {
    ctx.state.checkpoints[id].label = label;
    saveState(ctx);
    sendCheckpoints(ctx);
  }
});

ipcMain.handle('checkpoint:delete', (event, id) => {
  const ctx = getCtx(event);
  if (!ctx || !ctx.state.checkpoints[id]) return;
  const parentId = ctx.state.checkpoints[id].parent;
  for (const [, cp] of Object.entries(ctx.state.checkpoints)) {
    if (cp.parent === id) cp.parent = parentId;
  }
  delete ctx.state.checkpoints[id];
  if (ctx.state.active === id) ctx.state.active = parentId;
  saveState(ctx);
  sendCheckpoints(ctx);
});

ipcMain.handle('render:force', (event) => {
  const ctx = getCtx(event);
  if (!ctx) return;
  const cp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
  if (cp) {
    const scadPath = path.join(ctx.workspaceDir, cp.file);
    if (fs.existsSync(scadPath)) {
      // Delete stale output so it re-renders fresh
      const stlPath = scadToStl(scadPath);
      const tmfPath = scadPath.replace(/\.scad$/, '.3mf');
      try { if (fs.existsSync(stlPath)) fs.unlinkSync(stlPath); } catch {}
      try { if (fs.existsSync(tmfPath)) fs.unlinkSync(tmfPath); } catch {}
      enqueueRender(ctx, scadPath);
    }
  }
});

ipcMain.handle('app:new-project-window', async (event) => {
  if (windows.size >= MAX_WINDOWS) return null;
  const ctx = getCtx(event);
  // Default to current workspace name + "-2"
  const currentBase = ctx ? path.basename(ctx.workspaceDir) : 'clawscad-workspace';
  const defaultDir = path.join(
    ctx ? path.dirname(ctx.workspaceDir) : os.homedir(),
    currentBase + '-2'
  );
  const result = await dialog.showOpenDialog(ctx ? ctx.window : null, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'New Project Workspace',
    defaultPath: defaultDir,
  });
  if (!result.canceled && result.filePaths[0]) {
    openWindow(result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('app:open-workspace', async (event) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  const result = await dialog.showOpenDialog(ctx.window, {
    properties: ['openDirectory'],
    title: 'Open Workspace',
  });
  if (!result.canceled && result.filePaths[0]) {
    // Replace this window's workspace
    if (ctx.fileWatcher) ctx.fileWatcher.close();
    if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
    ctx.workspaceDir = result.filePaths[0];
    initWorkspace(ctx);
    loadState(ctx);
    startTerminal(ctx);
    startFileWatcher(ctx);
    ctx.window.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);
    sendCheckpoints(ctx);
    updateAllClaudeMd();
    return ctx.workspaceDir;
  }
  return null;
});

ipcMain.handle('app:open-workspace-in-files', (event) => {
  const ctx = getCtx(event);
  if (ctx) shell.openPath(ctx.workspaceDir);
});

ipcMain.handle('app:get-print-settings-path', (event) => {
  const ctx = getCtx(event);
  return ctx ? path.join(ctx.workspaceDir, 'clawscad.json') : '';
});

ipcMain.handle('app:export', async (event, format) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  const cp = ctx.state.active && ctx.state.checkpoints[ctx.state.active];
  if (!cp) return null;
  const scadPath = path.join(ctx.workspaceDir, cp.file);
  if (!fs.existsSync(scadPath)) return null;

  const filters = {
    stl: [{ name: 'STL', extensions: ['stl'] }],
    '3mf': [{ name: '3MF', extensions: ['3mf'] }],
    png: [{ name: 'PNG Image', extensions: ['png'] }],
  };
  const ext = format === 'png' ? '.png' : format === '3mf' ? '.3mf' : '.stl';
  const defaultName = cp.file.replace(/\.scad$/, ext);

  const result = await dialog.showSaveDialog(ctx.window, {
    title: `Export as ${format.toUpperCase()}`,
    defaultPath: path.join(ctx.workspaceDir, defaultName),
    filters: filters[format] || filters.stl,
  });
  if (result.canceled) return null;

  const args = format === 'png'
    ? ['--imgsize=1920,1080', '-o', result.filePath, scadPath, ...backendArgs()]
    : ['-o', result.filePath, scadPath, ...backendArgs()];

  return new Promise((resolve) => {
    execFile(OPENSCAD_BIN, args, { timeout: 120000, env: openscadEnv() }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: stderr || err.message });
      } else {
        resolve({ path: result.filePath });
      }
    });
  });
});

// Recent paths management
const recentPathsFile = path.join(app.getPath('userData'), 'recent-workspaces.json');

function loadRecentPaths() {
  try {
    if (fs.existsSync(recentPathsFile)) {
      return JSON.parse(fs.readFileSync(recentPathsFile, 'utf-8')).slice(0, 20);
    }
  } catch {}
  return [];
}

function addRecentPath(wsPath) {
  let recent = loadRecentPaths();
  recent = recent.filter((p) => p !== wsPath);
  recent.unshift(wsPath);
  recent = recent.slice(0, 20);
  fs.writeFileSync(recentPathsFile, JSON.stringify(recent, null, 2));
}

ipcMain.handle('app:list-recent', () => loadRecentPaths());

ipcMain.handle('app:browse-dir', (_, dirPath) => {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return null;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];
    // Parent directory
    const parent = path.dirname(dirPath);
    if (parent !== dirPath) result.push({ name: '..', path: parent, isDir: true });
    // Directories first, then .scad files
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) result.push({ name: e.name + '/', path: path.join(dirPath, e.name), isDir: true });
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.scad')) {
        result.push({ name: e.name, path: path.join(dirPath, e.name), isDir: false });
      }
    }
    return { dir: dirPath, entries: result };
  } catch {
    return null;
  }
});

ipcMain.handle('app:open-path', async (event, inputPath) => {
  const ctx = getCtx(event);
  if (!ctx) return null;
  try {
    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      // Switch workspace to this directory
      if (ctx.fileWatcher) ctx.fileWatcher.close();
      if (ctx.ptyProcess) try { ctx.ptyProcess.kill(); } catch {}
      ctx.workspaceDir = inputPath;
      initWorkspace(ctx);
      loadState(ctx);
      startTerminal(ctx);
      startFileWatcher(ctx);
      ctx.window.setTitle(`ClawSCAD — ${ctx.workspaceDir}`);
      sendCheckpoints(ctx);
      updateAllClaudeMd();
      addRecentPath(inputPath);
      return { type: 'workspace', path: inputPath };
    } else if (stat.isFile() && inputPath.endsWith('.scad')) {
      // Copy the .scad file into the workspace and add as checkpoint
      const basename = path.basename(inputPath);
      const dest = path.join(ctx.workspaceDir, basename);
      if (!fs.existsSync(dest)) fs.copyFileSync(inputPath, dest);
      return { type: 'file', path: dest };
    }
  } catch {}
  return null;
});

ipcMain.handle('app:toggle-devtools', (event) => {
  const ctx = getCtx(event);
  if (ctx) ctx.window.webContents.toggleDevTools();
});

ipcMain.handle('app:window-count', () => windows.size);

// ── App Lifecycle ───────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await detectManifold();
  const cliArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const wsDir = cliArg ? path.resolve(cliArg) : path.join(os.homedir(), 'clawscad-workspace');
  openWindow(wsDir);
});

app.on('window-all-closed', () => {
  app.quit();
});
