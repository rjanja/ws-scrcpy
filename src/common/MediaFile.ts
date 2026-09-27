const MEDIA_EXT_RE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|avif|mp4|m4v|mov|webm|3gp|mkv)$/i;
const SHARED_STORAGE_RE = /^\/(sdcard|storage)\//;

export class MediaFile {
    public static readonly PICTURES_DIR = '/sdcard/Pictures';

    public static isMediaFileName(fileName: string): boolean {
        return MEDIA_EXT_RE.test(fileName);
    }

    // Files outside shared storage (e.g. /data/local/tmp) are invisible to MediaStore anyway
    public static needsMediaScan(filePath: string): boolean {
        return SHARED_STORAGE_RE.test(filePath) && MediaFile.isMediaFileName(filePath);
    }
}
