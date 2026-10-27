type NativeReducer = (state: any, action: any) => any;
type DraftStore = {
    getState: () => any;
    replaceReducer: (reducer: NativeReducer) => void;
};
type DraftStorage = Pick<Storage, 'setItem'>;
type DraftStatus = { failed: boolean; fields: string[] };

export function editorDraftKey(user: any, context: any): string | null {
    if (!Number.isSafeInteger(user?._id) || !context?.pdoc?.domainId || context.pdoc.docId == null) return null;
    const key = `${user._id}/${context.pdoc.domainId}/${context.pdoc.docId}`;
    return context.tdoc?._id ? `${key}@${context.tdoc._id}` : key;
}

/** Scratchpad caches are best effort; requests and in-memory editing remain native. */
export function createEditorDraftReducer(nativeReducer: NativeReducer, key: string, storage: DraftStorage,
    onStatus: (status: DraftStatus) => void = () => {}) {
    const failures = new Set<string>();
    const cached = new Map<string, { value: string; field: string }>();
    const persistCache = (cacheKey: string, value: string, field: string) => {
        cached.set(cacheKey, { value, field });
        try {
            storage.setItem(cacheKey, value);
            failures.delete(field);
        } catch {
            failures.add(field);
        }
        onStatus({ failed: failures.size > 0, fields: Array.from(failures) });
    };
    const persist = (field: 'code' | 'lang', value: string) =>
        persistCache(field === 'code' ? key : `${key}#lang`, value, field);
    return {
        reducer(state: any, action: any) {
            const field = action.type === 'SCRATCHPAD_EDITOR_UPDATE_CODE' ? 'code'
                : action.type === 'SCRATCHPAD_EDITOR_SET_LANG' ? 'lang' : null;
            if (!field && !['SCRATCHPAD_UI_SET_VISIBILITY', 'SCRATCHPAD_UI_TOGGLE_VISIBILITY',
                'SCRATCHPAD_SETTING_UPDATE'].includes(action.type)) return nativeReducer(state, action);
            // React's handlers already captured dispatch. replaceReducer fixes
            // that actual dispatch chain, rather than wrapping store.dispatch.
            const next = nativeReducer(state, { type: 'OI33_EDITOR_DRAFT_IN_MEMORY' });
            if (action.type === 'SCRATCHPAD_SETTING_UPDATE') {
                const { setting, value } = action.payload;
                const config = { ...next.ui.settings.config, [setting]: value };
                persistCache('editor.config', JSON.stringify(config), 'settings');
                return { ...next, ui: { ...next.ui, settings: { ...next.ui.settings, config } } };
            }
            if (!field) {
                const { uiElement } = action.payload;
                const visible = action.type === 'SCRATCHPAD_UI_TOGGLE_VISIBILITY'
                    ? !next.ui[uiElement].visible : action.payload.visibility;
                persistCache(`scratchpad/${uiElement}`, String(visible), uiElement);
                return { ...next, ui: { ...next.ui, [uiElement]: { ...next.ui[uiElement], visible } } };
            }
            const result = { ...next, editor: { ...next.editor, [field]: action.payload } };
            persist(field, String(action.payload ?? ''));
            return result;
        },
        save(editor: { code?: string; lang?: string }) {
            persist('code', String(editor.code ?? ''));
            persist('lang', String(editor.lang ?? ''));
            for (const [cacheKey, entry] of cached) {
                if (entry.field !== 'code' && entry.field !== 'lang') persistCache(cacheKey, entry.value, entry.field);
            }
        },
        isFailed: () => failures.size > 0,
    };
}

type Guard = { mount: (root: HTMLElement) => void };
const installed = new WeakMap<DraftStore, Promise<Guard>>();

export async function installEditorDraftGuard(root: HTMLElement, store: DraftStore, user: any, context: any) {
    const key = editorDraftKey(user, context);
    if (!key || typeof store.replaceReducer !== 'function') return;
    let pending = installed.get(store);
    if (!pending) {
        pending = (async () => {
            // Lazy: native reducers reference problem UiContext during module
            // initialization, so never evaluate them on unrelated site pages.
            const { default: nativeReducer } = await import('@hydrooj/ui-default/oi33-native-scratchpad-reducer');
            let warning: HTMLElement | undefined;
            const storage: DraftStorage = { setItem: (name, value) => window.localStorage.setItem(name, value) };
            const guard = createEditorDraftReducer(nativeReducer, key, storage, () => {
                // Redux forbids getState during a reducer. Update the UI only
                // after the in-memory state has committed.
                queueMicrotask(() => { if (warning) warning.hidden = !guard.isFailed(); });
            });
            store.replaceReducer(guard.reducer);
            const beforeUnload = (event: BeforeUnloadEvent) => {
                if (!guard.isFailed()) return;
                event.preventDefault();
                event.returnValue = '';
            };
            window.addEventListener('beforeunload', beforeUnload);
            return {
                mount(target: HTMLElement) {
                    if (warning?.isConnected) return;
                    const toolbar = target.querySelector('.scratchpad__toolbar');
                    if (!toolbar) return;
                    warning = document.createElement('div');
                    warning.className = 'oi33-editor-draft-warning';
                    warning.hidden = !guard.isFailed();
                    warning.setAttribute('role', 'status');
                    const text = document.createElement('span');
                    text.textContent = '草稿或编辑器设置未完整保存到此浏览器；当前代码仍可运行和提交，离开前请下载备份。';
                    const backup = document.createElement('button');
                    backup.type = 'button';
                    backup.textContent = '下载代码';
                    backup.addEventListener('click', () => {
                        const editor = store.getState().editor;
                        const extension = /^(cc|cpp|c\+\+)/.test(editor.lang) ? 'cpp' : /^py/.test(editor.lang) ? 'py' : 'txt';
                        const url = URL.createObjectURL(new Blob([String(editor.code ?? '')], { type: 'text/plain;charset=utf-8' }));
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = `${String(context.pdoc.pid || context.pdoc.docId).replace(/[^\w.-]/g, '_')}-backup.${extension}`;
                        link.click();
                        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                    });
                    const retry = document.createElement('button');
                    retry.type = 'button';
                    retry.textContent = '重试保存';
                    retry.addEventListener('click', () => guard.save(store.getState().editor));
                    warning.append(text, backup, retry);
                    toolbar.after(warning);
                    // A remounted editor keeps the same native store and guard.
                    target.dataset.oi33DraftGuard = '1';
                },
            };
        })();
        installed.set(store, pending);
    }
    try {
        (await pending).mount(root);
    } catch (error) {
        installed.delete(store);
        // A broken integration must be visible, never silently called protected.
        console.error('Editor draft protection could not initialize', error);
        root.dataset.oi33DraftGuard = 'failed';
    }
}
