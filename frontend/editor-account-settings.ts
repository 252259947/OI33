import { isEditorTheme } from '../model/editor-settings-policy';

export type EditorAppearance = { fontSize: number; tabSize: number; theme: string };
type Patch = Partial<EditorAppearance>;
type Snapshot = { uid: number; settings: Patch | null; unavailable?: boolean };
type SyncState = 'local' | 'saving' | 'saved' | 'failed';
type Options = {
    snapshot: Snapshot;
    storage: Pick<Storage, 'getItem' | 'setItem'>;
    defaultTheme: string;
    load: () => Promise<Snapshot>;
    save: (patch: Patch, initialize: boolean) => Promise<Snapshot>;
    onChange: (settings: EditorAppearance) => void;
    onStatus: (state: SyncState) => void;
};

function validSettings(value: any): Patch {
    const result: Patch = {};
    if (Number.isInteger(value?.fontSize) && value.fontSize >= 10 && value.fontSize <= 40) result.fontSize = value.fontSize;
    if ([2, 4, 8].includes(value?.tabSize)) result.tabSize = value.tabSize;
    if (typeof value?.theme === 'string' && isEditorTheme(value.theme)) result.theme = value.theme;
    return result;
}

/** Only these three preferences are shared; source code and problem data stay local. */
export function createEditorSettingsSync(options: Options) {
    const { storage, snapshot, onChange, onStatus } = options;
    const key = `oi33/editor-settings/${snapshot.uid}`;
    const readText = (name: string) => {
        try { return storage.getItem(name); } catch { return null; }
    };
    const read = (name: string) => {
        try { return JSON.parse(readText(name) || 'null'); } catch { return null; }
    };
    const write = (name: string, value: string) => {
        try { storage.setItem(name, value); } catch { /* Cloud saving still works without local storage. */ }
    };
    const cached = read(key);
    const defaults = { fontSize: 14, tabSize: 4, theme: options.defaultTheme };
    let settings: EditorAppearance = { ...defaults, ...validSettings(cached?.settings) };
    let pending: Patch = validSettings(cached?.pending);
    let ready = !snapshot.unavailable;
    let initialize = snapshot.settings === null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running: Promise<void> | undefined;
    let disposed = false;
    let changes = 0;
    const status = (state: SyncState) => { if (!disposed) onStatus(state); };
    const persist = () => write(key, JSON.stringify({ settings, pending }));
    const accept = (incoming: Snapshot) => {
        if (incoming.uid !== snapshot.uid || incoming.unavailable) throw new Error('编辑器设置账号已改变或服务暂不可用');
        if (incoming.settings) settings = { ...defaults, ...validSettings(incoming.settings), ...pending };
        ready = true;
        initialize = incoming.settings === null;
        persist();
        if (!disposed) onChange(settings);
    };
    if (snapshot.settings && ready) settings = { ...defaults, ...validSettings(snapshot.settings), ...pending };
    else if (!cached) {
        // Assign the old, unscoped browser preferences once. A later account
        // on this computer must start from its own settings instead.
        const owner = readText('oi33/editor-settings-owner');
        if (!owner || owner === String(snapshot.uid)) {
            const legacy = validSettings(read('editor.config'));
            const theme = readText('oi33/editor-theme');
            settings = { ...defaults, ...legacy, ...(isEditorTheme(theme || '') ? { theme: theme! } : {}) };
        }
    }
    write('oi33/editor-settings-owner', String(snapshot.uid));
    settings = { ...settings, ...pending };
    persist();

    const flush = (): Promise<void> => {
        if (disposed) return Promise.resolve();
        if (timer) clearTimeout(timer);
        if (running) return running;
        running = Promise.resolve().then(async () => {
            try {
                status('saving');
                if (!ready) accept(await options.load());
                while (!disposed && (initialize || Object.keys(pending).length)) {
                    const creating = initialize;
                    const sent = creating ? { ...settings } : { ...pending };
                    const submittedPending = { ...pending };
                    const result = await options.save(sent, creating);
                    if (result.uid !== snapshot.uid || result.unavailable || !result.settings) throw new Error('编辑器设置保存失败');
                    if (!creating) for (const name of Object.keys(submittedPending) as Array<keyof EditorAppearance>) {
                        if (pending[name] === submittedPending[name]) delete pending[name];
                    }
                    accept(result);
                }
                status('saved');
            } catch {
                persist();
                status('failed');
            } finally {
                running = undefined;
            }
        });
        return running;
    };
    const schedule = () => {
        status('saving');
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void flush(), 250);
    };
    if (!ready) status('failed');
    else if (initialize || Object.keys(pending).length) schedule();
    else status('saved');
    return {
        get: () => ({ ...settings }),
        update(patch: Patch) {
            if (disposed) return;
            changes += 1;
            const valid = validSettings(patch);
            settings = { ...settings, ...valid };
            pending = { ...pending, ...valid };
            persist();
            schedule();
        },
        async reload() {
            await flush();
            const version = changes;
            try {
                const incoming = await options.load();
                if (!disposed && version === changes && !Object.keys(pending).length) {
                    accept(incoming);
                    if (initialize) schedule();
                    else status('saved');
                }
            } catch { status('failed'); }
        },
        refresh(incoming: Snapshot) {
            if (disposed || incoming.uid !== snapshot.uid) return;
            if (incoming.unavailable) { ready = false; status('failed'); return; }
            accept(incoming);
            if (initialize || Object.keys(pending).length) schedule();
        },
        flush,
        dispose() {
            disposed = true;
            if (timer) clearTimeout(timer);
        },
    };
}
