import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const version = pkg.version;

const distDir = join(root, 'dist');
const releaseDir = join(root, 'release');

if (!existsSync(distDir)) {
  console.error('❌ dist 目录不存在，请先运行 pnpm build');
  process.exit(1);
}

if (!existsSync(releaseDir)) {
  mkdirSync(releaseDir, { recursive: true });
}

const zipName = `chrome-bridge-v${version}.zip`;
const zipPath = join(releaseDir, zipName);

/**
 * Minimal zip writer (no external deps)
 * Uses STORED (no compression) for simplicity and compatibility.
 */

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d = new Date()) {
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  return { date, time };
}

function collectFiles(dir, base = '') {
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store') continue;
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) {
      entries.push(...collectFiles(full, rel));
    } else {
      entries.push({ abs: full, rel });
    }
  }
  return entries;
}

function writeZip() {
  const files = collectFiles(distDir);
  const centralDir = [];
  const offsets = [];
  const stream = createWriteStream(zipPath);
  const { date, time } = dosDateTime();

  let offset = 0;

  stream.on('finish', () => {
    console.log(`✅ 已生成: ${zipPath} (${files.length} 个文件)`);
  });

  for (const file of files) {
    const data = readFileSync(file.abs);
    const crc = crc32(data);
    const compressed = deflateRaw(data);
    const useCompression = compressed.length < data.length;
    const stored = useCompression ? compressed : data;
    const method = useCompression ? 8 : 0;

    // Local file header
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);  // signature
    localHeader.writeUInt16LE(20, 4);           // version needed
    localHeader.writeUInt16LE(0, 6);            // flags
    localHeader.writeUInt16LE(method, 8);       // compression method
    localHeader.writeUInt16LE(time, 10);        // mod time
    localHeader.writeUInt16LE(date, 12);        // mod date
    localHeader.writeUInt32LE(crc, 14);         // crc32
    localHeader.writeUInt32LE(stored.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22);   // uncompressed size
    localHeader.writeUInt16LE(file.rel.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28);           // extra field length

    const nameBuf = Buffer.from(file.rel, 'utf-8');
    const localData = Buffer.concat([localHeader, nameBuf, stored]);
    stream.write(localData);

    // Central directory record
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);       // signature
    central.writeUInt16LE(20, 4);               // version made by
    central.writeUInt16LE(20, 6);               // version needed
    central.writeUInt16LE(0, 8);                // flags
    central.writeUInt16LE(method, 10);          // compression method
    central.writeUInt16LE(time, 12);            // mod time
    central.writeUInt16LE(date, 14);            // mod date
    central.writeUInt32LE(crc, 16);             // crc32
    central.writeUInt32LE(stored.length, 20);   // compressed size
    central.writeUInt32LE(data.length, 24);     // uncompressed size
    central.writeUInt16LE(file.rel.length, 28); // filename length
    central.writeUInt16LE(0, 30);               // extra field length
    central.writeUInt16LE(0, 32);               // comment length
    central.writeUInt16LE(0, 34);               // disk number
    central.writeUInt16LE(0, 36);               // internal attrs
    central.writeUInt32LE(0, 38);               // external attrs
    central.writeUInt32LE(offset, 42);          // local header offset

    centralDir.push(Buffer.concat([central, nameBuf]));
    offset += localData.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const entry of centralDir) {
    stream.write(entry);
    cdSize += entry.length;
  }

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // signature
  eocd.writeUInt16LE(0, 4);                // disk number
  eocd.writeUInt16LE(0, 6);                // disk with CD
  eocd.writeUInt16LE(files.length, 8);     // entries on this disk
  eocd.writeUInt16LE(files.length, 10);    // total entries
  eocd.writeUInt32LE(cdSize, 12);          // CD size
  eocd.writeUInt32LE(cdStart, 16);         // CD offset
  eocd.writeUInt16LE(0, 20);               // comment length
  stream.write(eocd);
  stream.end();
}

function deflateRaw(data) {
  return deflateRawSync(data);
}

writeZip();
