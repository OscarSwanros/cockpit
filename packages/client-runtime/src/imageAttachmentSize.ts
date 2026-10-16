/**
 * Longest edge, in pixels, a PNG or JPEG attachment keeps. Anthropic rejects an image over
 * 2000px on a side once a request holds more than 20 images, and Claude Code forwards images
 * sent into a running turn unchanged, so one large paste breaks every later request in that
 * thread. Web and mobile scale attachments down to this edge when they are attached.
 */
export const IMAGE_ATTACHMENT_MAX_EDGE = 2000;

/**
 * Largest file, in bytes, an image attachment keeps. Anthropic rejects an image whose base64
 * is over 5 MB, and for the same mid-turn reason a heavier image ends the running Claude turn.
 * This is that limit in decoded bytes; web and mobile re-encode anything heavier when it is
 * attached, well below the `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` wire cap.
 */
export const IMAGE_ATTACHMENT_MAX_BYTES = ((5 * 1024 * 1024) / 4) * 3;

/** Formats a client re-encodes in place. GIF, WebP, and SVG are left as attached. */
export type DownscalableImageMimeType = "image/png" | "image/jpeg";

export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

/**
 * The size an image should be scaled to so its long edge fits `IMAGE_ATTACHMENT_MAX_EDGE`,
 * keeping its aspect ratio. Returns null when it already fits.
 */
export function fitImageAttachmentSize(size: {
  readonly width: number;
  readonly height: number;
}): { width: number; height: number } | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null;
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.height * scale))),
  };
}
