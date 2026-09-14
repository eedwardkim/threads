/** Minimal image headers: enough bytes for format sniffing, not decodable pictures. */

export function png(width: number, height: number, padTo = 0): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(33, padTo));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

export function gif(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(16);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, width & 0xff, width >> 8, height & 0xff, height >> 8]);
  return bytes;
}

export function jpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  // SOI, APP0 (length 16), SOF0 with height/width, EOI and padding.
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

export function webpLossless(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 20, 0, 0, 0, 0x2f]);
  const bits = (width - 1) | ((height - 1) << 14);
  bytes[21] = bits & 0xff; bytes[22] = (bits >> 8) & 0xff; bytes[23] = (bits >> 16) & 0xff; bytes[24] = (bits >>> 24) & 0xff;
  return bytes;
}
