// Claude Code PostToolUse hook for Write|Edit|MultiEdit. Bundled to dist/clawscad-hook.js
// and registered in each workspace's .claude/settings.json by main.js.
// Usage: clawscad-hook <config.json>, config = { openscadPath, openscadLibPath }.
// Checks and measures the written .scad file and reports back in the tool result:
// errors -> {"decision":"block"}, success -> hookSpecificOutput.additionalContext.
// Environment faults (no binary, unreadable config) emit nothing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOpenSCAD } = require('./openscad');

const CHECK_TIMEOUT_MS = 30000;
const MEASURE_TIMEOUT_MS = 60000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The workspace-relative .scad path, or null when the edit is not ours to check.
function targetFile(input) {
  const file = input.tool_input && input.tool_input.file_path;
  if (typeof file !== 'string' || !/\.scad$/i.test(file) || typeof input.cwd !== 'string') return null;
  const abs = path.resolve(input.cwd, file);
  const rel = path.relative(input.cwd, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return fs.existsSync(abs) ? { abs, rel } : null;
}

const fmt = (n) => String(Math.round(n * 100) / 100);
const describe = (d) => (d.line ? `line ${d.line}: ${d.message}` : d.message);

function blocked(rel, diagnostics, output) {
  const errors = diagnostics.filter((d) => d.level === 'error');
  const lines = errors.length ? errors.map((d) => `- ${describe(d)}`) : [`- ${output.trim().slice(-800) || 'OpenSCAD failed without diagnostics'}`];
  return {
    decision: 'block',
    reason: `${rel} failed to render:\n${lines.slice(0, 10).join('\n')}\n`
      + 'Create a NEW fixed .scad file with these errors resolved; never edit the broken one.',
  };
}

function context(rel, measured, warnings) {
  const parts = [];
  if (measured.timeout) {
    parts.push(`${rel} parsed OK (check only: measuring exceeded ${MEASURE_TIMEOUT_MS / 1000} s; call the openscad \`measure\` tool if you need dimensions).`);
  } else if (!measured.stats) {
    parts.push(`${rel} parsed OK but the mesh build failed:\n${measured.result.output.trim().slice(-800)}`);
  } else if (measured.stats.empty) {
    parts.push(`${rel} rendered OK but produced no geometry.`);
  } else {
    const { bbox, volume, shells } = measured.stats;
    parts.push(`${rel} rendered OK. bbox size ${bbox.size.map(fmt).join('×')} mm, volume ${fmt(volume)} mm³, ${shells} shell${shells === 1 ? '' : 's'}.`);
  }
  if (warnings.length) parts.push(`Warnings:\n${warnings.slice(0, 10).map((d) => `- ${describe(d)}`).join('\n')}`);
  parts.push('Compare against the requested dimensions.');
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n') } };
}

async function evaluate(input, config) {
  const target = targetFile(input);
  if (!target || !config) return null;
  const openscad = createOpenSCAD({ bin: config.openscadPath, cwd: input.cwd, libPath: config.openscadLibPath });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawscad-hook-'));
  try {
    const checked = await openscad.check(target.abs, dir, CHECK_TIMEOUT_MS);
    if (checked.result.missing || checked.result.timeout) return null;
    if (!checked.ok) return blocked(target.rel, checked.diagnostics, checked.result.output);
    const measured = await openscad.measure(target.abs, dir, MEASURE_TIMEOUT_MS);
    if (measured.result.missing) return null;
    const warnings = checked.diagnostics.filter((d) => d.level === 'warning');
    return context(target.rel, { ...measured, timeout: measured.result.timeout }, warnings);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const output = await evaluate(input, readConfig(process.argv[2]));
  if (output) process.stdout.write(JSON.stringify(output));
}

main().catch((err) => {
  process.stderr.write(`clawscad-hook failed: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
