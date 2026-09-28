import { ToolBox } from '../../toolbox/ToolBox';
import KeyEvent from '../android/KeyEvent';
import SvgImage from '../../ui/SvgImage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';
import { BasePlayer } from '../../player/BasePlayer';
import { AudioState, AudioStreamPlayer } from '../../audio/AudioStreamPlayer';

const BUTTONS = [
    {
        title: 'Power',
        code: KeyEvent.KEYCODE_POWER,
        icon: SvgImage.Icon.POWER,
    },
    {
        title: 'Volume up',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: SvgImage.Icon.VOLUME_UP,
    },
    {
        title: 'Volume down',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: SvgImage.Icon.VOLUME_DOWN,
    },
    {
        title: 'Back',
        code: KeyEvent.KEYCODE_BACK,
        icon: SvgImage.Icon.BACK,
    },
    {
        title: 'Home',
        code: KeyEvent.KEYCODE_HOME,
        icon: SvgImage.Icon.HOME,
    },
    {
        title: 'Overview',
        code: KeyEvent.KEYCODE_APP_SWITCH,
        icon: SvgImage.Icon.OVERVIEW,
    },
];

export interface GoogToolBoxOptions {
    // Start with keyboard capture enabled instead of requiring the user to tick
    // the "Capture keyboard" checkbox first.
    captureKeyboard?: boolean;
}

export class GoogToolBox extends ToolBox {
    protected constructor(list: ToolBoxElement<any>[]) {
        super(list);
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        moreBox?: HTMLElement,
        options: GoogToolBoxOptions = {},
    ): GoogToolBox {
        const playerName = player.getName();
        const list = BUTTONS.slice();
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            type: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.code) {
                return;
            }
            const { code } = element.optional;
            const action = type === 'mousedown' ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
            const event = new KeyCodeControlMessage(action, code, 0, 0);
            client.sendMessage(event);
        };
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, {
                code: item.code,
            });
            button.addEventListener('mousedown', handler);
            button.addEventListener('mouseup', handler);
            return button;
        });
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        if (AudioStreamPlayer.isSupported()) {
            const audio = new ToolBoxCheckbox('Audio', SvgImage.Icon.HEADSET, `audio_${udid}_${playerName}`);
            const input = audio.getElement();
            input.checked = client.isAudioEnabled();
            audio.addEventListener('click', (_, el) => {
                client.setAudioEnabled(el.getElement().checked);
            });
            const titles: Record<AudioState, string> = {
                off: 'Audio',
                'waiting-for-gesture': 'Audio (tap anywhere to start)',
                playing: 'Audio',
                unavailable: 'Audio (not available on this device)',
                unsupported: 'Audio (not supported by this browser)',
            };
            client.setAudioStateListener((state) => {
                audio.getAllElements().forEach((element) => {
                    element.title = titles[state];
                });
            });
            elements.push(audio);
        }

        const fullscreen = new ToolBoxButton('Full screen', SvgImage.Icon.FULLSCREEN);
        fullscreen.addEventListener('click', () => {
            client.setImmersive(true);
        });
        elements.push(fullscreen);

        const upload = new ToolBoxButton('Upload photos', SvgImage.Icon.ADD_PHOTO);
        upload.addEventListener('click', () => {
            client.chooseFilesToPush();
        });
        elements.push(upload);

        const keyboard = new ToolBoxCheckbox(
            'Capture keyboard',
            SvgImage.Icon.KEYBOARD,
            `capture_keyboard_${udid}_${playerName}`,
        );
        keyboard.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.setHandleKeyboardEvents(element.checked);
        });
        if (options.captureKeyboard) {
            keyboard.getElement().checked = true;
            client.setHandleKeyboardEvents(true);
        }
        elements.push(keyboard);

        if (moreBox) {
            const displayId = player.getVideoSettings().displayId;
            const id = `show_more_${udid}_${playerName}_${displayId}`;
            const more = new ToolBoxCheckbox('More', SvgImage.Icon.MORE, id);
            more.addEventListener('click', (_, el) => {
                const element = el.getElement();
                moreBox.style.display = element.checked ? 'block' : 'none';
            });
            elements.unshift(more);
        }
        return new GoogToolBox(elements);
    }
}
