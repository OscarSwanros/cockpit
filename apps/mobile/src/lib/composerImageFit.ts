import {
  downscalableImageMimeType,
  fitImageAttachmentSize,
  IMAGE_ATTACHMENT_MAX_BYTES,
} from "@t3tools/client-runtime/image-attachment-size";
import {
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";

import { estimateBase64ByteSize } from "./base64";

const PHOTO_JPEG_QUALITY = 0.85;

/**
 * Renders an image to a JPEG, or a PNG when `format` asks for one, with its long edge capped at
 * `IMAGE_ATTACHMENT_MAX_EDGE`. Decode, downscale,
 * and encode run natively; only the bounded result crosses the bridge. Camera photos are
 * 12-48 MP HEIC files, so a full-size conversion is both slow to transfer and far more than a
 * model can use.
 */
export async function renderPhoto(
  uri: string,
  format: "jpeg" | "png" = "jpeg",
): Promise<{ base64: string; uri: string }> {
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  let image = await ImageManipulator.manipulate(uri).renderAsync();
  try {
    const fittedSize = fitImageAttachmentSize(image);
    if (fittedSize !== null) {
      const resized = await ImageManipulator.manipulate(image).resize(fittedSize).renderAsync();
      image.release();
      image = resized;
    }
    const saved = await image.saveAsync({
      format: format === "png" ? SaveFormat.PNG : SaveFormat.JPEG,
      compress: PHOTO_JPEG_QUALITY,
      base64: true,
    });
    if (!saved.base64) {
      throw new Error("The rendered photo has no bytes.");
    }
    return { base64: saved.base64, uri: saved.uri };
  } finally {
    image.release();
  }
}

/** Keeps an attachment's name truthful once it has been rendered to a JPEG. */
export function jpegAttachmentName(name: string): string {
  return /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, "")}.jpg`;
}

function isOverMaxEdge(base64: string): boolean {
  const header = atob(base64.slice(0, Math.ceil(IMAGE_DIMENSIONS_HEADER_BYTES / 3) * 4));
  const bytes = new Uint8Array(header.length);
  for (let index = 0; index < header.length; index += 1) bytes[index] = header.charCodeAt(index);
  const dimensions = readImageDimensions(bytes);
  return dimensions !== null && fitImageAttachmentSize(dimensions) !== null;
}

/**
 * Fits an attachment to `IMAGE_ATTACHMENT_MAX_EDGE` and `IMAGE_ATTACHMENT_MAX_BYTES`. A PNG or
 * JPEG over the edge is scaled to it in its own format. An image still over the byte limit,
 * including a GIF or WebP, is rendered to a JPEG instead, so the result can change type. Returns
 * null when the image already fits or the native renderer fails, so the caller keeps the
 * original bytes. Images inside both limits are never re-encoded: only the header is read.
 */
export async function fitComposerImage(image: {
  readonly uri: string;
  readonly mimeType: string;
  readonly base64: string;
}): Promise<{ base64: string; uri: string; mimeType: "image/png" | "image/jpeg" } | null> {
  const mimeType = downscalableImageMimeType(image.mimeType);
  try {
    if (mimeType !== null && isOverMaxEdge(image.base64)) {
      const scaled = await renderPhoto(image.uri, mimeType === "image/png" ? "png" : "jpeg");
      if (
        mimeType === "image/jpeg" ||
        estimateBase64ByteSize(scaled.base64) <= IMAGE_ATTACHMENT_MAX_BYTES
      ) {
        return { ...scaled, mimeType };
      }
    } else if (estimateBase64ByteSize(image.base64) <= IMAGE_ATTACHMENT_MAX_BYTES) {
      return null;
    }
    return { ...(await renderPhoto(image.uri)), mimeType: "image/jpeg" };
  } catch (error) {
    console.warn("[composer-images] could not scale an oversized image", error);
    return null;
  }
}
