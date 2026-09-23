import { $, addPage, NamedPage, ProblemSelectAutoComplete, ReactDOM, request } from '@hydrooj/ui-default';
import {
    BULK_PROBLEM_HELP, mergeProblemIds, parseProblemTokens, parseTrainingChapters,
    resolveProblemTokens, updateTrainingChapter,
} from './bulk-problem-paste';
import './bulk-problem-paste.css';

const pages = ['homework_create', 'homework_edit', 'contest_create', 'contest_edit', 'training_create', 'training_edit'];
const pendingForms = new Set<HTMLFormElement>();
const attached = new WeakSet<Element>();

const lookup = async (token: string) => {
    const result = await request.get(`/d/${UiContext.domainId}/p`, { q: token, quick: true, sort: 'default' });
    if (!Array.isArray(result?.pdocs)) throw new Error('Invalid problem response');
    return result.pdocs;
};

function statusNode(parent: HTMLElement): HTMLElement {
    const status = document.createElement('p');
    status.className = 'oi33-bulk-problem-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    parent.after(status);
    return status;
}

function message(status: HTMLElement, text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
}

export function attachProblemPaste(input: HTMLInputElement) {
    if (attached.has(input) || !input.form) return;
    const instance: any = ProblemSelectAutoComplete.getOrConstruct($(input), { multi: true, clearDefaultValue: false });
    if (!instance?.options.multi || !instance.container) return;
    attached.add(input);
    const container: HTMLElement = instance.container;
    container.dataset.oi33BulkProblemPaste = 'true';
    const status = statusNode(container);
    message(status, BULK_PROBLEM_HELP);
    container.addEventListener('paste', async (event: ClipboardEvent) => {
        if (!(event.target instanceof HTMLInputElement)) return;
        const text = event.clipboardData?.getData('text/plain') || '';
        // Leave native single-problem typing/paste and all other selectors alone.
        if (text.trim().split(/[\s,，;；]+/u).filter(Boolean).length < 2) return;
        event.preventDefault();
        event.stopImmediatePropagation(); // Run before React's native numeric-only paste handler.
        const form = input.form;
        if (!form || pendingForms.has(form)) {
            message(status, '正在查询题目，请等待完成后再粘贴。', true);
            return;
        }
        pendingForms.add(form);
        container.setAttribute('aria-busy', 'true');
        try {
            if (!instance.ref) throw new Error('题目选择器尚未就绪，请稍后重试。');
            const query = instance.ref.getQuery();
            const tokens = parseProblemTokens(text);
            message(status, `正在匹配 ${tokens.length} 个题号，请稍候……`);
            const resolved = await resolveProblemTokens(tokens, lookup);
            if (!input.isConnected || !container.isConnected || instance.detached) return;
            if (instance.ref.getQuery() !== query) throw new Error('查询期间输入已改变，本次未添加题目，请重新粘贴。');
            // getSelectedItemKeys also includes the unselected search query; getValue does not.
            const previous = String(instance.ref.getValue() || '').split(',').filter(Boolean).map(Number);
            const ids = mergeProblemIds(previous, resolved.map((problem) => problem.docId));
            // Native React state, its wrapper's onChange and the submitted field
            // must commit together before the form becomes submittable again.
            ReactDOM.flushSync(() => {
                instance.ref.setQuery('');
                instance.ref.closeList();
                instance.ref.setSelectedKeys(ids.map(String));
            });
            if (input.value !== ids.join(',') || instance.ref.getValue() !== ids.join(',')) {
                throw new Error('题目选择器未同步完成，请检查已选题目后再保存。');
            }
            message(status, `已添加 ${ids.length - new Set(previous).size} 道题，重复题目已自动跳过。${BULK_PROBLEM_HELP}`);
        } catch (error) {
            message(status, error instanceof Error ? error.message : '题目查询失败，本次未添加题目。', true);
        } finally {
            pendingForms.delete(form);
            container.removeAttribute('aria-busy');
        }
    }, true);
}

export function attachTrainingPaste(textarea: HTMLTextAreaElement) {
    if (attached.has(textarea) || !textarea.form) return;
    attached.add(textarea);
    const panel = document.createElement('div');
    panel.className = 'oi33-bulk-training';
    panel.dataset.oi33BulkTraining = 'true';
    panel.innerHTML = '<strong>按章节批量加题</strong><p class="oi33-bulk-training__help"></p>'
        + '<div class="oi33-bulk-training__row"><select aria-label="目标章节"></select>'
        + '<button type="button" class="rounded button" data-refresh>刷新章节</button></div>'
        + '<textarea aria-label="批量题号" rows="3" placeholder="LuoguB2002, LuoguB2025, LuoguB2007"></textarea>'
        + '<button type="button" class="primary rounded button" data-import>加入所选章节</button>';
    panel.querySelector('.oi33-bulk-training__help')!.textContent = BULK_PROBLEM_HELP;
    // Avoid placing interactive controls inside the native Plan label.
    const label = textarea.closest('label');
    (label || textarea).before(panel);
    const status = statusNode(panel);
    const select = panel.querySelector('select')!;
    const paste = panel.querySelector('textarea')!;
    const button = panel.querySelector<HTMLButtonElement>('[data-import]')!;
    const refresh = panel.querySelector<HTMLButtonElement>('[data-refresh]')!;
    const getEditor = () => {
        const editor = $(textarea).data('vjEditorInstance');
        if (!editor?.isValid || typeof editor.value !== 'function') throw new Error('训练编辑器尚未就绪，请稍后点击“刷新章节”。');
        return editor;
    };
    const refreshChapters = () => {
        try {
            const selected = select.value;
            const chapters = parseTrainingChapters(getEditor().value());
            select.replaceChildren(...chapters.map((chapter) => {
                const option = document.createElement('option');
                option.value = String(chapter._id);
                option.textContent = `${chapter._id} · ${chapter.title}`;
                return option;
            }));
            if (chapters.some((chapter) => String(chapter._id) === selected)) select.value = selected;
            message(status, '仅向所选章节追加题目，其他章节与先修关系保持不变。');
        } catch (error) {
            select.replaceChildren();
            message(status, error.message, true);
        }
    };
    refresh.addEventListener('click', refreshChapters);
    select.addEventListener('focus', refreshChapters);
    button.addEventListener('click', async () => {
        const form = textarea.form;
        if (!form || pendingForms.has(form)) return;
        pendingForms.add(form);
        button.disabled = refresh.disabled = select.disabled = paste.disabled = true;
        panel.setAttribute('aria-busy', 'true');
        try {
            const editor = getEditor();
            const source = editor.value();
            const chapterId = Number(select.value);
            const chapter = parseTrainingChapters(source).find((item) => item._id === chapterId);
            if (!chapter || !select.value) throw new Error('请先刷新并选择目标章节。');
            const tokens = parseProblemTokens(paste.value);
            const aliases = chapter.pids.filter((pid) => !/^\d+$/.test(String(pid))).map(String);
            if (aliases.length > 200) throw new Error('本章节已有超过 200 个非数字题号，请先整理已有题目后再批量添加。');
            const allTokens = [...new Set([...aliases, ...tokens])];
            message(status, `正在匹配题号并校验所选章节已有题目，请稍候……`);
            // Resolve legacy PID entries too, so PID/docId aliases deduplicate correctly.
            const resolved = [];
            for (let i = 0; i < allTokens.length; i += 200) {
                resolved.push(...await resolveProblemTokens(allTokens.slice(i, i + 200), lookup));
            }
            if (!textarea.isConnected || !panel.isConnected) return;
            const matched = new Map(allTokens.map((token, index) => [token, resolved[index].docId]));
            const existing = chapter.pids.map((pid) => /^\d+$/.test(String(pid)) ? Number(pid) : matched.get(String(pid))!);
            const ids = mergeProblemIds(existing, tokens.map((token) => matched.get(token)!));
            const value = updateTrainingChapter(source, editor.value(), chapterId, ids);
            editor.value(value); // Native API updates Monaco and the actual submitted textarea.
            paste.value = '';
            message(status, `题目已加入“${chapter.title}”，本章节共 ${ids.length} 道题；保存训练后生效。`);
        } catch (error) {
            message(status, error instanceof Error ? error.message : '未能添加题目，请重试。', true);
        } finally {
            pendingForms.delete(form);
            button.disabled = refresh.disabled = select.disabled = paste.disabled = false;
            panel.removeAttribute('aria-busy');
        }
    });
    // The JSON editor is lazy-loaded. Do not show an error during normal startup.
    let attempts = 0;
    const initializeChapters = () => {
        if (!panel.isConnected) return;
        if ($(textarea).data('vjEditorInstance')?.isValid) refreshChapters();
        else if (attempts++ < 40) setTimeout(initializeChapters, 500);
    };
    message(status, '训练编辑器正在加载，稍候也可点击“刷新章节”。');
    initializeChapters();
}

export function installBulkProblemPaste() {
    const attach = () => {
        document.querySelectorAll<HTMLInputElement>('form input[name="pids"]').forEach(attachProblemPaste);
        document.querySelectorAll<HTMLTextAreaElement>('form textarea[name="dag"][data-json]').forEach(attachTrainingPaste);
    };
    attach();
    $(document).on('vjContentNew.oi33BulkProblemPaste', () => setTimeout(attach, 0));
    document.addEventListener('submit', (event) => {
        if (pendingForms.has(event.target as HTMLFormElement)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}

addPage(new NamedPage(pages, () => setTimeout(installBulkProblemPaste, 0)));
