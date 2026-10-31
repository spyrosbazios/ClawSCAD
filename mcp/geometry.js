// Dependency-free mesh readers (STL binary/ASCII, 3MF) and measurements.
// Shared by the MCP server and main.js (RENDER_STATUS.md).
const fs = require('fs');
const zlib = require('zlib');

// A mesh is { positions: Float64Array (xyz per vertex), triangles: Uint32Array (3 indices each) }.
// STL has no shared vertices, so identical coordinates are welded by exact key.
function welder() {
  const index = new Map();
  const positions = [];
  return {
    add(x, y, z) {
      const key = `${x},${y},${z}`;
      let i = index.get(key);
      if (i === undefined) {
        i = positions.length / 3;
        index.set(key, i);
        positions.push(x, y, z);
      }
      return i;
    },
    positions: () => Float64Array.from(positions),
  };
}

function isBinaryStl(buf) {
  if (buf.length < 84) return false;
  return 84 + buf.readUInt32LE(80) * 50 === buf.length;
}

function parseStl(buf) {
  const w = welder();
  const tris = [];
  if (isBinaryStl(buf)) {
    const count = buf.readUInt32LE(80);
    for (let t = 0; t < count; t++) {
      const o = 84 + t * 50 + 12;
      for (let v = 0; v < 3; v++) {
        const p = o + v * 12;
        tris.push(w.add(buf.readFloatLE(p), buf.readFloatLE(p + 4), buf.readFloatLE(p + 8)));
      }
    }
  } else {
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    const text = buf.toString('latin1');
    let m;
    while ((m = re.exec(text)) !== null) tris.push(w.add(+m[1], +m[2], +m[3]));
  }
  return { positions: w.positions(), triangles: Uint32Array.from(tris) };
}

const MAX32 = 0xffffffff;

// Reads the ZIP64 extended-information extra field (0x0001), whose values
// appear only for the header fields that were saturated to 0xFFFFFFFF.
function zip64Fields(buf, extraStart, extraEnd, wanted) {
  for (let p = extraStart; p + 4 <= extraEnd;) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (id === 0x0001) {
      const values = {};
      let q = p + 4;
      for (const key of wanted) { values[key] = Number(buf.readBigUInt64LE(q)); q += 8; }
      return values;
    }
    p += 4 + size;
  }
  throw new Error('3MF: missing ZIP64 field');
}

// Minimal ZIP/ZIP64 reader (lib3mf writes ZIP64): locate an entry through the
// central directory and inflate it.
function readZipEntry(buf, predicate) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('3MF: not a zip archive');
  let entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === MAX32 || entries === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== 0x07064b50) throw new Error('3MF: bad ZIP64 locator');
    const record = Number(buf.readBigUInt64LE(locator + 8));
    entries = Number(buf.readBigUInt64LE(record + 32));
    p = Number(buf.readBigUInt64LE(record + 48));
  }
  for (let e = 0; e < entries; e++) {
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (predicate(name)) {
      const wanted = [];
      if (rawSize === MAX32) wanted.push('raw');
      if (compSize === MAX32) wanted.push('comp');
      if (local === MAX32) wanted.push('local');
      if (wanted.length) {
        const extraStart = p + 46 + nameLen;
        const z64 = zip64Fields(buf, extraStart, extraStart + extraLen, wanted);
        if (z64.comp !== undefined) compSize = z64.comp;
        if (z64.local !== undefined) local = z64.local;
      }
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`3MF: unsupported zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('3MF: no model part found');
}

// Merges every <mesh> in the model part; build transforms are ignored
// (OpenSCAD writes identity transforms).
function parse3mf(buf) {
  const xml = readZipEntry(buf, (n) => /\.model$/i.test(n)).toString('utf8');
  const positions = [];
  const tris = [];
  const meshRe = /<mesh>([\s\S]*?)<\/mesh>/g;
  let mesh;
  while ((mesh = meshRe.exec(xml)) !== null) {
    const base = positions.length / 3;
    const vRe = /<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g;
    const tRe = /<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/g;
    let m;
    while ((m = vRe.exec(mesh[1])) !== null) positions.push(+m[1], +m[2], +m[3]);
    while ((m = tRe.exec(mesh[1])) !== null) tris.push(base + +m[1], base + +m[2], base + +m[3]);
  }
  return { positions: Float64Array.from(positions), triangles: Uint32Array.from(tris) };
}

function readMesh(filePath) {
  const buf = fs.readFileSync(filePath);
  return /\.3mf$/i.test(filePath) ? parse3mf(buf) : parseStl(buf);
}

const round = (n) => Math.round(n * 100) / 100;

function countShells(vertexCount, triangles) {
  const parent = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const used = new Uint8Array(vertexCount);
  for (let t = 0; t < triangles.length; t += 3) {
    used[triangles[t]] = used[triangles[t + 1]] = used[triangles[t + 2]] = 1;
    const a = find(triangles[t]);
    parent[find(triangles[t + 1])] = a;
    parent[find(triangles[t + 2])] = find(a);
  }
  const roots = new Set();
  for (let i = 0; i < vertexCount; i++) if (used[i]) roots.add(find(i));
  return roots.size;
}

function measureMesh({ positions, triangles }) {
  const triangleCount = triangles.length / 3;
  if (triangleCount === 0) return { empty: true, bbox: null, volume: 0, triangles: 0, shells: 0 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (positions[i + k] < min[k]) min[k] = positions[i + k];
      if (positions[i + k] > max[k]) max[k] = positions[i + k];
    }
  }
  let volume = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t] * 3, b = triangles[t + 1] * 3, c = triangles[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return {
    empty: false,
    bbox: { min: min.map(round), max: max.map(round), size: max.map((v, k) => round(v - min[k])) },
    volume: round(Math.abs(volume)),
    triangles: triangleCount,
    shells: countShells(positions.length / 3, triangles),
  };
}

module.exports = { readMesh, parseStl, parse3mf, measureMesh };
