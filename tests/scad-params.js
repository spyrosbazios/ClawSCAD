// The load-bearing rules: the module/function cutoff (a knob past it would
// silently do nothing) and toDefineArg's quoting (a string value must not be
// able to close its own literal and append code to an OpenSCAD -D argument).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, toDefineArg, defineArgs } = require('../mcp/scad-params');

const byName = (r, n) => r.parameters.find((p) => p.name === n);

// ── the cutoff ──────────────────────────────────────────────────────────

test('assignments AFTER the first module are NOT customizable', () => {
  const r = parse(`
width = 40;
module thing() {
inner = 99;
depth = 12;
}
after = 7;
`);
  assert.deepStrictEqual(r.parameters.map((p) => p.name), ['width']);
});

test('a leading function also closes the region', () => {
  const r = parse(`
a = 1;
function f(x) = x * 2;
b = 2;
`);
  assert.deepStrictEqual(r.parameters.map((p) => p.name), ['a']);
});

test('a file with no module at all keeps every top-level assignment', () => {
  const r = parse('a = 1;\nb = 2;\nc = 3;');
  assert.deepStrictEqual(r.parameters.map((p) => p.name), ['a', 'b', 'c']);
});

// ── literals ────────────────────────────────────────────────────────────

test('numbers, negatives and decimals', () => {
  const r = parse('w = 40;\nh = -2.5;\nz = 0.125;');
  assert.strictEqual(byName(r, 'w').value, 40);
  assert.strictEqual(byName(r, 'h').value, -2.5);
  assert.strictEqual(byName(r, 'z').value, 0.125);
  assert.strictEqual(byName(r, 'w').kind, 'number');
});

test('booleans become checkboxes', () => {
  const r = parse('fancy = true;\nplain = false;');
  assert.strictEqual(byName(r, 'fancy').value, true);
  assert.strictEqual(byName(r, 'plain').value, false);
  assert.strictEqual(byName(r, 'fancy').control, 'checkbox');
});

test('strings become text, with escapes resolved', () => {
  const r = parse('label = "WORK\\"SHOP";');
  assert.strictEqual(byName(r, 'label').value, 'WORK"SHOP');
  assert.strictEqual(byName(r, 'label').control, 'text');
});

test('a // inside a string is not a comment', () => {
  const r = parse('url = "http://example.com";');
  assert.strictEqual(byName(r, 'url').value, 'http://example.com');
});

test('vectors and expressions are skipped, with a reason, never offered', () => {
  const r = parse('size = [10, 20, 30];\ncalc = 2 * 3;\nok = 5;');
  assert.deepStrictEqual(r.parameters.map((p) => p.name), ['ok']);
  assert.ok(r.skipped.some((s) => s.name === 'size'));
  assert.ok(r.skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 0));
});

// ── annotations ─────────────────────────────────────────────────────────

test('[min:max] becomes a slider', () => {
  const p = byName(parse('w = 40; // [10:200]'), 'w');
  assert.strictEqual(p.control, 'slider');
  assert.strictEqual(p.min, 10);
  assert.strictEqual(p.max, 200);
  assert.strictEqual(p.step, undefined);
});

test('[min:step:max] carries the step', () => {
  const p = byName(parse('w = 40; // [10:5:200]'), 'w');
  assert.strictEqual(p.min, 10);
  assert.strictEqual(p.step, 5);
  assert.strictEqual(p.max, 200);
});

test('[a, b, c] becomes a select', () => {
  const p = byName(parse('mode = "hex"; // [hex, round, square]'), 'mode');
  assert.strictEqual(p.control, 'select');
  assert.deepStrictEqual(p.options.map((o) => o.value), ['hex', 'round', 'square']);
});

test('[1:One, 2:Two] keeps value and label apart', () => {
  const p = byName(parse('n = 1; // [1:One, 2:Two]'), 'n');
  assert.deepStrictEqual(p.options, [
    { value: 1, label: 'One' },
    { value: 2, label: 'Two' },
  ]);
});

test('a range on a STRING does not become a slider', () => {
  const p = byName(parse('s = "x"; // [1:10]'), 's');
  assert.strictEqual(p.control, 'text');
});

test('trailing prose after an annotation becomes the description', () => {
  const p = byName(parse('w = 40; // [10:200] how wide it is'), 'w');
  assert.strictEqual(p.description, 'how wide it is');
});

test('a comment line above an assignment is its description', () => {
  const p = byName(parse('// outside width in mm\nw = 40;'), 'w');
  assert.strictEqual(p.description, 'outside width in mm');
});

// ── sections ────────────────────────────────────────────────────────────

test('/* [Section] */ groups the parameters that follow', () => {
  const r = parse('/* [Size] */\nw = 1;\n/* [Look] */\nc = "red";');
  assert.strictEqual(byName(r, 'w').section, 'Size');
  assert.strictEqual(byName(r, 'c').section, 'Look');
  assert.deepStrictEqual(r.sections, ['Size', 'Look']);
});

test('a Hidden section is skipped, not offered', () => {
  const r = parse('/* [Size] */\nw = 1;\n/* [Hidden] */\nsecret = 2;');
  assert.deepStrictEqual(r.parameters.map((p) => p.name), ['w']);
  assert.ok(r.skipped.some((s) => s.name === 'secret'));
  assert.ok(!r.sections.includes('Hidden'));
});

test('an ordinary block comment is not a section and hides nothing after it', () => {
  const r = parse('/* just prose\n   over two lines */\nw = 1;');
  assert.deepStrictEqual(r.parameters.map((p) => p.name), ['w']);
  assert.deepStrictEqual(r.sections, []);
});

test('an assignment INSIDE a block comment is not a parameter', () => {
  const r = parse('/* w = 99; */\nreal = 1;');
  assert.deepStrictEqual(r.parameters.map((p) => p.name), ['real']);
});

// ── robustness ──────────────────────────────────────────────────────────

test('a re-assigned name yields ONE control, the last value', () => {
  const r = parse('w = 1;\nw = 2;');
  assert.strictEqual(r.parameters.length, 1);
  assert.strictEqual(byName(r, 'w').value, 2);
});

test('a file with no parameters returns empty, not a throw', () => {
  const r = parse('module a() { cube(1); }\na();');
  assert.deepStrictEqual(r.parameters, []);
});

for (const junk of [null, undefined, '', 42, {}, []]) {
  test(`${JSON.stringify(junk) ?? 'undefined'} parses to empty without throwing`, () => {
    const r = parse(junk);
    assert.deepStrictEqual(r.parameters, []);
  });
}

test('malformed brackets and unterminated strings do not throw', () => {
  for (const src of ['w = 40; // [', 'w = "unterminated;', 'w = ; // [1:2]', '/* [Unclosed', 'w=1;//[a,]']) {
    parse(src);
  }
});

test('parse is pure — same input, deep-equal output', () => {
  const src = '/* [S] */\n// desc\nw = 40; // [1:100]\nmode = "a"; // [a,b]';
  assert.deepStrictEqual(parse(src), parse(src));
});

// ── the -D injection boundary ───────────────────────────────────────────

test('numbers and booleans render bare', () => {
  assert.strictEqual(toDefineArg('w', 40, 'number'), 'w=40');
  assert.strictEqual(toDefineArg('f', true, 'boolean'), 'f=true');
  assert.strictEqual(toDefineArg('f', false, 'boolean'), 'f=false');
});

test('a string carrying a quote cannot close its own literal', () => {
  // The whole point: `"; cube(999); //` must stay INSIDE the quotes.
  const arg = toDefineArg('label', '"; cube(999); //', 'string');
  assert.strictEqual(arg, 'label="\\"; cube(999); //"');
  assert.ok(!/^label="";/.test(arg));
});

test('backslashes and newlines are neutralised', () => {
  assert.strictEqual(toDefineArg('s', 'a\\b', 'string'), 's="a\\\\b"');
  assert.strictEqual(toDefineArg('s', 'a\nb', 'string'), 's="a b"');
});

test('a non-identifier name is refused outright', () => {
  assert.strictEqual(toDefineArg('w; cube(9)', 1, 'number'), null);
  assert.strictEqual(toDefineArg('2bad', 1, 'number'), null);
  assert.strictEqual(toDefineArg('', 1, 'number'), null);
});

test('a non-finite number is refused rather than emitted', () => {
  assert.strictEqual(toDefineArg('w', Infinity, 'number'), null);
  assert.strictEqual(toDefineArg('w', NaN, 'number'), null);
});

test('defineArgs emits only parameters the caller supplied a value for', () => {
  const params = [
    { name: 'w', kind: 'number' },
    { name: 'h', kind: 'number' },
    { name: 'f', kind: 'boolean' },
  ];
  assert.deepStrictEqual(defineArgs(params, { w: 10, f: true }), ['-D', 'w=10', '-D', 'f=true']);
  assert.deepStrictEqual(defineArgs(params, {}), []);
  assert.deepStrictEqual(defineArgs([], { w: 1 }), []);
});

test('defineArgs ignores values for names that are not declared parameters', () => {
  // A crafted POST must not be able to inject a -D for something the file
  // never declared.
  assert.deepStrictEqual(defineArgs([{ name: 'w', kind: 'number' }], { evil: 1 }), []);
});
