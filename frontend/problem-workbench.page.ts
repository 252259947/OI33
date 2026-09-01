import {
    $, addPage, ctx, i18n, loadMonaco, NamedPage, Notification, request,
} from '@hydrooj/ui-default';
import './problem-workbench.css';

const problemPages = ['problem_detail', 'contest_detail_problem', 'homework_detail_problem'];
const STATUS_CODES: Record<number, string> = {
    0: 'pending',
    1: 'pass',
    2: 'fail',
    3: 'fail',
    4: 'fail',
    5: 'fail',
    6: 'fail',
    7: 'fail',
    8: 'fail',
    9: 'ignored',
    10: 'fail',
    11: 'fail',
    20: 'progress',
    21: 'progress',
    22: 'progress',
    30: 'ignored',
    31: 'ignored',
    32: 'pass',
    33: 'fail',
};
const STATUS_TEXTS: Record<number, string> = {
    0: 'Waiting',
    1: 'Accepted',
    2: 'Wrong Answer',
    3: 'Time Exceeded',
    4: 'Memory Exceeded',
    5: 'Output Exceeded',
    6: 'Runtime Error',
    7: 'Compile Error',
    8: 'System Error',
    9: 'Cancelled',
    10: 'Unknown Error',
    11: 'Hacked',
    20: 'Running',
    21: 'Compiling',
    22: 'Fetched',
    30: 'Ignored',
    31: 'Format Error',
    32: 'Hack Successful',
    33: 'Hack Unsuccessful',
};

const EDITOR_THEME_STORAGE_KEY = 'oi33/editor-theme';
const BUILTIN_EDITOR_THEMES: Array<[string, string]> = [
    ['vs', 'VS'],
    ['vs-dark', 'VS Dark'],
    ['hc-black', 'High Contrast (Dark)'],
];
const CUSTOM_EDITOR_THEMES: Record<string, string> = {
    active4d: 'Active4D',
    'all-hallows-eve': 'All Hallows Eve',
    amy: 'Amy',
    'birds-of-paradise': 'Birds of Paradise',
    blackboard: 'Blackboard',
    'brilliance-black': 'Brilliance Black',
    'brilliance-dull': 'Brilliance Dull',
    'chrome-devtools': 'Chrome DevTools',
    'clouds-midnight': 'Clouds Midnight',
    clouds: 'Clouds',
    cobalt: 'Cobalt',
    cobalt2: 'Cobalt2',
    dawn: 'Dawn',
    dracula: 'Dracula',
    dreamweaver: 'Dreamweaver',
    eiffel: 'Eiffel',
    'espresso-libre': 'Espresso Libre',
    'github-dark': 'GitHub Dark',
    'github-light': 'GitHub Light',
    github: 'GitHub',
    idle: 'IDLE',
    katzenmilch: 'Katzenmilch',
    'kuroir-theme': 'Kuroir Theme',
    lazy: 'LAZY',
    'magicwb--amiga-': 'MagicWB (Amiga)',
    'merbivore-soft': 'Merbivore Soft',
    merbivore: 'Merbivore',
    'monokai-bright': 'Monokai Bright',
    monokai: 'Monokai',
    'night-owl': 'Night Owl',
    nord: 'Nord',
    'oceanic-next': 'Oceanic Next',
    'pastels-on-dark': 'Pastels on Dark',
    'slush-and-poppies': 'Slush and Poppies',
    'solarized-dark': 'Solarized-dark',
    'solarized-light': 'Solarized-light',
    spacecadet: 'SpaceCadet',
    sunburst: 'Sunburst',
    'textmate--mac-classic-': 'Textmate (Mac Classic)',
    'tomorrow-night-blue': 'Tomorrow-Night-Blue',
    'tomorrow-night-bright': 'Tomorrow-Night-Bright',
    'tomorrow-night-eighties': 'Tomorrow-Night-Eighties',
    'tomorrow-night': 'Tomorrow-Night',
    tomorrow: 'Tomorrow',
    twilight: 'Twilight',
    'upstream-sunburst': 'Upstream Sunburst',
    'vibrant-ink': 'Vibrant Ink',
    'xcode-default': 'Xcode_default',
    zenburnesque: 'Zenburnesque',
    iplastic: 'iPlastic',
    idlefingers: 'idleFingers',
    krtheme: 'krTheme',
    monoindustrial: 'monoindustrial',
};
const loadedEditorThemes = new Set<string>();

type ScratchpadStore = {
    dispatch: (action: any) => any;
    getState: () => any;
    subscribe: (listener: () => void) => () => void;
};

type ScratchpadRoot = HTMLElement & {
    oi33Unsubscribe?: () => void;
};

type RecordsPanel = HTMLElement & {
    oi33RecordItems?: any;
    oi33RecordLoading?: boolean;
    oi33RecordRows?: any;
};

const RECORDS_ZERO_CONTEST = '000000000000000000000000';

function getScratchpadStore(): ScratchpadStore | null {
    return (ctx as any).scratchpad?.store || null;
}

function removeLegacyScratchpadRail(root: HTMLElement, store: ScratchpadStore) {
    const scratchpad = (ctx as any).scratchpad;
    const problemPage = scratchpad?.pages?.problem;
    if (problemPage && scratchpad.pages.settings) {
        if (store.getState().ui?.activePage !== 'problem') {
            store.dispatch({
                type: 'SCRATCHPAD_SWITCH_TO_PAGE',
                payload: 'problem',
            });
        }
        delete scratchpad.pages.settings;
        scratchpad.addPage('problem', problemPage.icon, problemPage.component);
    }
    const updateFallback = () => {
        const firstPane = root.querySelector<HTMLElement>(
            ':scope > .split-view-horizontal > .split-view-container > .split-view-view:first-child',
        );
        root.classList.toggle('oi33-scratchpad-layout-fallback', (firstPane?.getBoundingClientRect().width || 0) > 2);
    };
    window.requestAnimationFrame(() => {
        updateFallback();
        window.requestAnimationFrame(updateFallback);
    });
    window.setTimeout(updateFallback, 160);
}

function createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = '',
    text = '',
) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function recordDetailUrl(recordId: string) {
    const template = decodeURIComponent((window as any).UiContext?.getRecordDetailUrl || '');
    return template
        .replace('{rid}', encodeURIComponent(recordId))
        .replace('%7Brid%7D', encodeURIComponent(recordId));
}

function recordTime(recordId: string) {
    const timestamp = Number.parseInt(recordId.slice(0, 8), 16) * 1000;
    if (!Number.isFinite(timestamp)) return '';
    return new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(new Date(timestamp));
}

function renderScratchpadRecords(panel: RecordsPanel, store: ScratchpadStore) {
    const list = panel.querySelector<HTMLElement>('[data-oi33-record-list]');
    const count = panel.parentElement?.querySelector<HTMLElement>('[data-oi33-record-count]');
    if (!list) return;

    const state = store.getState();
    const rows = state.records?.rows || [];
    const items = state.records?.items || {};
    const loading = !!state.ui?.records?.isLoading;
    if (panel.oi33RecordRows === rows
        && panel.oi33RecordItems === items
        && panel.oi33RecordLoading === loading) return;
    panel.oi33RecordRows = rows;
    panel.oi33RecordItems = items;
    panel.oi33RecordLoading = loading;
    const records = (state.records?.rows || [])
        .map((recordId: string) => state.records?.items?.[recordId])
        .filter((record: any) => record && String(record.contest || '') !== RECORDS_ZERO_CONTEST);

    if (count) count.textContent = records.length ? String(records.length) : '';
    list.replaceChildren();
    if (loading && !records.length) {
        const loading = createElement('div', 'oi33-scratchpad-records__empty');
        loading.append(
            createElement('span', 'oi33-scratchpad-records__spinner'),
            document.createTextNode('正在加载提交记录…'),
        );
        list.append(loading);
        return;
    }
    if (!records.length) {
        const empty = createElement('div', 'oi33-scratchpad-records__empty');
        empty.append(
            createElement('span', 'icon icon-flag oi33-scratchpad-records__empty-icon'),
            createElement('strong', '', '还没有提交记录'),
            createElement('span', '', '完成代码后，递交结果会显示在这里。'),
        );
        list.append(empty);
        return;
    }

    records.forEach((record: any) => {
        const statusCode = STATUS_CODES[record.status] || 'pending';
        const statusText = STATUS_TEXTS[record.status] ? i18n(STATUS_TEXTS[record.status]) : '等待评测';
        const link = createElement('a', 'oi33-scratchpad-record');
        link.href = recordDetailUrl(String(record._id));
        link.target = '_blank';
        link.rel = 'noopener';

        const status = createElement('span', `oi33-scratchpad-record__status record-status--text ${statusCode}`);
        status.append(
            createElement('span', `icon record-status--icon ${statusCode}`),
            document.createTextNode(String(statusText)),
        );

        const meta = createElement('span', 'oi33-scratchpad-record__meta');
        const metaParts = [record.lang || record.language || ''];
        if (record.testCases?.length && Number.isFinite(record.time)) metaParts.push(`${(record.time / 1000).toFixed(2)}s`);
        if (record.testCases?.length && Number.isFinite(record.memory)) metaParts.push(`${Math.max(1, Math.ceil(record.memory / 1000))} MB`);
        meta.textContent = metaParts.filter(Boolean).join(' · ');

        const score = createElement('strong', 'oi33-scratchpad-record__score', `${record.score ?? '-'} 分`);
        const time = createElement('time', 'oi33-scratchpad-record__time', recordTime(String(record._id)));
        link.append(status, meta, score, time, createElement('span', 'icon icon-chevron-right oi33-scratchpad-record__arrow'));
        list.append(link);
    });
}

function loadScratchpadRecords(store: ScratchpadStore) {
    if (!(window as any).UiContext?.canViewRecord) return;
    store.dispatch({
        type: 'SCRATCHPAD_RECORDS_LOAD_SUBMISSIONS',
        payload: request.get((window as any).UiContext.getSubmissionsUrl),
    });
}

function mountProblemTabs(root: ScratchpadRoot, store: ScratchpadStore) {
    const problemContent = root.querySelector<HTMLElement>('.problem-content');
    if (!problemContent || problemContent.dataset.oi33ScratchpadTabs === '1') return;
    problemContent.dataset.oi33ScratchpadTabs = '1';

    const statement = createElement('div', 'oi33-scratchpad-statement');
    while (problemContent.firstChild) statement.append(problemContent.firstChild);

    const tabs = createElement('div', 'oi33-scratchpad-problem-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', '题目内容');

    const descriptionButton = createElement('button', 'oi33-scratchpad-problem-tab is-active');
    descriptionButton.type = 'button';
    descriptionButton.setAttribute('role', 'tab');
    descriptionButton.setAttribute('aria-selected', 'true');
    descriptionButton.append(
        createElement('span', 'icon icon-book'),
        document.createTextNode('题目描述'),
    );
    tabs.append(descriptionButton);

    const recordsPanel = createElement('div', 'oi33-scratchpad-records') as RecordsPanel;
    recordsPanel.hidden = true;
    const recordsHeader = createElement('div', 'oi33-scratchpad-records__header');
    recordsHeader.append(
        createElement('div', 'oi33-scratchpad-records__heading', '我的提交'),
        createElement('div', 'oi33-scratchpad-records__hint', '点击记录可在新页面查看完整评测详情'),
    );
    const refresh = createElement('button', 'oi33-scratchpad-records__refresh');
    refresh.type = 'button';
    refresh.append(createElement('span', 'icon icon-refresh'), document.createTextNode('刷新'));
    refresh.addEventListener('click', () => loadScratchpadRecords(store));
    recordsHeader.append(refresh);
    recordsPanel.append(recordsHeader, createElement('div', 'oi33-scratchpad-records__list'));
    recordsPanel.lastElementChild?.setAttribute('data-oi33-record-list', '');

    let recordsButton: HTMLButtonElement | null = null;
    const setActiveTab = (tab: 'description' | 'records') => {
        const showRecords = tab === 'records' && !!recordsButton;
        descriptionButton.classList.toggle('is-active', !showRecords);
        descriptionButton.setAttribute('aria-selected', String(!showRecords));
        recordsButton?.classList.toggle('is-active', showRecords);
        recordsButton?.setAttribute('aria-selected', String(showRecords));
        statement.hidden = showRecords;
        recordsPanel.hidden = !showRecords;
        if (showRecords) {
            renderScratchpadRecords(recordsPanel, store);
            loadScratchpadRecords(store);
        }
    };

    descriptionButton.addEventListener('click', () => setActiveTab('description'));
    if ((window as any).UiContext?.canViewRecord) {
        recordsButton = createElement('button', 'oi33-scratchpad-problem-tab') as HTMLButtonElement;
        recordsButton.type = 'button';
        recordsButton.setAttribute('role', 'tab');
        recordsButton.setAttribute('aria-selected', 'false');
        recordsButton.append(
            createElement('span', 'icon icon-flag'),
            document.createTextNode('提交记录'),
            createElement('span', 'oi33-scratchpad-problem-tab__count'),
        );
        recordsButton.lastElementChild?.setAttribute('data-oi33-record-count', '');
        recordsButton.addEventListener('click', () => setActiveTab('records'));
        tabs.append(recordsButton);
    }

    problemContent.prepend(tabs);
    problemContent.append(statement, recordsPanel);
    renderScratchpadRecords(recordsPanel, store);

    root.oi33Unsubscribe?.();
    root.oi33Unsubscribe = store.subscribe(() => {
        const state = store.getState();
        renderScratchpadRecords(recordsPanel, store);
        if (state.ui?.records?.visible) {
            store.dispatch({
                type: 'SCRATCHPAD_UI_SET_VISIBILITY',
                payload: { uiElement: 'records', visibility: false },
            });
            setActiveTab('records');
        }
    });
}

async function updateEditorSetting(store: ScratchpadStore, setting: string, value: unknown) {
    const { customOptions } = await loadMonaco([]);
    const liveTheme = customOptions.theme ?? null;
    const stateTheme = store.getState().ui?.settings?.config?.theme ?? null;
    if (setting !== 'theme' && liveTheme !== stateTheme) {
        store.dispatch({
            type: 'SCRATCHPAD_SETTING_UPDATE',
            payload: { setting: 'theme', value: liveTheme },
        });
    }
    if (value === null || value === undefined) delete customOptions[setting];
    else customOptions[setting] = value;
    localStorage.setItem('editor.config', JSON.stringify(customOptions));
    store.dispatch({
        type: 'SCRATCHPAD_SETTING_UPDATE',
        payload: { setting, value },
    });
}

function isKnownEditorTheme(theme: string) {
    return BUILTIN_EDITOR_THEMES.some(([id]) => id === theme) || !!CUSTOM_EDITOR_THEMES[theme];
}

async function getScratchpadMonaco() {
    const scratchpad = (ctx as any).scratchpad;
    if (!scratchpad?.monaco && scratchpad?.load) await scratchpad.load;
    return scratchpad?.monaco || (window as any).monaco;
}

async function compactScratchpadEditorGutter() {
    const scratchpad = (ctx as any).scratchpad;
    if (!scratchpad?.editor && scratchpad?.load) await scratchpad.load;
    scratchpad?.editor?.updateOptions({
        glyphMargin: false,
        lineNumbersMinChars: 3,
    });
}

async function applyEditorTheme(store: ScratchpadStore, theme: string) {
    const monaco = await getScratchpadMonaco();
    if (!monaco?.editor || !isKnownEditorTheme(theme)) throw new Error('编辑器主题不可用');

    const customLabel = CUSTOM_EDITOR_THEMES[theme];
    if (customLabel && !loadedEditorThemes.has(theme)) {
        const cdnPrefix = (window as any).UiContext?.cdn_prefix || '/';
        const response = await fetch(`${cdnPrefix}monaco/themes/${encodeURIComponent(customLabel)}.json`);
        if (!response.ok) throw new Error(`主题资源加载失败 (${response.status})`);
        monaco.editor.defineTheme(theme, await response.json());
        loadedEditorThemes.add(theme);
    }

    localStorage.setItem(EDITOR_THEME_STORAGE_KEY, theme);
    await updateEditorSetting(store, 'theme', customLabel ? theme : null);
    monaco.editor.setTheme(theme);
}

function mountEditorSettings(toolbar: HTMLElement, store: ScratchpadStore) {
    const languageItem = toolbar.querySelector<HTMLDivElement>('.scratchpad__toolbar__item:has(> select)');
    languageItem?.classList.add('oi33-scratchpad-toolbar__language');
    toolbar.querySelectorAll<HTMLButtonElement>('.scratchpad__toolbar__button').forEach((button) => {
        const label = (button.textContent || '').trim();
        const hotkey = button.dataset.globalHotkey;
        if (hotkey === 'alt+p' || hotkey === 'alt+r'
            || label === '自测' || label === '评测记录' || label === 'Pretest' || label === 'Records') {
            button.classList.add('oi33-scratchpad-toolbar__legacy-toggle');
        }
    });
    toolbar.querySelector('.scratchpad__toolbar__split')?.classList.add('oi33-scratchpad-toolbar__legacy-toggle');
    if (toolbar.querySelector('[data-oi33-editor-settings]')) return;

    const wrap = createElement('div', 'oi33-scratchpad-settings');
    wrap.setAttribute('data-oi33-editor-settings', '');
    const button = createElement('button', 'oi33-scratchpad-settings__button');
    button.type = 'button';
    button.setAttribute('aria-label', '编辑器设置');
    button.setAttribute('aria-expanded', 'false');
    button.title = '编辑器设置';
    button.append(createElement('span', 'icon icon-settings'));

    const popover = createElement('div', 'oi33-scratchpad-settings__popover');
    popover.hidden = true;
    const title = createElement('div', 'oi33-scratchpad-settings__title', '编辑器设置');
    const fontLabel = createElement('label', 'oi33-scratchpad-settings__field');
    fontLabel.append(createElement('span', '', '字号大小'));
    const fontSelect = createElement('select', 'select') as HTMLSelectElement;
    [12, 13, 14, 15, 16, 18, 20, 22].forEach((fontSize) => {
        const option = createElement('option') as HTMLOptionElement;
        option.value = String(fontSize);
        option.textContent = `${fontSize}px`;
        fontSelect.append(option);
    });
    fontSelect.value = String(store.getState().ui?.settings?.config?.fontSize || 14);
    fontSelect.addEventListener('change', () => void updateEditorSetting(store, 'fontSize', Number(fontSelect.value)));
    fontLabel.append(fontSelect);

    const tabLabel = createElement('label', 'oi33-scratchpad-settings__field');
    tabLabel.append(createElement('span', '', 'Tab 宽度'));
    const tabSelect = createElement('select', 'select') as HTMLSelectElement;
    [2, 4, 8].forEach((tabSize) => {
        const option = createElement('option') as HTMLOptionElement;
        option.value = String(tabSize);
        option.textContent = `${tabSize} 空格`;
        tabSelect.append(option);
    });
    tabSelect.value = String(store.getState().ui?.settings?.config?.tabSize || 4);
    tabSelect.addEventListener('change', () => void updateEditorSetting(store, 'tabSize', Number(tabSelect.value)));
    tabLabel.append(tabSelect);

    const themeLabel = createElement('label', 'oi33-scratchpad-settings__field oi33-scratchpad-settings__field--theme');
    themeLabel.append(createElement('span', '', '编辑器主题'));
    const themeSelect = createElement('select', 'select') as HTMLSelectElement;
    const builtinGroup = createElement('optgroup') as HTMLOptGroupElement;
    builtinGroup.label = '基础主题';
    BUILTIN_EDITOR_THEMES.forEach(([id, label]) => {
        const option = createElement('option') as HTMLOptionElement;
        option.value = id;
        option.textContent = label;
        builtinGroup.append(option);
    });
    const customGroup = createElement('optgroup') as HTMLOptGroupElement;
    customGroup.label = '更多主题';
    Object.entries(CUSTOM_EDITOR_THEMES).forEach(([id, label]) => {
        const option = createElement('option') as HTMLOptionElement;
        option.value = id;
        option.textContent = label;
        customGroup.append(option);
    });
    themeSelect.append(builtinGroup, customGroup);
    const storedTheme = localStorage.getItem(EDITOR_THEME_STORAGE_KEY);
    const configTheme = store.getState().ui?.settings?.config?.theme;
    const darkInterface = document.documentElement.classList.contains('theme--dark')
        || document.body.classList.contains('theme--dark')
        || document.documentElement.dataset.mantineColorScheme === 'dark';
    const defaultTheme = darkInterface ? 'vs-dark' : 'vs';
    const initialTheme = isKnownEditorTheme(storedTheme || '')
        ? storedTheme!
        : (isKnownEditorTheme(configTheme) ? configTheme : defaultTheme);
    themeSelect.value = initialTheme;
    themeSelect.addEventListener('change', async () => {
        const previousTheme = localStorage.getItem(EDITOR_THEME_STORAGE_KEY) || initialTheme;
        themeSelect.disabled = true;
        try {
            await applyEditorTheme(store, themeSelect.value);
        } catch (error) {
            themeSelect.value = previousTheme;
            Notification.error(error instanceof Error ? error.message : '编辑器主题加载失败');
        } finally {
            themeSelect.disabled = false;
        }
    });
    themeLabel.append(themeSelect);
    popover.append(title, fontLabel, tabLabel, themeLabel);
    wrap.append(button, popover);
    toolbar.append(wrap);

    themeSelect.disabled = true;
    applyEditorTheme(store, initialTheme)
        .catch((error) => {
            Notification.error(error instanceof Error ? error.message : '编辑器主题加载失败');
        })
        .finally(() => { themeSelect.disabled = false; });

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        popover.hidden = !popover.hidden;
        button.setAttribute('aria-expanded', String(!popover.hidden));
    });
    popover.addEventListener('click', (event) => event.stopPropagation());
    document.addEventListener('click', () => {
        if (popover.hidden) return;
        popover.hidden = true;
        button.setAttribute('aria-expanded', 'false');
    });
}

function installScratchpadObserver(root: HTMLElement, store: ScratchpadStore) {
    if (root.dataset.oi33Observer === '1') return;
    root.dataset.oi33Observer = '1';
    const observer = new MutationObserver(() => {
        const toolbar = root.querySelector<HTMLElement>('.scratchpad__toolbar');
        if (toolbar) mountEditorSettings(toolbar, store);
    });
    observer.observe(root, { childList: true, subtree: true });
}

function firstSampleInput() {
    const samples = Array.from(document.querySelectorAll<HTMLElement>('.problem-content pre code[class*="language-input"]'));
    samples.sort((a, b) => {
        const aId = Number(a.className.match(/language-input(\d+)/)?.[1] || Number.MAX_SAFE_INTEGER);
        const bId = Number(b.className.match(/language-input(\d+)/)?.[1] || Number.MAX_SAFE_INTEGER);
        return aId - bId;
    });
    return samples[0]?.textContent || '';
}

function installPretestFlow(root: HTMLElement, store: ScratchpadStore) {
    if (root.dataset.oi33PretestFlow === '1') return;
    root.dataset.oi33PretestFlow = '1';

    root.addEventListener('click', (event) => {
        if ((event.target as Element | null)?.closest('.scratchpad-fill-button')) {
            window.setTimeout(() => store.dispatch({
                type: 'SCRATCHPAD_UI_SET_VISIBILITY',
                payload: { uiElement: 'pretest', visibility: true },
            }));
        }
        const submitButton = (event.target as Element | null)?.closest<HTMLButtonElement>('.scratchpad__toolbar__submit');
        if (submitButton && !submitButton.classList.contains('disabled')) {
            store.dispatch({
                type: 'SCRATCHPAD_UI_SET_VISIBILITY',
                payload: { uiElement: 'pretest', visibility: false },
            });
            return;
        }
        const button = (event.target as Element | null)?.closest<HTMLButtonElement>('.scratchpad__toolbar__pretest');
        if (!button || button.classList.contains('disabled')) return;
        const state = store.getState();
        if (state.ui?.isPosting || state.ui?.pretestWaitSec > 0 || state.pretest?.isRunning) return;

        store.dispatch({
            type: 'SCRATCHPAD_UI_SET_VISIBILITY',
            payload: { uiElement: 'pretest', visibility: true },
        });
        if (state.pretest?.input !== '') return;

        const sample = firstSampleInput();
        if (!sample) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        store.dispatch({
            type: 'SCRATCHPAD_PRETEST_DATA_CHANGE',
            payload: { type: 'input', value: sample },
        });
        const latest = store.getState();
        const pretestRequest = request.post((window as any).UiContext.postSubmitUrl, {
            lang: latest.editor.lang,
            code: latest.editor.code,
            input: [latest.pretest.input],
            pretest: true,
        });
        store.dispatch({
            type: 'SCRATCHPAD_POST_PRETEST',
            payload: pretestRequest,
        });
    }, true);
}

function mountScratchpadWorkbench() {
    const root = document.querySelector<ScratchpadRoot>('#scratchpad');
    const toolbar = root?.querySelector<HTMLElement>('.scratchpad__toolbar');
    const store = getScratchpadStore();
    if (!root || !toolbar || !store) return false;

    root.classList.add('oi33-scratchpad-ready');
    removeLegacyScratchpadRail(root, store);
    ['pretest', 'records'].forEach((uiElement) => store.dispatch({
        type: 'SCRATCHPAD_UI_SET_VISIBILITY',
        payload: { uiElement, visibility: false },
    }));
    mountProblemTabs(root, store);
    mountEditorSettings(toolbar, store);
    void compactScratchpadEditorGutter();
    installPretestFlow(root, store);
    installScratchpadObserver(root, store);
    return true;
}

function scheduleScratchpadWorkbench() {
    let attempts = 0;
    const mount = () => {
        if (mountScratchpadWorkbench() || attempts >= 40) return;
        attempts += 1;
        window.setTimeout(mount, 50);
    };
    window.setTimeout(mount);
}

function markClosestItem(element: Element | null, className: string) {
    element?.closest<HTMLElement>('.menu__item')?.classList.add(className);
}

function enhanceActionMenu(root: HTMLElement) {
    root.querySelectorAll<HTMLOListElement>('.section--problem-sidebar ol.menu').forEach((menu) => {
        menu.classList.add('oi33-problem-actions');

        const scratchpad = menu.querySelector<HTMLAnchorElement>('[name="problem-sidebar__open-scratchpad"]');
        const links = Array.from(menu.querySelectorAll<HTMLAnchorElement>('.menu__item > a.menu__link'));
        const directAction = links.find((link) => link.closest('.scratchpad--hide') && link.querySelector('.icon-send'))
            || links.find((link) => link.querySelector('.icon-send'));

        if (scratchpad) {
            scratchpad.classList.add('oi33-problem-action__link');
            markClosestItem(scratchpad, 'oi33-problem-action--primary');
        }
        if (directAction) {
            directAction.classList.add('oi33-problem-action__link');
            markClosestItem(directAction, scratchpad
                ? 'oi33-problem-action--secondary'
                : 'oi33-problem-action--primary');
        }

        menu.querySelectorAll<HTMLElement>([
            '[name="problem-sidebar__rejudge"]',
            '[name="problem-sidebar__download"]',
            '.icon-edit',
            '.icon-settings',
            '.oi33-ai-summary-item',
        ].join(',')).forEach((element) => markClosestItem(element, 'oi33-problem-action--utility'));
    });
}

function mountProblemWorkbench() {
    document.querySelectorAll<HTMLElement>('[data-oi33-problem-workbench]').forEach((root) => {
        root.dataset.oi33WorkbenchMounted = '1';
        enhanceActionMenu(root);
    });
}

let contentHookInstalled = false;
addPage(new NamedPage(problemPages, () => {
    mountProblemWorkbench();
    scheduleScratchpadWorkbench();
    if (contentHookInstalled) return;
    contentHookInstalled = true;
    $(document).on('click.oi33ProblemWorkbench', '[name="problem-sidebar__open-scratchpad"]', () => {
        scheduleScratchpadWorkbench();
    });
    $(document).on('vjContentNew.oi33ProblemWorkbench', () => {
        mountProblemWorkbench();
        scheduleScratchpadWorkbench();
    });
}));
