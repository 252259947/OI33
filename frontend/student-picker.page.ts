import { addPage, NamedPage } from '@hydrooj/ui-default';
import './student-picker.css';

interface Student { uid: number; name: string; username?: string }
const attached = new WeakSet<HTMLElement>();

export function parseStudentIds(text: string): number[] {
    const parts = text.trim().split(/[\s,，]+/).filter(Boolean);
    if (parts.length > 5000 || parts.some((part) => !/^\d+$/.test(part) || !Number.isSafeInteger(+part) || +part < 1)) {
        throw new Error('请输入有效的学生 UID，用逗号或空格分隔。');
    }
    return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

export function installStudentPickers() {
    document.querySelectorAll<HTMLElement>('[data-student-picker]').forEach((root) => {
        if (attached.has(root)) return;
        const form = root.closest('form');
        const input = root.querySelector<HTMLTextAreaElement>('[name="uids"]');
        const search = root.querySelector<HTMLInputElement>('[data-student-search]');
        if (!form || !input || !search) return;
        attached.add(root);
        const results = root.querySelector<HTMLElement>('[data-student-results]')!;
        const selectedBox = root.querySelector<HTMLElement>('[data-student-selected]')!;
        const status = root.querySelector<HTMLElement>('[data-student-status]')!;
        const mode = form.querySelector<HTMLSelectElement>('[name="mode"]');
        const names = new Map<number, Student>();
        root.querySelectorAll<HTMLElement>('[data-student-seed]').forEach((seed) => {
            const uid = Number(seed.dataset.uid);
            names.set(uid, { uid, name: seed.dataset.name || `UID ${uid}` });
        });
        let selected = new Set(parseStudentIds(input.value));
        const original = new Set(selected);
        let options: Student[] = [];
        let requestVersion = 0;
        let timer: ReturnType<typeof setTimeout>;
        const label = (uid: number) => `${names.get(uid)?.name || '学生'} · UID ${uid}`;
        const sync = () => { input.value = [...selected].sort((a, b) => a - b).join(', '); input.setCustomValidity(''); };
        function render() {
            selectedBox.replaceChildren();
            for (const uid of selected) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'education-student-picker__chip';
                button.textContent = `${label(uid)} ×`;
                button.title = `移除 ${label(uid)}`;
                button.addEventListener('click', () => { selected.delete(uid); sync(); render(); });
                selectedBox.append(button);
            }
            results.replaceChildren();
            for (const student of options) {
                const option = document.createElement('label');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = selected.has(student.uid);
                const text = document.createElement('span');
                text.textContent = `${student.name} · ${student.username || ''} · UID ${student.uid}`;
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selected.add(student.uid); else selected.delete(student.uid);
                    sync(); render();
                });
                option.append(checkbox, text);
                results.append(option);
            }
            selectedBox.setAttribute('aria-label', `已选 ${selected.size} 名学生`);
        }
        async function lookup() {
            const version = ++requestVersion;
            status.textContent = '正在查找…';
            options = []; render();
            try {
                const url = new URL(root.dataset.searchUrl!, location.href);
                url.searchParams.set('q', search.value.trim());
                if (root.dataset.tid) { url.searchParams.set('tid', root.dataset.tid); url.searchParams.set('mode', mode?.value || 'add'); }
                const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
                if (!response.ok) throw new Error('search failed');
                const data = await response.json();
                if (version !== requestVersion || !root.isConnected) return;
                if (!Array.isArray(data.students)) throw new Error('invalid response');
                options = data.students.filter((student: Student) => Number.isSafeInteger(student.uid) && student.uid > 0 && typeof student.name === 'string');
                options.forEach((student) => names.set(student.uid, student));
                status.textContent = options.length ? `找到 ${options.length} 名学生${data.more ? '，请补充姓名缩小范围' : '，勾选即可加入已选名单'}。` : '未找到符合条件的学生。';
                render();
            } catch {
                if (version === requestVersion && root.isConnected) status.textContent = '查找失败，请重试；也可展开高级选项输入 UID。';
            }
        }
        search.addEventListener('input', () => {
            ++requestVersion; options = []; render(); clearTimeout(timer);
            timer = setTimeout(lookup, 200);
        });
        search.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { event.preventDefault(); clearTimeout(timer); void lookup(); }
        });
        input.addEventListener('input', () => {
            try { selected = new Set(parseStudentIds(input.value)); input.setCustomValidity(''); render(); }
            catch (error) { input.setCustomValidity((error as Error).message); }
        });
        if (mode) {
            const updateMode = () => {
                ++requestVersion; clearTimeout(timer); options = []; selected.clear(); sync(); render();
                root.hidden = !['add', 'exempt'].includes(mode.value);
                search.value = '';
                status.textContent = mode.value === 'exempt' ? '按姓名查找当前应交名单内的学生。' : '按姓名查找作业开放班型内的学生。';
            };
            mode.addEventListener('change', updateMode);
            updateMode();
        }
        form.addEventListener('submit', (event) => {
            try { parseStudentIds(input.value); }
            catch (error) { event.preventDefault(); window.alert((error as Error).message); return; }
            if (mode) return; // Homework uses the existing server-side preview and confirmation.
            const added = [...selected].filter((uid) => !original.has(uid));
            const removed = [...original].filter((uid) => !selected.has(uid));
            if (!added.length && !removed.length) return;
            const describe = (uids: number[]) => uids.slice(0, 12).map(label).join('、') + (uids.length > 12 ? ` 等 ${uids.length} 人` : '');
            if (!window.confirm(`确认保存本班型成员？\n新增 ${added.length} 人：${describe(added) || '无'}\n移除 ${removed.length} 人：${describe(removed) || '无'}\n已发布作业的历史应交名单不会自动改变。`)) event.preventDefault();
        });
        root.querySelector<HTMLElement>('.education-student-picker__ui')!.hidden = false;
        render();
    });
}
addPage(new NamedPage(['oi33_education_classes', 'oi33_education_homework'], installStudentPickers));
