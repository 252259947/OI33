export type PublicSample = { id: string; input: string; output: string | null };
type Store = { getState: () => any; dispatch: (action: any) => any; subscribe: (listener: () => void) => () => void };
type Run = { input: string; sample?: PublicSample; rid?: string; error?: string; record?: any };
const RUNNING = new Set([0, 20, 21, 22]);
const MAX_COMPARE_LENGTH = 200000;
const MAX_DISPLAY_LENGTH = 32000;
const STATUS_LABELS: Record<number, string> = {
    2: '答案状态异常', 3: '运行超时', 4: '内存超限', 5: '输出超限', 6: '运行出错',
    7: '编译失败', 8: '系统错误', 9: '已取消', 10: '未知错误', 11: '运行失败',
    30: '已忽略', 31: '格式错误', 32: '运行结束', 33: '运行失败',
};

export function readPublicSamples(root: ParentNode): PublicSample[] {
    const samples = new Map<string, PublicSample>();
    root.querySelectorAll<HTMLElement>('pre code[class*="language-input"]').forEach((code) => {
        const match = code.className.match(/(?:^|\s)language-input(\d*)(?:\s|$)/);
        if (!match) return;
        const id = match[1] || '1';
        if (samples.has(id)) return;
        const scope = code.closest('.richmedia') || root;
        const output = scope.querySelector<HTMLElement>(`pre code.language-output${match[1]}`);
        samples.set(id, { id, input: code.textContent || '', output: output?.textContent ?? null });
    });
    return [...samples.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

export function compareSampleText(expected: string, actual: string) {
    if (expected.length > MAX_COMPARE_LENGTH || actual.length > MAX_COMPARE_LENGTH) {
        return { kind: 'large', message: '输出较长，请下载或查看完整记录后自行核对。' };
    }
    const left = expected.replace(/\r\n?/g, '\n');
    const right = actual.replace(/\r\n?/g, '\n');
    if (left === right) return { kind: 'same', message: '与本次样例输出文本一致；不代表整题通过。' };
    if (left.trim().split(/\s+/).join(' ') === right.trim().split(/\s+/).join(' ')) {
        return { kind: 'whitespace', message: '仅空白字符不同，请核对空格与换行；是否通过以正式评测为准。' };
    }
    let index = 0;
    while (index < Math.min(left.length, right.length) && left[index] === right[index]) index += 1;
    const prefix = left.slice(0, index).split('\n');
    return {
        kind: 'different',
        message: `文本不同：首个差异约在第 ${prefix.length} 行、第 ${prefix[prefix.length - 1].length + 1} 列。多解或特殊判题不能据此判断错误。`,
    };
}

function plainOutput(value: unknown) {
    // Judge messages may contain ANSI colors. Render all remaining content as text, never HTML.
    return String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function pretestResult(record: any, sample?: PublicSample) {
    if (!record || RUNNING.has(record.status)) {
        return { status: '正在等待运行结果…', kind: 'pending', actual: '', comparison: '' };
    }
    const actual = plainOutput(record.testCases?.[0]?.message);
    if (record.status !== 1) return {
        status: STATUS_LABELS[record.status] || '运行未成功',
        kind: 'error',
        actual: [record.compilerTexts?.join('\n'), actual].filter(Boolean).map(plainOutput).join('\n'),
        comparison: '本次未运行成功，不进行样例输出对照。',
    };
    const compared = sample?.output !== null && sample?.output !== undefined && record.testCases?.length
        ? compareSampleText(sample.output, actual) : null;
    return {
        status: '运行成功，不代表整题通过',
        kind: compared?.kind || 'custom',
        actual,
        comparison: compared?.message || (sample
            ? '没有可对照的公开输出或运行输出，请自行核对。'
            : '自定义输入没有标准输出，请自行核对运行结果。'),
    };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

function displayed(value: string) {
    return value.length > MAX_DISPLAY_LENGTH
        ? `${value.slice(0, MAX_DISPLAY_LENGTH)}\n…显示已截断，请查看完整运行记录。` : value;
}

/** UI-only sample comparison. Nothing here changes a judge result or a submission score. */
export function installPretestFeedback(root: HTMLElement, store: Store, recordUrl?: (rid: string) => string) {
    const samples = readPublicSamples(root.querySelector('.problem-content') || root);
    let sampleId = '';
    let customInput = false;
    let run: Run | undefined;
    let panel: HTMLElement | undefined;
    let select: HTMLSelectElement;
    let input: HTMLTextAreaElement;
    let expected: HTMLElement;
    let actual: HTMLElement;
    let status: HTMLElement;
    let comparison: HTMLElement;
    let stale: HTMLElement;
    let executedInput: HTMLElement;
    let outputLabel: HTMLElement;
    let recordLink: HTMLAnchorElement;
    let resources: HTMLElement;
    let lastRender = '';

    const currentSample = () => samples.find((sample) => sample.id === sampleId);
    const render = () => {
        if (!panel?.isConnected) return;
        const state = store.getState();
        const currentInput = String(state.pretest?.input || '');
        if (input.value !== currentInput) input.value = currentInput;
        if (run?.rid && state.records?.items?.[run.rid]) run.record = state.records.items[run.rid];
        const record = run?.record;
        const view = run?.error
            ? { status: '自测未提交成功', kind: 'error', actual: '', comparison: run.error }
            : run ? pretestResult(record, run.sample)
                : { status: '选择样例或输入数据后，点击「运行自测 (F9)」。', kind: 'idle', actual: '', comparison: '' };
        const changed = !!run && currentInput !== run.input;
        const selected = run?.sample || (!run ? currentSample() : undefined);
        const expectedText = selected?.output ?? (run ? '本次自定义输入没有标准输出。' : '选择公开样例后显示预期输出。');
        const metrics = record && view.kind !== 'pending' ? [
            Number.isFinite(record.time) ? `${record.time} ms` : '',
            Number.isFinite(record.memory) ? `${record.memory} KiB` : '',
        ].filter(Boolean).join(' · ') : '';
        const snapshot = JSON.stringify([view, changed, expectedText, selected?.id, sampleId, run?.input, run?.rid, metrics]);
        if (snapshot === lastRender) return;
        lastRender = snapshot;
        select.value = sampleId;
        status.textContent = view.status;
        resources.textContent = metrics;
        const url = run?.rid && recordUrl?.(run.rid);
        recordLink.hidden = !url;
        if (url) recordLink.href = url;
        panel.dataset.result = view.kind;
        comparison.textContent = view.comparison;
        stale.hidden = !changed;
        executedInput.textContent = displayed(run?.input || '') || '（空输入）';
        outputLabel.textContent = run ? `本次预期输出${selected ? ` · 样例 ${selected.id}` : ''}` : '预期输出';
        expected.textContent = displayed(expectedText) || '（空输出）';
        actual.textContent = displayed(view.actual) || (view.kind === 'pending' || view.kind === 'idle' ? '等待运行…' : '（无输出）');
    };
    const mount = () => {
        const nativeInput = root.querySelector<HTMLTextAreaElement>('textarea.scratchpad__data-input');
        const nativePanel = nativeInput?.closest('.splitpane-fill');
        if (!nativePanel || panel?.isConnected) return;
        nativePanel.classList.add('oi33-pretest-host');
        panel = element('section', 'oi33-pretest-feedback');
        panel.setAttribute('aria-label', '自测与公开样例对照');
        const header = element('div', 'oi33-pretest-feedback__toolbar');
        const label = element('label', 'oi33-pretest-feedback__sample', '测试数据');
        select = element('select', 'select');
        select.setAttribute('aria-label', '选择自测样例');
        const custom = element('option', '', samples.length ? '自定义输入' : '自定义输入（无公开样例）');
        custom.value = '';
        select.append(custom);
        samples.forEach((sample) => {
            const option = element('option', '', `样例 ${sample.id}`);
            option.value = sample.id;
            select.append(option);
        });
        select.addEventListener('change', () => {
            sampleId = select.value;
            customInput = !sampleId;
            const sample = currentSample();
            if (sample) store.dispatch({
                type: 'SCRATCHPAD_PRETEST_DATA_CHANGE', payload: { type: 'input', value: sample.input },
            });
            render();
        });
        label.append(select);
        recordLink = element('a', 'oi33-pretest-feedback__record', '运行详情');
        recordLink.target = '_blank';
        recordLink.rel = 'noopener';
        recordLink.hidden = true;
        header.append(label, element('span', 'oi33-pretest-feedback__note', '仅核对公开样例；多解/特殊判题以正式评测为准。'), recordLink);
        status = element('div', 'oi33-pretest-feedback__status');
        status.setAttribute('role', 'status');
        resources = element('span', 'oi33-pretest-feedback__resources');
        const summary = element('div', 'oi33-pretest-feedback__summary');
        summary.append(status, resources);
        comparison = element('div', 'oi33-pretest-feedback__comparison');
        stale = element('details', 'oi33-pretest-feedback__stale');
        stale.hidden = true;
        executedInput = element('pre', '');
        stale.append(element('summary', '', '输入已修改；下方结果仍对应上次运行，点击查看当时输入。'), executedInput);
        const grid = element('div', 'oi33-pretest-feedback__grid');
        const inputColumn = element('label', 'oi33-pretest-feedback__column');
        input = element('textarea', 'oi33-pretest-feedback__input');
        input.setAttribute('aria-label', '自测输入');
        input.spellcheck = false;
        input.wrap = 'off';
        input.placeholder = '输入测试数据（可留空）';
        input.addEventListener('input', () => {
            sampleId = '';
            customInput = true;
            store.dispatch({ type: 'SCRATCHPAD_PRETEST_DATA_CHANGE', payload: { type: 'input', value: input.value } });
            render();
        });
        inputColumn.append(element('span', '', '输入（可编辑）'), input);
        const expectedColumn = element('div', 'oi33-pretest-feedback__column');
        outputLabel = element('span', '', '预期输出');
        expected = element('pre', '');
        expectedColumn.append(outputLabel, expected);
        const actualColumn = element('div', 'oi33-pretest-feedback__column');
        actual = element('pre', '');
        actualColumn.append(element('span', '', '本次实际输出 / 运行信息'), actual);
        grid.append(inputColumn, expectedColumn, actualColumn);
        panel.append(header, summary, comparison, stale, grid);
        nativePanel.append(panel);
        lastRender = '';
        render();
    };
    const unsubscribe = store.subscribe(render);
    const detachObserver = new MutationObserver(() => {
        if (!root.isConnected) {
            unsubscribe();
            detachObserver.disconnect();
        }
    });
    detachObserver.observe(document.body, { childList: true, subtree: true });
    mount();
    return {
        mount,
        autofill() {
            if (store.getState().pretest?.input !== '' || sampleId || customInput || !samples.length) return;
            sampleId = samples[0].id;
            store.dispatch({ type: 'SCRATCHPAD_PRETEST_DATA_CHANGE', payload: { type: 'input', value: samples[0].input } });
        },
        filledSample() {
            sampleId = samples.find((sample) => sample.input === store.getState().pretest?.input)?.id || '';
            customInput = !sampleId;
            render();
        },
        start(inputValue: string) {
            const sample = currentSample();
            run = { input: inputValue, sample: sample?.input === inputValue ? sample : undefined };
            render();
            return run;
        },
        bindRecord(snapshot: Run, rid: string) {
            if (!rid || rid === 'undefined') snapshot.error = '未收到自测记录，请稍后重试。';
            else snapshot.rid = rid;
            if (run === snapshot) render();
        },
        fail(snapshot: Run, error: unknown) {
            snapshot.error = error instanceof Error ? error.message : '请稍后重试。';
            if (run === snapshot) render();
        },
        dispose() {
            unsubscribe();
            detachObserver.disconnect();
        },
    };
}
