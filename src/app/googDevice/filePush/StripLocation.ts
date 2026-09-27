// Removes location data from images in the browser, before they are uploaded,
// so it never leaves the uploader's device.
//
// - JPEG: empties the EXIF GPS IFD in place (orientation, dates etc. are kept)
//   and drops XMP segments.
// - PNG: drops eXIf chunks and XMP iTXt chunks.
// - WebP: drops EXIF and XMP chunks.
// - Other images (HEIC, AVIF, TIFF, ...): re-encoded to JPEG through a canvas,
//   which carries no metadata. Fails if the browser can't decode them.
// - GIF, BMP and non-image files are passed through unchanged.

const EXIF_HEADER = 'Exif\0\0';
const XMP_HEADERS = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0'];
const GPS_IFD_TAG = 0x8825;
// Byte size of each TIFF field type, indexed by type id
const TIFF_TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
const PASS_THROUGH_RE = /\.(gif|bmp)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp|heic|heif|avif|tiff?|dng)$/i;
const JPEG_QUALITY = 0.92;

function startsWith(bytes: Uint8Array, offset: number, text: string): boolean {
    if (offset + text.length > bytes.length) {
        return false;
    }
    for (let i = 0; i < text.length; i++) {
        if (bytes[offset + i] !== text.charCodeAt(i)) {
            return false;
        }
    }
    return true;
}

function isJpeg(bytes: Uint8Array): boolean {
    return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array): boolean {
    return startsWith(bytes, 0, '\x89PNG\r\n\x1a\n');
}

function isWebp(bytes: Uint8Array): boolean {
    return startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WEBP');
}

// Empties the GPS IFD of the TIFF structure in bytes[start, end). Entries and
// their out-of-line values are zeroed, so offsets elsewhere stay valid.
function clearGpsIfd(bytes: Uint8Array, start: number, end: number): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let little: boolean;
    if (startsWith(bytes, start, 'II')) {
        little = true;
    } else if (startsWith(bytes, start, 'MM')) {
        little = false;
    } else {
        throw Error('Unsupported EXIF byte order');
    }
    const inRange = (offset: number, length: number) => offset >= start && offset + length <= end;
    const ifd0 = start + view.getUint32(start + 4, little);
    if (!inRange(ifd0, 2)) {
        throw Error('Invalid EXIF data');
    }
    const ifd0Count = view.getUint16(ifd0, little);
    let gpsIfd = -1;
    for (let i = 0; i < ifd0Count; i++) {
        const entry = ifd0 + 2 + i * 12;
        if (!inRange(entry, 12)) {
            throw Error('Invalid EXIF data');
        }
        if (view.getUint16(entry, little) === GPS_IFD_TAG) {
            gpsIfd = start + view.getUint32(entry + 8, little);
        }
    }
    if (gpsIfd < 0) {
        return;
    }
    if (!inRange(gpsIfd, 2)) {
        throw Error('Invalid EXIF GPS data');
    }
    const gpsCount = view.getUint16(gpsIfd, little);
    const entriesLength = 2 + gpsCount * 12 + 4; // count + entries + next IFD offset
    if (!inRange(gpsIfd, entriesLength)) {
        throw Error('Invalid EXIF GPS data');
    }
    for (let i = 0; i < gpsCount; i++) {
        const entry = gpsIfd + 2 + i * 12;
        const type = view.getUint16(entry + 2, little);
        const count = view.getUint32(entry + 4, little);
        const size = (TIFF_TYPE_SIZE[type] || 1) * count;
        if (size > 4) {
            const valueOffset = start + view.getUint32(entry + 8, little);
            if (inRange(valueOffset, size)) {
                bytes.fill(0, valueOffset, valueOffset + size);
            }
        }
    }
    // A count of 0 followed by a zero next-IFD offset is a valid empty IFD
    bytes.fill(0, gpsIfd, gpsIfd + entriesLength);
}

export function stripJpegLocation(input: Uint8Array): Uint8Array {
    const bytes = input.slice();
    const keep: Array<[number, number]> = [];
    let copyFrom = 0;
    let pos = 2;
    while (pos + 4 <= bytes.length) {
        if (bytes[pos] !== 0xff) {
            throw Error('Invalid JPEG structure');
        }
        const marker = bytes[pos + 1];
        if (marker === 0xff) {
            pos++; // fill byte
            continue;
        }
        if (marker === 0xda || marker === 0xd9) {
            break; // start of scan / end of image: no more metadata segments
        }
        if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            pos += 2;
            continue;
        }
        const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
        const dataStart = pos + 4;
        const segmentEnd = pos + 2 + length;
        if (length < 2 || segmentEnd > bytes.length) {
            throw Error('Invalid JPEG segment');
        }
        if (marker === 0xe1) {
            if (startsWith(bytes, dataStart, EXIF_HEADER)) {
                clearGpsIfd(bytes, dataStart + EXIF_HEADER.length, segmentEnd);
            } else if (XMP_HEADERS.some((header) => startsWith(bytes, dataStart, header))) {
                keep.push([copyFrom, pos]);
                copyFrom = segmentEnd;
            }
        }
        pos = segmentEnd;
    }
    keep.push([copyFrom, bytes.length]);
    const total = keep.reduce((sum, [from, to]) => sum + (to - from), 0);
    const output = new Uint8Array(total);
    let offset = 0;
    keep.forEach(([from, to]) => {
        output.set(bytes.subarray(from, to), offset);
        offset += to - from;
    });
    return output;
}

export function stripPngLocation(bytes: Uint8Array): Uint8Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts: Uint8Array[] = [bytes.subarray(0, 8)];
    let pos = 8;
    while (pos + 12 <= bytes.length) {
        const length = view.getUint32(pos);
        const chunkEnd = pos + 12 + length;
        if (chunkEnd > bytes.length) {
            throw Error('Invalid PNG chunk');
        }
        const isExif = startsWith(bytes, pos + 4, 'eXIf');
        const isXmp = startsWith(bytes, pos + 4, 'iTXt') && startsWith(bytes, pos + 8, 'XML:com.adobe.xmp\0');
        if (!isExif && !isXmp) {
            parts.push(bytes.subarray(pos, chunkEnd));
        }
        pos = chunkEnd;
    }
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach((part) => {
        output.set(part, offset);
        offset += part.length;
    });
    return output;
}

export function stripWebpLocation(bytes: Uint8Array): Uint8Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts: Uint8Array[] = [];
    let vp8xFlagsOffset = -1;
    let outputLength = 12;
    let pos = 12;
    while (pos + 8 <= bytes.length) {
        const size = view.getUint32(pos + 4, true);
        const chunkEnd = pos + 8 + size + (size % 2);
        if (chunkEnd > bytes.length) {
            throw Error('Invalid WebP chunk');
        }
        if (!startsWith(bytes, pos, 'EXIF') && !startsWith(bytes, pos, 'XMP ')) {
            if (startsWith(bytes, pos, 'VP8X')) {
                vp8xFlagsOffset = outputLength + 8;
            }
            parts.push(bytes.subarray(pos, chunkEnd));
            outputLength += chunkEnd - pos;
        }
        pos = chunkEnd;
    }
    const output = new Uint8Array(outputLength);
    output.set(bytes.subarray(0, 12), 0);
    let offset = 12;
    parts.forEach((part) => {
        output.set(part, offset);
        offset += part.length;
    });
    new DataView(output.buffer).setUint32(4, outputLength - 8, true);
    if (vp8xFlagsOffset >= 0) {
        output[vp8xFlagsOffset] &= ~(0x08 | 0x04); // EXIF and XMP present flags
    }
    return output;
}

async function reencodeAsJpeg(file: File): Promise<File> {
    let bitmap: ImageBitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch (error) {
        throw Error(`can't remove location from "${file.name}" (this browser can't read this image type)`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) {
        throw Error('Failed to get 2d context from canvas');
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) {
        throw Error(`Failed to re-encode "${file.name}"`);
    }
    const name = file.name.replace(/\.[^.]*$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified });
}

export async function stripLocation(file: File): Promise<File> {
    const isImage = file.type.startsWith('image/') || IMAGE_EXT_RE.test(file.name);
    if (!isImage || PASS_THROUGH_RE.test(file.name) || file.type === 'image/gif' || file.type === 'image/bmp') {
        return file;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let strip: ((bytes: Uint8Array) => Uint8Array) | undefined;
    if (isJpeg(bytes)) {
        strip = stripJpegLocation;
    } else if (isPng(bytes)) {
        strip = stripPngLocation;
    } else if (isWebp(bytes)) {
        strip = stripWebpLocation;
    }
    if (strip) {
        try {
            const stripped = strip(bytes);
            return new File([stripped], file.name, { type: file.type, lastModified: file.lastModified });
        } catch (error) {
            console.warn(`[StripLocation] "${file.name}": ${(error as Error).message}, re-encoding instead`);
        }
    }
    return reencodeAsJpeg(file);
}
