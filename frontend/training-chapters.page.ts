import { addPage, NamedPage } from '@hydrooj/ui-default';
import { parseTrainingChapters } from './bulk-problem-paste';
import { changeTrainingChapter, ChapterAction, validateTrainingPlan } from './training-chapters';
import { trainingPlanSource } from './training-plan-source';
import './training-chapters.css';

const attached = new WeakSet<HTMLTextAreaElement>();

export function installTrainingChapters() {
    document.querySelectorAll<HTMLTextAreaElement>('textarea[name="dag"][data-json]').forEach((textarea) => {
        const form = textarea.form;
        const panel = form?.querySelector<HTMLElement>('[data-training-chapters]');
        if (!form || !panel || attached.has(textarea)) return;
        attached.add(textarea);
        const source = trainingPlanSource(textarea);
        const list = panel.querySelector<HTMLElement>('[data-chapter-list]')!;
        const status = panel.querySelector<HTMLElement>('[data-chapter-status]')!;
        const advanced = form.querySelector<HTMLDetailsElement>('[data-training-advanced]')!;
        let selectedId: number | undefined;
        let renaming = false;
        function message(text: string, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
        function selectChapter(id: number) {
            selectedId = id;
            const select = form!.querySelector<HTMLSelectElement>('[data-oi33-bulk-training] select');
            if (select) select.value = String(id);
        }
        function apply(action: ChapterAction) {
            try {
                const result = changeTrainingChapter(source.value(), action);
                renaming = action.type === 'rename';
                source.value(result.source);
                renaming = false;
                selectChapter(result.selectedId);
                message(action.type === 'add' ? '章节已添加，请在下方为新章节加入题目。保存训练后生效。' : '章节已更新，保存训练后生效。');
                return true;
            } catch (error) { renaming = false; message(error.message, true); return false; }
        }
        function render() {
            if (renaming) return;
            try {
                const chapters = parseTrainingChapters(source.value());
                list.replaceChildren();
                chapters.forEach((chapter, index) => {
                    const row = document.createElement('div'); row.className = 'oi33-training-chapter';
                    row.dataset.chapterId = String(chapter._id);
                    const title = document.createElement('input'); title.type = 'text'; title.className = 'textbox';
                    title.value = chapter.title; title.maxLength = 200; title.setAttribute('aria-label', `第 ${index + 1} 章名称`);
                    title.addEventListener('change', () => {
                        if (apply({ type: 'rename', id: chapter._id, title: title.value })) chapter.title = title.value.trim();
                        title.value = chapter.title;
                    });
                    const count = document.createElement('span'); count.className = 'oi33-training-chapter__count';
                    count.textContent = `${chapter.pids.length} 道题`;
                    const buttons = document.createElement('div'); buttons.className = 'oi33-training-chapter__actions';
                    const addButton = (text: string, titleText: string, callback: () => void, disabled = false) => {
                        const button = document.createElement('button'); button.type = 'button'; button.className = 'button';
                        button.textContent = text; button.title = titleText; button.setAttribute('aria-label', titleText); button.disabled = disabled;
                        button.addEventListener('click', callback); buttons.append(button);
                    };
                    addButton('加题', `向“${chapter.title}”添加题目`, () => {
                        selectChapter(chapter._id);
                        form!.querySelector<HTMLTextAreaElement>('[data-oi33-bulk-training] textarea')?.focus();
                    });
                    addButton('↑', `上移“${chapter.title}”`, () => apply({ type: 'move', id: chapter._id, direction: -1 }), index === 0);
                    addButton('↓', `下移“${chapter.title}”`, () => apply({ type: 'move', id: chapter._id, direction: 1 }), index === chapters.length - 1);
                    addButton('删除', `删除“${chapter.title}”`, () => {
                        if (window.confirm(`确认删除章节“${chapter.title}”及其 ${chapter.pids.length} 道题的训练关联？题库中的题目不会删除。保存训练后生效。`)) apply({ type: 'remove', id: chapter._id });
                    }, chapters.length === 1);
                    row.append(title, count, buttons); list.append(row);
                });
                if (selectedId && !chapters.some((chapter) => chapter._id === selectedId)) selectedId = chapters[0]._id;
            } catch (error) { message(error.message, true); advanced.open = true; }
        }
        panel.querySelector('[data-chapter-add]')!.addEventListener('click', () => apply({ type: 'add' }));
        textarea.addEventListener('oi33:training-plan-change', render);
        textarea.addEventListener('change', render);
        advanced.addEventListener('toggle', () => {
            if (!advanced.open) textarea.dispatchEvent(new CustomEvent('oi33:training-plan-change', { bubbles: true }));
        });
        form.addEventListener('submit', (event) => {
            if ((event as SubmitEvent).submitter?.getAttribute('value') === 'delete') return;
            try { validateTrainingPlan(source.value()); }
            catch (error) { event.preventDefault(); message(error.message, true); status.scrollIntoView({ block: 'center' }); }
        });
        // Closing advanced mode preserves its native editor and submitted field.
        advanced.open = false;
        render(); panel.hidden = false;
    });
}
addPage(new NamedPage(['training_create', 'training_edit'], () => setTimeout(installTrainingChapters, 0)));
