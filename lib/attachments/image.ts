import type { AttachmentMediaType } from "../types";

/** Largest upload accepted after the client has downscaled; matches the database check constraint. */
export const MAX_ATTACHMENT_BYTES = 6 * 1024 * 1024;
export const MAX_ATTACHMENT_EDGE = 8192;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
/** Long edge the client downscales to before upload: keeps small text legible while staying inside provider limits. */
export const UPLOAD_LONG_EDGE = 2048;

export const ATTACHMENT_MEDIA_TYPES: readonly AttachmentMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export interface ImageInfo {
  mediaType: AttachmentMediaType;
  width: number;
  height: number;
}

export function isAttachmentMediaType(value: string): value is AttachmentMediaType {
  return (ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}
function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}
function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}
function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function pngInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
  return { mediaType: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function gifInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 10) return null;
  return { mediaType: "image/gif", width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function jpegInfo(bytes: Uint8Array): ImageInfo | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      offset += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mediaType: "image/jpeg", height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    offset += 2 + length;
  }
  return null;
}

function webpInfo(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 30 || ascii(bytes, 8, 4) !== "WEBP") return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 ") return { mediaType: "image/webp", width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { mediaType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { mediaType: "image/webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  return null;
}

/**
 * Identifies the image format from its bytes (never from the client-declared type) and reads the
 * pixel dimensions from the header. Returns null for anything that is not a supported still image.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 12) return null;
  let info: ImageInfo | null = null;
  if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) info = pngInfo(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) info = jpegInfo(bytes);
  else if (ascii(bytes, 0, 4) === "RIFF") info = webpInfo(bytes);
  else if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") info = gifInfo(bytes);
  if (!info || info.width <= 0 || info.height <= 0) return null;
  return info;
}

/** Extension-agnostic, provider-agnostic sanity limits applied on the server. */
export function validateImage(bytes: Uint8Array): ImageInfo {
  if (bytes.length === 0) throw new RangeError("The image is empty.");
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new RangeError(`Images must be under ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`);
  const info = sniffImage(bytes);
  if (!info) throw new RangeError("Only PNG, JPEG, WebP and GIF images are supported.");
  if (info.width > MAX_ATTACHMENT_EDGE || info.height > MAX_ATTACHMENT_EDGE) throw new RangeError(`Images must be at most ${MAX_ATTACHMENT_EDGE} pixels on each side.`);
  return info;
}

export function safeAttachmentName(name: string, mediaType: AttachmentMediaType): string {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  if (trimmed) return trimmed;
  return `image.${mediaType === "image/jpeg" ? "jpg" : mediaType.slice("image/".length)}`;
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
