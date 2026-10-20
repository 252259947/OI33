export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 40;

type Editor = {
    getOption: (id: number) => number;
    updateOptions: (options: { fontSize?: number; mouseWheelZoom?: boolean }) => void;
    onDidDispose: (listener: () => void) => { dispose: () => void };
};

const bindings = new WeakSet<Editor>();

/** Keep zoom local to this code editor; Monaco's built-in wheel zoom is global. */
export function installEditorWheelZoom(
    editor: Editor,
    container: HTMLElement,
    fontSizeOption: number,
    onChange: (size: number) => void,
) {
    if (bindings.has(editor)) return;
    editor.updateOptions({ mouseWheelZoom: false });
    const clamp = (size: number) => Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(size)));
    const update = (size: number) => {
        editor.updateOptions({ fontSize: size });
        onChange(size);
    };
    const initial = editor.getOption(fontSizeOption);
    if (Number.isFinite(initial) && initial !== clamp(initial)) update(clamp(initial));
    const wheel = (event: WheelEvent) => {
        if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey
            || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
        // Consume even at the bounds, otherwise Chrome would zoom the whole page.
        event.preventDefault();
        event.stopImmediatePropagation();
        const current = editor.getOption(fontSizeOption);
        if (!Number.isFinite(current)) return;
        const next = clamp(current + (event.deltaY < 0 ? 1 : -1));
        if (next !== current) update(next);
    };
    container.addEventListener('wheel', wheel, { capture: true, passive: false });
    const disposed = editor.onDidDispose(() => {
        container.removeEventListener('wheel', wheel, { capture: true });
        bindings.delete(editor);
        disposed.dispose();
    });
    bindings.add(editor);
}
