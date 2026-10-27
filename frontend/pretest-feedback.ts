import { discoverSampleBlocks } from './problem-samples';

export type PublicSample = { id: string; input: string; output: string | null };
type Store = { getState: () => any; dispatch: (action: any) => any; subscribe: (listener: () => void) => () => void };
type Run = { input: string; code: string; lang: string; sample?: PublicSample; rid?: string; error?: string; record?: any };
type InputDrafts = { sampleId: string; customChosen: boolean; values: Map<string, string> };
// The native store belongs to one account/problem/contest page. Keep drafts when
// its panel remounts, without leaking them into a different page's store.
const inputDrafts = new WeakMap<Store, InputDrafts>();
const RUNNING = new Set([0, 20, 21, 22]);
const MAX_COMPARE_LENGTH = 200000;
const MAX_DISPLAY_LENGTH = 32000;
let feedbackId = 0;
const STATUS_LABELS: Record<number, string> = {
    2: '答案状态异常', 3: '运行超时', 4: '内存超限', 5: '输出超限', 6: '运行出错',
    7: '编译失败', 8: '系统错误', 9: '已取消', 10: '未知错误', 11: '运行失败',
    30: '已忽略', 31: '格式错误', 32: '运行结束', 33: '运行失败',
};

export function readPublicSamples(root: ParentNode): PublicSample[] {
    const samples = new Map<string, PublicSample>();
    const blocks = discoverSampleBlocks(root);
    blocks.filter((block) => block.kind === 'input').forEach(({ code, id, scope }) => {
        if (samples.has(id)) return;
        const output = blocks.find((block) => block.kind === 'output' && block.id === id && block.scope === scope);
        samples.set(id, { id, input: code.textContent || '', output: output?.code.textContent ?? null });
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
    let drafts = inputDrafts.get(store);
    if (!drafts) {
        drafts = { sampleId: '', customChosen: false, values: new Map([['', String(store.getState().pretest?.input || '')]]) };
        inputDrafts.set(store, drafts);
    }
    let sampleId = drafts.sampleId;
    let customInput = drafts.customChosen;
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
    let recordLink: HTMLAnchorElement;
    let resources: HTMLElement;
    let summary: HTMLElement;
    let actualTab: HTMLButtonElement;
    let expectedTab: HTMLButtonElement;
    let runButton: HTMLButtonElement;
    let outputTab: 'actual' | 'expected' = 'actual';
    let lastRender = '';

    const currentSample = () => samples.find((sample) => sample.id === sampleId);
    const rememberInput = () => {
        drafts.values.set(sampleId, String(store.getState().pretest?.input || ''));
        drafts.sampleId = sampleId;
        drafts.customChosen = customInput;
    };
    const canRun = () => {
        const state = store.getState();
        const native = root.querySelector<HTMLButtonElement>('.scratchpad__toolbar__pretest');
        return !!native && !native.disabled
            && !state.ui?.isPosting && !state.pretest?.isRunning && !(state.ui?.pretestWaitSec > 0);
    };
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
                : { status: '', kind: 'idle', actual: '', comparison: '' };
        const changed = !!run && (currentInput !== run.input
            || String(state.editor?.code || '') !== run.code || String(state.editor?.lang || '') !== run.lang);
        const sample = currentSample();
        const selected = run?.sample || (!run && sample?.input === currentInput ? sample : undefined);
        const hasExpected = selected?.output !== null && selected?.output !== undefined;
        const expectedText = selected?.output ?? '';
        if (!hasExpected) outputTab = 'actual';
        const metrics = record && view.kind !== 'pending' ? [
            Number.isFinite(record.time) ? `${record.time} ms` : '',
            Number.isFinite(record.memory) ? `${record.memory} KiB` : '',
        ].filter(Boolean).join(' · ') : '';
        const enabled = canRun();
        const supported = !!root.querySelector('.scratchpad__toolbar__pretest');
        const waiting = Number(state.ui?.pretestWaitSec || 0);
        const snapshot = JSON.stringify([view, changed, hasExpected, expectedText, selected?.id, sampleId,
            run?.input, run?.rid, metrics, outputTab, enabled, waiting, supported]);
        if (snapshot === lastRender) return;
        lastRender = snapshot;
        select.value = sampleId;
        status.textContent = changed ? '结果已过期，请重新运行' : view.status;
        status.title = status.textContent;
        summary.hidden = !run;
        resources.textContent = metrics;
        resources.title = metrics;
        runButton.disabled = !enabled;
        runButton.title = supported ? '运行当前输入（F9）；运行成功不代表整题通过' : '当前题型或语言不支持自测';
        runButton.textContent = waiting > 0 ? `运行自测 (${Math.ceil(waiting)}s)` : '运行自测 (F9)';
        const url = run?.rid && recordUrl?.(run.rid);
        recordLink.hidden = !url;
        if (url) recordLink.href = url;
        panel.dataset.result = changed ? 'stale' : view.kind;
        comparison.textContent = view.comparison;
        comparison.title = view.comparison;
        comparison.hidden = !view.comparison;
        stale.hidden = !changed;
        if (!changed) (stale as HTMLDetailsElement).open = false;
        executedInput.textContent = displayed(run?.input || '') || '（空输入）';
        expected.textContent = displayed(expectedText) || '（空输出）';
        expected.setAttribute('aria-label', selected ? `样例 ${selected.id} 的预期输出` : '预期输出');
        expectedTab.disabled = !hasExpected;
        expectedTab.title = hasExpected ? `查看${run ? '本次运行的' : ''}样例 ${selected!.id} 预期输出` : '自定义输入没有标准输出';
        actualTab.setAttribute('aria-selected', String(outputTab === 'actual'));
        expectedTab.setAttribute('aria-selected', String(outputTab === 'expected'));
        actualTab.tabIndex = outputTab === 'actual' ? 0 : -1;
        expectedTab.tabIndex = outputTab === 'expected' ? 0 : -1;
        expected.hidden = outputTab !== 'expected';
        actual.hidden = outputTab !== 'actual';
        actual.classList.toggle('is-placeholder', view.kind === 'idle');
        actual.textContent = displayed(view.actual)
            || (view.kind === 'idle' ? '运行后查看结果' : view.kind === 'pending' ? '等待运行…' : '（无输出）');
    };
    const mount = () => {
        if (panel?.isConnected) { render(); return; }
        const nativeInput = root.querySelector<HTMLTextAreaElement>('textarea.scratchpad__data-input');
        const nativePanel = nativeInput?.closest('.splitpane-fill');
        if (!nativePanel) return;
        nativePanel.classList.add('oi33-pretest-host');
        panel = element('section', 'oi33-pretest-feedback');
        panel.setAttribute('aria-label', '自测与公开样例对照');
        const outputId = `oi33-pretest-output-${++feedbackId}`;
        const grid = element('div', 'oi33-pretest-feedback__grid');
        const inputColumn = element('div', 'oi33-pretest-feedback__column oi33-pretest-feedback__column--input');
        const inputHeader = element('div', 'oi33-pretest-feedback__column-header');
        const label = element('label', 'oi33-pretest-feedback__sample', '测试用例');
        select = element('select', 'select');
        select.setAttribute('aria-label', '选择自测样例');
        select.title = samples.length ? '选择公开样例，或填写自定义输入' : '本题无公开样例，可填写自定义输入（允许留空）';
        const custom = element('option', '', '自定义输入');
        custom.value = '';
        select.append(custom);
        samples.forEach((sample) => {
            const option = element('option', '', `样例 ${sample.id}`);
            option.value = sample.id;
            select.append(option);
        });
        select.addEventListener('change', () => {
            rememberInput();
            sampleId = select.value;
            customInput = !sampleId;
            const sample = currentSample();
            store.dispatch({
                type: 'SCRATCHPAD_PRETEST_DATA_CHANGE',
                payload: { type: 'input', value: drafts.values.get(sampleId) ?? sample?.input ?? '' },
            });
            rememberInput();
            render();
        });
        label.append(select);
        inputHeader.append(label);
        const resultColumn = element('div', 'oi33-pretest-feedback__column oi33-pretest-feedback__column--result');
        const resultHeader = element('div', 'oi33-pretest-feedback__column-header');
        const tabs = element('div', 'oi33-pretest-feedback__tabs');
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', '输出内容');
        actualTab = element('button', 'oi33-pretest-feedback__tab', '实际');
        expectedTab = element('button', 'oi33-pretest-feedback__tab', '预期');
        [actualTab, expectedTab].forEach((tab) => {
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
        });
        actualTab.setAttribute('aria-label', '实际输出');
        expectedTab.setAttribute('aria-label', '预期输出');
        actualTab.id = `${outputId}-actual-tab`;
        expectedTab.id = `${outputId}-expected-tab`;
        actualTab.setAttribute('aria-controls', `${outputId}-actual`);
        expectedTab.setAttribute('aria-controls', `${outputId}-expected`);
        actualTab.addEventListener('click', () => { outputTab = 'actual'; render(); });
        expectedTab.addEventListener('click', () => {
            if (expectedTab.disabled) return;
            outputTab = 'expected'; render();
        });
        tabs.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            if (event.key === 'Home' || expectedTab.disabled) outputTab = 'actual';
            else if (event.key === 'End') outputTab = 'expected';
            else outputTab = outputTab === 'actual' ? 'expected' : 'actual';
            render();
            (outputTab === 'actual' ? actualTab : expectedTab).focus();
        });
        tabs.append(actualTab, expectedTab);
        recordLink = element('a', 'oi33-pretest-feedback__record', '运行详情');
        recordLink.target = '_blank';
        recordLink.rel = 'noopener';
        recordLink.hidden = true;
        const heading = element('strong', 'oi33-pretest-feedback__heading', '运行结果');
        heading.title = '自测仅核对当前输入；运行成功不代表整题通过，多解或特殊判题以正式评测为准。';
        resultHeader.append(heading, tabs, recordLink);
        status = element('div', 'oi33-pretest-feedback__status');
        status.setAttribute('role', 'status');
        resources = element('span', 'oi33-pretest-feedback__resources');
        summary = element('div', 'oi33-pretest-feedback__summary');
        summary.append(status, resources);
        comparison = element('div', 'oi33-pretest-feedback__comparison');
        stale = element('details', 'oi33-pretest-feedback__stale');
        stale.hidden = true;
        executedInput = element('pre', '');
        const staleSummary = element('summary', '', '代码、语言或输入已修改 · 查看上次运行输入');
        staleSummary.title = '下方结果仍对应上次运行；请重新运行以更新结果。';
        stale.append(staleSummary, executedInput);
        const inputBody = element('div', 'oi33-pretest-feedback__input-body');
        input = element('textarea', 'oi33-pretest-feedback__input');
        input.setAttribute('aria-label', '自测输入');
        input.spellcheck = false;
        input.wrap = 'off';
        input.placeholder = '输入测试数据…';
        input.title = '可填写自定义输入，允许留空；点击右下角按钮或按 F9 运行';
        input.addEventListener('input', () => {
            if (!sampleId) customInput = true;
            store.dispatch({ type: 'SCRATCHPAD_PRETEST_DATA_CHANGE', payload: { type: 'input', value: input.value } });
            rememberInput();
            render();
        });
        runButton = element('button', 'oi33-pretest-feedback__run', '运行自测 (F9)');
        runButton.type = 'button';
        runButton.dataset.globalHotkey = 'f9';
        runButton.setAttribute('aria-label', '运行自测 (F9)');
        runButton.title = '运行当前输入（F9）；运行成功不代表整题通过';
        runButton.addEventListener('click', () => {
            if (canRun()) root.querySelector<HTMLButtonElement>('.scratchpad__toolbar__pretest')?.click();
        });
        inputBody.append(input, runButton);
        inputColumn.append(inputHeader, inputBody);
        const resultBody = element('div', 'oi33-pretest-feedback__result-body');
        expected = element('pre', 'oi33-pretest-feedback__expected');
        actual = element('pre', 'oi33-pretest-feedback__actual');
        actual.id = `${outputId}-actual`;
        expected.id = `${outputId}-expected`;
        actual.setAttribute('role', 'tabpanel');
        expected.setAttribute('role', 'tabpanel');
        actual.setAttribute('aria-labelledby', actualTab.id);
        expected.setAttribute('aria-labelledby', expectedTab.id);
        actual.setAttribute('aria-label', '本次实际输出或运行信息');
        resultBody.append(summary, comparison, stale, actual, expected);
        resultColumn.append(resultHeader, resultBody);
        grid.append(inputColumn, resultColumn);
        panel.append(grid);
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
        rememberInput,
        autofill() {
            if (store.getState().pretest?.input !== '' || sampleId || customInput || !samples.length) return;
            sampleId = samples[0].id;
            store.dispatch({ type: 'SCRATCHPAD_PRETEST_DATA_CHANGE', payload: { type: 'input', value: samples[0].input } });
            rememberInput();
        },
        filledSample() {
            sampleId = samples.find((sample) => sample.input === store.getState().pretest?.input)?.id || '';
            customInput = !sampleId;
            rememberInput();
            render();
        },
        start(inputValue: string) {
            const sample = currentSample();
            const editor = store.getState().editor;
            run = { input: inputValue, code: String(editor?.code || ''), lang: String(editor?.lang || ''),
                sample: sample?.input === inputValue ? sample : undefined };
            outputTab = 'actual';
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
