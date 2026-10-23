import { discoverSampleBlocks } from './problem-samples';

const observedRoots = new WeakSet<HTMLElement>();

/** Restyle native Prism actions without replacing their clipboard/fill listeners. */
function enhanceSampleActions(root: HTMLElement) {
    discoverSampleBlocks(root).forEach(({ code, id, kind }) => {
        const block = code.parentElement?.parentElement;
        if (!block?.classList.contains('code-toolbar')) return;
        const toolbar = block.querySelector<HTMLElement>(':scope > .toolbar');
        if (!toolbar) return;
        block.classList.add('oi33-sample-block');
        if (kind === 'input' && !toolbar.querySelector('.scratchpad-fill-button')) {
            const item = document.createElement('div');
            item.className = 'toolbar-item scratchpad-fill-button';
            const link = document.createElement('a');
            link.href = '#';
            link.addEventListener('click', (event) => {
                event.preventDefault();
                // Match the native fill action: change test input only, never submit or run code.
                const store = (window as any).store;
                if (!store?.dispatch) return;
                store.dispatch({
                    type: 'SCRATCHPAD_PRETEST_DATA_CHANGE',
                    payload: { type: 'input', value: code.textContent || '' },
                });
            });
            item.appendChild(link);
            toolbar.appendChild(item);
        }
        toolbar.querySelectorAll<HTMLAnchorElement>(':scope > .toolbar-item > a').forEach((link) => {
            const fill = link.parentElement?.classList.contains('scratchpad-fill-button');
            if (!fill && !['Copy', '复制'].includes(link.textContent?.trim() || '')
                && !link.classList.contains('oi33-sample-action--copy')) return;
            const label = fill ? '填充到自测' : '复制';
            if (link.textContent !== label) link.textContent = label;
            link.classList.add('oi33-sample-action', fill ? 'oi33-sample-action--fill' : 'oi33-sample-action--copy');
            const description = fill ? `将样例输入 ${id} 填充到自测`
                : `复制样例${kind === 'input' ? '输入' : '输出'} ${id}`;
            link.title = description;
            link.setAttribute('aria-label', description);
        });
    });
}

export function installSampleActions(root: HTMLElement) {
    enhanceSampleActions(root);
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    // The highlighter loads asynchronously; also cover replaced/PJAX samples.
    new MutationObserver((records) => {
        if (records.some((record) => Array.from(record.addedNodes).some((node) => node.nodeType === 1))) {
            enhanceSampleActions(root);
        }
    }).observe(root, { childList: true, subtree: true });
}
