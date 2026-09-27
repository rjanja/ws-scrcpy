import { ManagerClient } from '../../client/ManagerClient';
import { ParamsBase } from '../../../types/ParamsBase';
import { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import { ChannelCode } from '../../../common/ChannelCode';
import { MediaFile } from '../../../common/MediaFile';
import { PushTargetResolver } from '../filePush/AdbkitFilePushStream';
import Util from '../../Util';

const APK_RE = /\.apk$/i;
const APK_DIR = '/data/local/tmp';
const DOWNLOAD_DIR = '/sdcard/Download';

// Opens a file-listing channel for the stream page, so files dropped on the
// video can be pushed with adb to a directory picked by file type.
export class DevicePushClient extends ManagerClient<ParamsBase, never> implements PushTargetResolver {
    constructor(params: ParamsBase, private readonly serial: string) {
        super(params);
        this.openNewConnection();
    }

    public getSocket(): Multiplexer | undefined {
        return this.ws instanceof Multiplexer ? this.ws : undefined;
    }

    public getPath(fileName: string): string {
        if (APK_RE.test(fileName)) {
            return APK_DIR;
        }
        if (MediaFile.isMediaFileName(fileName)) {
            return MediaFile.PICTURES_DIR;
        }
        return DOWNLOAD_DIR;
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelInitData(): Buffer {
        const serial = Util.stringToUtf8ByteArray(this.serial);
        const buffer = Buffer.alloc(4 + 4 + serial.byteLength);
        buffer.write(ChannelCode.FSLS, 'ascii');
        buffer.writeUInt32LE(serial.length, 4);
        buffer.set(serial, 8);
        return buffer;
    }

    protected onSocketOpen(): void {
        // Nothing to do. Pushes open their own channels.
    }

    protected onSocketMessage(): void {
        // Nothing to do. Pushes open their own channels.
    }

    protected onSocketClose(): void {
        // Nothing to do. Pushes open their own channels.
    }
}
