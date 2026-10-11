/**
 * Image sniffing.
 *
 * The declared `Content-Type` is attacker-controlled and therefore advisory
 * only: the stored type is always the one derived from the bytes themselves.
 * This keeps a caller from having, say, an HTML or SVG payload served back
 * later under an `image/jpeg` label.
 */

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** The only types accepted, chosen because they are what iOS cameras produce. */
export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
] as const;

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** ISO-BMFF brands that identify a HEIF/HEIC still image. */
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'mif1',
  'msf1',
]);

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  if (buffer.length < signature.length) {
    return false;
  }

  return signature.every((byte, index) => buffer[index] === byte);
}

/**
 * Identifies an image by its magic bytes.
 *
 * @returns the detected media type, or `null` when the bytes are not one of
 *   the supported image formats.
 */
export function detectImageType(buffer: Buffer): SupportedImageType | null {
  // JPEG: SOI marker followed by any further marker.
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }

  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }

  // HEIC: an ISO-BMFF `ftyp` box whose major brand is a HEIF still-image brand.
  // Layout: 4-byte box size, then "ftyp", then the 4-character brand.
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');

    if (HEIC_BRANDS.has(brand)) {
      return 'image/heic';
    }
  }

  return null;
}
