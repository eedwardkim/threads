"use client";

import { useSyncExternalStore } from "react";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, UPLOAD_LONG_EDGE, formatBytes } from "./attachments/image";
import { registerPrivateState } from "./client-state";
import type { Attachment } from "./types";

export type PendingAttachment =
  | { localId: string; name: string; previewUrl: string; status: "uploading"; attachment: null; error: null }
  | { localId: string; name: string; previewUrl: string; status: "ready"; attachment: Attachment; error: null }
  | { localId: string; name: string; previewUrl: string; status: "failed"; attachment: null; error: string };

const EMPTY: readonly PendingAttachment[] = [];
const listeners = new Set<() => void>();
let scopes = new Map<string, readonly PendingAttachment[]>();

registerPrivateState(() => {
  for (const list of scopes.values()) for (const item of list) URL.revokeObjectURL(item.previewUrl);
  scopes = new Map();
  emit();
});

function emit() {
  for (const listener of listeners) listener();
}

function update(scope: string, localId: string, patch: (item: PendingAttachment) => PendingAttachment) {
  const list = scopes.get(scope);
  if (!list?.some((item) => item.localId === localId)) return;
  scopes = new Map(scopes).set(scope, list.map((item) => item.localId === localId ? patch(item) : item));
  emit();
}

const RE_ENCODABLE = /^image\/(bmp|avif|heic|heif|tiff|svg\+xml|png|jpeg|webp|gif|x-icon)$/;

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Prepares a browser file for upload: images over the long-edge budget (or in formats the server
 * does not store) are decoded and re-encoded in the browser, so the upload is bounded regardless of
 * the original camera resolution. Small PNG/JPEG/WebP/GIF files are sent byte-for-byte.
 */
export async function prepareImage(file: File): Promise<{ blob: Blob; name: string }> {
  if (!isImageFile(file) && !RE_ENCODABLE.test(file.type)) throw new Error("Only images can be attached.");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name} is not an image the browser can read.`);
  try {
    const stored = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (stored && longEdge <= UPLOAD_LONG_EDGE && file.size <= MAX_ATTACHMENT_BYTES) return { blob: file, name: file.name };
    const scale = Math.min(1, UPLOAD_LONG_EDGE / longEdge);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot resize images.");
    context.drawImage(bitmap, 0, 0, width, height);
    // Photos compress well as JPEG; anything with an alpha channel or crisp text stays lossless.
    const photo = file.type === "image/jpeg" || file.type === "image/heic" || file.type === "image/heif";
    const type = photo ? "image/jpeg" : "image/png";
    let blob = await encode(canvas, type, photo ? 0.9 : undefined);
    if (blob.size > MAX_ATTACHMENT_BYTES) blob = await encode(canvas, "image/jpeg", 0.82);
    if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is too large even after resizing (limit ${formatBytes(MAX_ATTACHMENT_BYTES)}).`);
    return { blob, name: file.name.replace(/\.[^.]+$/, "") + (type === "image/jpeg" ? ".jpg" : ".png") };
  } finally {
    bitmap.close();
  }
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The image could not be encoded.")), type, quality));
}

async function upload(chatId: string, name: string, blob: Blob, signal?: AbortSignal): Promise<Attachment> {
  const query = new URLSearchParams({ chat: chatId, name });
  const response = await fetch(`/api/attachments?${query}`, { method: "POST", body: blob, headers: { "Content-Type": "application/octet-stream" }, signal });
  const body = await response.json().catch(() => null) as { attachment?: Attachment; error?: string } | null;
  if (!response.ok || !body?.attachment) throw new Error(body?.error ?? `Upload failed (${response.status}).`);
  return body.attachment;
}

function list(scope: string): readonly PendingAttachment[] {
  return scopes.get(scope) ?? EMPTY;
}

/** Adds files to a composer scope and uploads them; returns the number of files that were skipped for the per-message limit. */
async function add(scope: string, chatId: string, files: Iterable<File>): Promise<number> {
  const images = [...files].filter(isImageFile);
  const room = MAX_ATTACHMENTS_PER_MESSAGE - list(scope).length;
  const accepted = images.slice(0, Math.max(0, room));
  const entries = accepted.map((file) => ({ file, item: {
    localId: crypto.randomUUID(), name: file.name, previewUrl: URL.createObjectURL(file), status: "uploading" as const, attachment: null, error: null,
  } }));
  if (entries.length > 0) {
    scopes = new Map(scopes).set(scope, [...list(scope), ...entries.map((entry) => entry.item)]);
    emit();
  }
  await Promise.all(entries.map(async ({ file, item }) => {
    try {
      const prepared = await prepareImage(file);
      const attachment = await upload(chatId, prepared.name, prepared.blob);
      update(scope, item.localId, (current) => ({ ...current, status: "ready", attachment, error: null }));
    } catch (error) {
      update(scope, item.localId, (current) => ({ ...current, status: "failed", attachment: null, error: error instanceof Error ? error.message : "Upload failed." }));
    }
  }));
  return images.length - accepted.length;
}

function remove(scope: string, localId: string): void {
  const item = list(scope).find((entry) => entry.localId === localId);
  if (!item) return;
  URL.revokeObjectURL(item.previewUrl);
  scopes = new Map(scopes).set(scope, list(scope).filter((entry) => entry.localId !== localId));
  emit();
  if (item.attachment) void fetch(`/api/attachments?id=${encodeURIComponent(item.attachment.id)}`, { method: "DELETE" }).catch(() => undefined);
}

/** Forgets the uploads of a sent message without deleting them on the server (they now belong to that message). */
function clear(scope: string): void {
  for (const item of list(scope)) URL.revokeObjectURL(item.previewUrl);
  const next = new Map(scopes);
  next.delete(scope);
  scopes = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePendingAttachments(scope: string): readonly PendingAttachment[] {
  return useSyncExternalStore(subscribe, () => list(scope), () => EMPTY);
}

export const attachmentStore = { add, remove, clear, list };
