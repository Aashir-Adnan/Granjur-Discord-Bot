import { Transform } from "stream";

/**
 * Wraps raw Opus packets from Discord into a valid OGG Opus container.
 * Produces a playable .ogg file that VLC, ffmpeg, and browsers can open.
 */
export class OggOpusEncoder extends Transform {
  constructor(options = {}) {
    super();
    this.sampleRate = options.sampleRate || 48000;
    this.channels = options.channels || 2;
    this.serialNo = Math.floor(Math.random() * 0xffffffff);
    this.pageSeqNo = 0;
    this.granulePos = BigInt(0);
    this.samplesPerFrame = 960; // 20ms at 48kHz
    this.headerWritten = false;
  }

  _transform(chunk, encoding, callback) {
    if (!this.headerWritten) {
      this._writeHeaders();
      this.headerWritten = true;
    }
    this.granulePos += BigInt(this.samplesPerFrame);
    this.push(this._createPage(chunk, this.granulePos, 0x00));
    callback();
  }

  _flush(callback) {
    // Write an empty page with EOS flag
    this.push(this._createPage(Buffer.alloc(0), this.granulePos, 0x04));
    callback();
  }

  _writeHeaders() {
    // OpusHead
    const opusHead = Buffer.alloc(19);
    opusHead.write("OpusHead", 0, 8, "ascii");
    opusHead.writeUInt8(1, 8); // version
    opusHead.writeUInt8(this.channels, 9);
    opusHead.writeUInt16LE(0, 10); // pre-skip
    opusHead.writeUInt32LE(this.sampleRate, 12);
    opusHead.writeInt16LE(0, 16); // output gain
    opusHead.writeUInt8(0, 18); // channel mapping family
    this.push(this._createPage(opusHead, BigInt(0), 0x02)); // BOS flag

    // OpusTags
    const vendor = "discordbot";
    const vendorBuf = Buffer.alloc(4 + vendor.length);
    vendorBuf.writeUInt32LE(vendor.length, 0);
    vendorBuf.write(vendor, 4, "ascii");
    const commentCount = Buffer.alloc(4);
    commentCount.writeUInt32LE(0, 0);
    const opusTags = Buffer.concat([
      Buffer.from("OpusTags", "ascii"),
      vendorBuf,
      commentCount,
    ]);
    this.push(this._createPage(opusTags, BigInt(0), 0x00));
  }

  _createPage(data, granulePos, flags) {
    const headerSize = 27;
    const segCount = data.length === 0 ? 1 : Math.ceil(data.length / 255);
    const segTable = Buffer.alloc(segCount);

    let remaining = data.length;
    for (let i = 0; i < segCount; i++) {
      if (remaining >= 255) {
        segTable[i] = 255;
        remaining -= 255;
      } else {
        segTable[i] = remaining;
        remaining = 0;
      }
    }

    const header = Buffer.alloc(headerSize);
    header.write("OggS", 0, 4, "ascii");
    header.writeUInt8(0, 4); // version
    header.writeUInt8(flags, 5);
    // granule position (64-bit)
    header.writeBigInt64LE(granulePos, 6);
    header.writeUInt32LE(this.serialNo, 14);
    header.writeUInt32LE(this.pageSeqNo++, 18);
    header.writeUInt32LE(0, 22); // checksum placeholder
    header.writeUInt8(segCount, 26);

    const page = Buffer.concat([header, segTable, data]);

    // Calculate CRC32 for OGG
    const crc = oggCrc32(page);
    page.writeUInt32LE(crc, 22);

    return page;
  }
}

// OGG uses a specific CRC32 polynomial (0x04C11DB7)
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let r = i << 24;
  for (let j = 0; j < 8; j++) {
    r = (r << 1) ^ ((r & 0x80000000) ? 0x04c11db7 : 0);
  }
  crcTable[i] = r >>> 0;
}

function oggCrc32(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ crcTable[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0;
  }
  return crc;
}
