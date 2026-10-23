const observedRoots = new WeakSet<HTMLElement>();

/** Restyle native Prism actions without replacing their clipboard/fill listeners. */
function enhanceSampleActions(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
        const sample = code.className.match(/(?:^|\s)language-(input|output)(\d+)(?=\s|$)/);
        if (!sample) return;
        const block = code.parentElement?.parentElement;
        if (!block?.classList.contains('code-toolbar')) return;
        const toolbar = block.querySelector<HTMLElement>(':scope > .toolbar');
        if (!toolbar) return;
        block.classList.add('oi33-sample-block');
        toolbar.querySelectorAll<HTMLAnchorElement>(':scope > .toolbar-item > a').forEach((link) => {
            const fill = link.parentElement?.classList.contains('scratchpad-fill-button');
            if (!fill && !['Copy', '复制'].includes(link.textContent?.trim() || '')
                && !link.classList.contains('oi33-sample-action--copy')) return;
            const label = fill ? '填充到自测' : '复制';
            if (link.textContent !== label) link.textContent = label;
            link.classList.add('oi33-sample-action', fill ? 'oi33-sample-action--fill' : 'oi33-sample-action--copy');
            const description = fill ? `将样例输入 ${sample[2]} 填充到自测`
                : `复制样例${sample[1] === 'input' ? '输入' : '输出'} ${sample[2]}`;
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
