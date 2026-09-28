import { TypedEmitter } from '../../common/TypedEmitter';

// Audio messages from the device server: "scrcpy_audio__", u8 kind, then
//   kind 0 (config): u8 codec (0 = unavailable, 1 = AAC-LC), i32 sampleRate, u8 channels, codec config (AudioSpecificConfig)
//   kind 1 (packet): i64 pts (µs), encoded frame
const KIND_CONFIG = 0;
const KIND_PACKET = 1;
const CODEC_UNAVAILABLE = 0;
const CODEC_AAC = 1;

// Scheduling ahead of the current time absorbs network jitter; beyond the maximum, audio is dropped to catch up
const TARGET_LATENCY_S = 0.1;
const MAX_LATENCY_S = 0.4;

export type AudioState = 'off' | 'waiting-for-gesture' | 'playing' | 'unavailable' | 'unsupported';

interface AudioStreamPlayerEvents {
    state: AudioState;
}

const TAG = '[AudioStreamPlayer]';

/**
 * Decodes the device audio stream with WebCodecs and plays it through Web Audio.
 */
export class AudioStreamPlayer extends TypedEmitter<AudioStreamPlayerEvents> {
    public static readonly MAGIC_BYTES = new TextEncoder().encode('scrcpy_audio__');

    private context?: AudioContext;
    private decoder?: AudioDecoder;
    private nextTime = 0;
    private enabled = false;
    private state: AudioState = 'off';

    public static isSupported(): boolean {
        return typeof AudioDecoder === 'function' && typeof AudioContext === 'function';
    }

    public getState(): AudioState {
        return this.state;
    }

    private setState(state: AudioState): void {
        if (this.state !== state) {
            this.state = state;
            this.emit('state', state);
        }
    }

    /**
     * Start playback. Browsers (iOS Safari in particular) only allow audio to start from a user gesture: when called outside of one,
     * playback starts on the next tap, click or key press anywhere on the page.
     */
    public enable(): void {
        if (!AudioStreamPlayer.isSupported()) {
            this.setState('unsupported');
            return;
        }
        this.enabled = true;
        if (!this.context) {
            this.context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
            this.context.addEventListener('statechange', this.updatePlaybackState);
        }
        this.resume();
        this.addGestureListeners();
        this.updatePlaybackState();
    }

    public disable(): void {
        this.enabled = false;
        this.removeGestureListeners();
        this.closeDecoder();
        if (this.context && this.context.state === 'running') {
            this.context.suspend().catch(() => {
                // ignore
            });
        }
        this.setState('off');
    }

    public release(): void {
        this.disable();
        if (this.context) {
            this.context.removeEventListener('statechange', this.updatePlaybackState);
            this.context.close().catch(() => {
                // ignore
            });
            this.context = undefined;
        }
    }

    public handleMessage(data: Uint8Array): void {
        if (!this.enabled || data.length <= AudioStreamPlayer.MAGIC_BYTES.length) {
            return;
        }
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        let offset = AudioStreamPlayer.MAGIC_BYTES.length;
        const kind = view.getUint8(offset++);
        if (kind === KIND_CONFIG) {
            const codec = view.getUint8(offset++);
            const sampleRate = view.getInt32(offset);
            offset += 4;
            const channels = view.getUint8(offset++);
            const config = data.slice(offset);
            this.configure(codec, sampleRate, channels, config);
        } else if (kind === KIND_PACKET) {
            const pts = Number(view.getBigInt64(offset));
            offset += 8;
            if (this.decoder && this.decoder.state === 'configured') {
                this.decoder.decode(
                    new EncodedAudioChunk({ type: 'key', timestamp: pts, data: data.subarray(offset) }),
                );
            }
        }
    }

    private configure(codec: number, sampleRate: number, channels: number, description: Uint8Array): void {
        this.closeDecoder();
        if (codec === CODEC_UNAVAILABLE) {
            console.warn(TAG, 'Audio is not available on this device');
            this.setState('unavailable');
            return;
        }
        if (codec !== CODEC_AAC) {
            console.error(TAG, `Unknown audio codec: ${codec}`);
            this.setState('unsupported');
            return;
        }
        const config: AudioDecoderConfig = {
            codec: 'mp4a.40.2',
            sampleRate,
            numberOfChannels: channels,
            description,
        };
        const decoder = new AudioDecoder({
            output: (audioData) => this.play(audioData),
            error: (error) => {
                console.error(TAG, 'Audio decoding error', error);
                if (this.decoder === decoder) {
                    this.decoder = undefined;
                }
            },
        });
        AudioDecoder.isConfigSupported(config)
            .then(({ supported }) => {
                if (!supported) {
                    throw new Error('AAC decoding is not supported');
                }
                if (decoder.state !== 'closed') {
                    decoder.configure(config);
                }
            })
            .catch((error) => {
                console.error(TAG, error);
                this.setState('unsupported');
            });
        this.decoder = decoder;
        this.nextTime = 0;
    }

    private play(audioData: AudioData): void {
        const context = this.context;
        try {
            if (!context || context.state !== 'running') {
                return; // not started yet (waiting for a user gesture) or disabled
            }
            const frames = audioData.numberOfFrames;
            const channels = audioData.numberOfChannels;
            const buffer = context.createBuffer(channels, frames, audioData.sampleRate);
            for (let channel = 0; channel < channels; channel++) {
                const samples = new Float32Array(frames);
                audioData.copyTo(samples, { planeIndex: channel, format: 'f32-planar' });
                buffer.copyToChannel(samples, channel);
            }

            const now = context.currentTime;
            if (this.nextTime < now || this.nextTime - now > MAX_LATENCY_S) {
                // Underrun (or too far behind): restart with the target latency
                this.nextTime = now + TARGET_LATENCY_S;
            }
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            source.start(this.nextTime);
            this.nextTime += buffer.duration;
        } finally {
            audioData.close();
        }
    }

    private closeDecoder(): void {
        if (this.decoder && this.decoder.state !== 'closed') {
            this.decoder.close();
        }
        this.decoder = undefined;
    }

    private resume = (): void => {
        if (this.enabled && this.context && this.context.state !== 'running') {
            this.context.resume().catch(() => {
                // needs a user gesture: retried on the next one
            });
        }
    };

    private updatePlaybackState = (): void => {
        if (!this.enabled) {
            return;
        }
        if (this.state === 'unavailable' || this.state === 'unsupported') {
            return;
        }
        if (this.context && this.context.state === 'running') {
            this.removeGestureListeners();
            this.setState('playing');
        } else {
            this.setState('waiting-for-gesture');
        }
    };

    private addGestureListeners(): void {
        ['touchend', 'click', 'keydown'].forEach((type) => document.addEventListener(type, this.resume, true));
    }

    private removeGestureListeners(): void {
        ['touchend', 'click', 'keydown'].forEach((type) => document.removeEventListener(type, this.resume, true));
    }
}
