// OpenSCAD invocation, diagnostics and the check/measure operations.
// Shared by the MCP server (mcp/server.js) and the PostToolUse hook (mcp/hook.js).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readMesh, measureMesh } = require('./geometry');

const DEFAULT_TIMEOUT_MS = 120000;

// `bin` is the OpenSCAD executable, `cwd` the workspace (first on OPENSCADPATH so
// workspace-relative include/use resolve from temp files), `libPath` further OPENSCADPATH entries.
function createOpenSCAD({ bin, cwd, libPath }) {
  function env() {
    const out = { ...process.env };
    if (bin.endsWith('.AppImage')) out.APPIMAGE_EXTRACT_AND_RUN = '1';
    out.OPENSCADPATH = [cwd, libPath].filter(Boolean).join(path.delimiter);
    return out;
  }

  // Manifold (OpenSCAD 2024+) is far faster than CGAL on boolean-heavy models.
  // Probed once per process; older binaries lack the flag.
  let backendArgs;
  function probeBackend() {
    backendArgs ??= new Promise((resolve) => {
      execFile(bin, ['--help'], { timeout: DEFAULT_TIMEOUT_MS, env: env() }, (err, stdout, stderr) => {
        resolve(!err && /manifold/i.test(`${stdout}${stderr}`) ? ['--backend=Manifold'] : []);
      });
    });
    return backendArgs;
  }

  // Resolves { ok, timeout, missing, output }; `missing` marks an environment fault (binary unrunnable).
  async function run(args, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const backend = await probeBackend();
    return new Promise((resolve) => {
      execFile(bin, [...args, ...backend], { cwd, timeout: timeoutMs, killSignal: 'SIGKILL', env: env(), maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err.killed || err.signal)) {
            resolve({ ok: false, timeout: true, missing: false, output: `timeout: OpenSCAD did not finish within ${timeoutMs / 1000} s` });
          } else if (err && typeof err.code === 'string') {
            resolve({ ok: false, timeout: false, missing: true, output: `cannot run OpenSCAD (${bin}): ${err.code}` });
          } else {
            resolve({ ok: !err, timeout: false, missing: false, output: `${stdout}${stderr}` });
          }
        });
    });
  }

  // Fast parse/evaluate via CSG export. Trace lines are dropped.
  async function check(scadPath, dir, timeoutMs) {
    const result = await run(['-o', path.join(dir, 'out.csg'), scadPath], timeoutMs);
    const diagnostics = parseDiagnostics(result.output).filter((d) => d.level !== 'trace');
    const ok = result.ok && !diagnostics.some((d) => d.level === 'error');
    return { result, ok, diagnostics };
  }

  // Full mesh build; `stats` is absent when the export failed.
  async function measure(scadPath, dir, timeoutMs) {
    const stl = path.join(dir, 'measure.stl');
    const result = await run(['-o', stl, scadPath], timeoutMs);
    const warnings = parseDiagnostics(result.output).filter((d) => d.level === 'warning');
    if (!result.ok || !fs.existsSync(stl)) return { result, warnings };
    return { result, warnings, stats: measureMesh(readMesh(stl)) };
  }

  return { run, check, measure };
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

module.exports = { createOpenSCAD, parseDiagnostics };
