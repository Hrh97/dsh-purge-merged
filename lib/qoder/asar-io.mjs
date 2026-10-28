// asar-io.mjs — minimal Electron asar reader/writer for the Qoder purge patcher.
// Layout (Chromium pickle framing, verified against Qoder CN 0.4.11 app.asar by
// integrity-hash cross-check — tmp-qoder/diag-base.mjs):
//   [0..4)    u32 = 4                (size pickle payload)
//   [4..8)    u32 H = 8 + align4(J)  (header pickle payload size)
//   [8..12)   u32 = 4 + align4(J)    (string pickle payload size)
//   [12..16)  u32 J                  (json utf8 byte length)
//   [16..)    header json utf8, padded to align4(J)
//   data region begins at 8+H (== 16+align4(J)); per-entry offsets in header json are strings.
import fs from 'node:fs';
import crypto from 'node:crypto';

export class AsarFile {
  constructor(asarPath) {
    this.path = asarPath;
    this.fd = fs.openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(this.fd, head, 0, 16, 0);
    this.first = head.readUInt32LE(0);
    this.headerSize = head.readUInt32LE(4);
    this.middle = head.readUInt32LE(8);
    const headerBuf = Buffer.alloc(this.headerSize);
    fs.readSync(this.fd, headerBuf, 0, this.headerSize, 12);
    this.strLen = headerBuf.readUInt32LE(0);
    this.header = JSON.parse(headerBuf.toString('utf8', 4, 4 + this.strLen));
    this.baseOffset = 8 + this.headerSize;
  }

  close() { try { fs.closeSync(this.fd); } catch { /* ignore */ } }

  readData(offset, size) {
    const buf = Buffer.alloc(size);
    fs.readSync(this.fd, buf, 0, size, this.baseOffset + Number(offset));
    return buf;
  }

  readFile(relPath) {
    const node = this.lookup(relPath);
    if (!node || node.files) throw new Error(`not a file entry: ${relPath}`);
    if (node.unpacked) throw new Error(`entry is unpacked: ${relPath}`);
    return this.readData(node.offset, node.size);
  }

  lookup(relPath) {
    let node = this.header;
    for (const part of relPath.split('/')) {
      node = node.files && node.files[part];
      if (!node) return null;
    }
    return node;
  }
}

// Depth-first file walk; order is stable (Object.keys insertion order).
export function walkFiles(node, prefix = '', out = []) {
  const files = node.files || {};
  for (const name of Object.keys(files)) {
    const child = files[name];
    const p = prefix ? `${prefix}/${name}` : name;
    if (child && child.files) walkFiles(child, p, out);
    else if (child && !child.files) out.push({ path: p, node: child });
  }
  return out;
}

function computeIntegrity(buf, algoName, blockSize) {
  const algo = String(algoName || 'SHA256').toLowerCase().replace(/[^a-z0-9]/g, '');
  const bs = blockSize || 4194304;
  const blocks = [];
  for (let i = 0; i < buf.length; i += bs) {
    blocks.push(crypto.createHash(algo).update(buf.subarray(i, Math.min(i + bs, buf.length))).digest('hex'));
  }
  return { algorithm: algoName || 'SHA256', hash: crypto.createHash(algo).update(buf).digest('hex'), blockSize: bs, blocks };
}

/**
 * Rebuild an asar: header re-serialized, entries rewritten sequentially in walk order.
 * @param {AsarFile} asar opened source archive
 * @param {Map<string,Buffer>} replacements relPath -> new content (others copied byte-identical)
 * @returns {{newHeader: object, totalSize: number, replaced: string[]}}
 */
export function buildRebuilt(asar, replacements) {
  const newHeader = JSON.parse(JSON.stringify(asar.header));
  const files = walkFiles(newHeader);
  const orig = new Map(walkFiles(asar.header).map(e => [e.path, e.node]));
  let running = 0;
  const plan = [];
  const replaced = [];
  for (const entry of files) {
    const node = entry.node;
    const origNode = orig.get(entry.path);
    if (node.unpacked || !origNode) continue; // data lives in app.asar.unpacked — untouched
    const repl = replacements.get(entry.path);
    const origOffset = Number(origNode.offset);
    const buf = repl !== undefined ? repl : asar.readData(origOffset, origNode.size);
    node.offset = String(running);
    node.size = buf.length;
    if (node.integrity && repl !== undefined) {
      node.integrity = computeIntegrity(buf, node.integrity.algorithm, node.integrity.blockSize);
    }
    plan.push({ buf });
    running += buf.length;
    if (repl !== undefined) replaced.push(entry.path);
  }
  return { newHeader, totalSize: 12 + headerBufLen(newHeader) + running, plan, replaced };
}

function headerBufLen(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  return 4 + jsonBuf.length + pad;
}

/** Write the rebuilt archive to outPath atomically-safe temp file. */
export function writeRebuilt(asar, newHeader, plan, outPath) {
  const jsonBuf = Buffer.from(JSON.stringify(newHeader), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const headerBuf = Buffer.alloc(4 + jsonBuf.length + pad);
  headerBuf.writeUInt32LE(jsonBuf.length, 0);
  jsonBuf.copy(headerBuf, 4);
  const headerSize = headerBuf.length;

  const out = fs.openSync(outPath, 'w');
  try {
    const head = Buffer.alloc(12);
    head.writeUInt32LE(asar.first, 0); // == 4
    head.writeUInt32LE(4 + headerSize, 4);      // H = 8+align4(J)  (header pickle payload size)
    head.writeUInt32LE(headerSize, 8);          // 4+align4(J)      (string pickle payload size)
    fs.writeSync(out, head, 0, 12, 0);
    fs.writeSync(out, headerBuf, 0, headerSize, 12);

    let pos = 12 + headerSize;
    const CHUNK = 4 * 1024 * 1024;
    for (const { buf } of plan) {
      for (let i = 0; i < buf.length; i += CHUNK) {
        fs.writeSync(out, buf, i, Math.min(CHUNK, buf.length - i), pos + i);
      }
      pos += buf.length;
    }
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
}
