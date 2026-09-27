const TAG = '[StreamReconnector]';

// Browsers suspend background tabs (iOS drops their sockets) and the stream
// can't be resumed in place, so reload the page once the connection is gone
// and the server is reachable again. A reload restores the stream from the
// URL, the same as a manual refresh.
export class StreamReconnector {
    // The device repeats the last frame while the screen is static, so a
    // visible stream that delivers nothing for this long is dead.
    private static readonly STALL_TIMEOUT_MS = 4000;
    private static readonly FIRST_RETRY_MS = 1000;
    private static readonly MAX_RETRY_MS = 30000;

    private lastDataTime = Date.now();
    private disconnected = false;
    private released = false;
    private retryDelay = StreamReconnector.FIRST_RETRY_MS;
    private retryTimer?: number;
    private stallTimer?: number;
    private overlay?: HTMLElement;

    constructor() {
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        window.addEventListener('pageshow', this.onPageShow);
        window.addEventListener('online', this.onOnline);
    }

    public onData(): void {
        this.lastDataTime = Date.now();
    }

    public onDisconnected(): void {
        if (this.released || this.disconnected) {
            return;
        }
        console.log(TAG, 'Connection lost');
        this.disconnected = true;
        this.showOverlay();
        this.scheduleRetry(0);
    }

    // Stop watching, e.g. when the user stops the stream on purpose
    public release(): void {
        this.released = true;
        window.clearTimeout(this.retryTimer);
        window.clearTimeout(this.stallTimer);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        window.removeEventListener('pageshow', this.onPageShow);
        window.removeEventListener('online', this.onOnline);
        this.overlay?.remove();
        this.overlay = undefined;
    }

    private onVisibilityChange = (): void => {
        if (document.visibilityState !== 'visible') {
            return;
        }
        if (this.disconnected) {
            this.scheduleRetry(0);
            return;
        }
        // After a suspension the socket can still look open while carrying nothing
        const becameVisible = Date.now();
        window.clearTimeout(this.stallTimer);
        this.stallTimer = window.setTimeout(() => {
            if (this.lastDataTime < becameVisible && document.visibilityState === 'visible') {
                this.onDisconnected();
            }
        }, StreamReconnector.STALL_TIMEOUT_MS);
    };

    private onPageShow = (event: PageTransitionEvent): void => {
        // Restored from the back/forward cache: the old socket is gone
        if (event.persisted) {
            this.onDisconnected();
        }
    };

    private onOnline = (): void => {
        if (this.disconnected) {
            this.scheduleRetry(0);
        }
    };

    private scheduleRetry(delay: number): void {
        window.clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(this.tryReload, delay);
    }

    private tryReload = async (): Promise<void> => {
        if (this.released || document.visibilityState !== 'visible') {
            return; // retried when the page becomes visible again
        }
        try {
            // Only reload when the server answers, so an outage doesn't leave the browser's error page
            const response = await fetch(location.pathname, { cache: 'no-store' });
            if (response.ok) {
                location.reload();
                return;
            }
        } catch (error) {
            // server or network still unavailable
        }
        this.scheduleRetry(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, StreamReconnector.MAX_RETRY_MS);
    };

    private showOverlay(): void {
        if (this.overlay) {
            return;
        }
        const overlay = document.createElement('div');
        overlay.className = 'reconnect-overlay';
        overlay.innerText = 'Reconnecting…';
        document.body.appendChild(overlay);
        this.overlay = overlay;
    }
}
