/* 打包 paperloom/ 为 paperloom.xpi（zip，store+deflate），不依赖外部工具 */
const fs = require("fs"), path = require("path"), zlib = require("zlib");

const SRC = path.join(__dirname, "paperloom");
const OUT = path.join(__dirname, "paperloom.xpi");

function walk(dir, base = "") {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

const files = walk(SRC);
const required = ["manifest.json", "bootstrap.js", "prefs.js"];
for (const r of required) {
  if (!files.some(f => f.rel === r)) { console.error("缺少必需文件: " + r); process.exit(1); }
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const chunks = [], central = [];
let offset = 0;
for (const f of files) {
  const data = fs.readFileSync(f.full);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = comp.length < data.length;
  const body = useDeflate ? comp : data;
  const method = useDeflate ? 8 : 0;
  const name = Buffer.from(f.rel, "utf8");
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
  lh.writeUInt16LE(method, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  chunks.push(lh, name, body);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
  ch.writeUInt32LE(0, 42); ch.writeUInt32LE(offset, 42);
  central.push(ch, name);
  offset += lh.length + name.length + body.length;
}

const cd = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);

fs.writeFileSync(OUT, Buffer.concat([...chunks, cd, eocd]));
console.log("打包完成: " + OUT + "  (" + files.length + " 个文件, " + (fs.statSync(OUT).size / 1024).toFixed(1) + " KB)");
for (const f of files) console.log("  " + f.rel);
