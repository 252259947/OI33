import { addPage, NamedPage } from '@hydrooj/ui-default';
import $ from 'jquery';
import { articleDraftKey, parseArticleDraft } from './article-draft';
import './article-compose.css';

function editorFor(textarea: HTMLTextAreaElement): any {
    return $(textarea).data('vjEditorInstance');
}

export function restrictArticleUploads(form: HTMLFormElement) {
    if (form.dataset.articleUpload === '1') return () => {};
    const hint = '没有上传权限，可使用图片链接';
    const disable = () => {
        form.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => { input.disabled = true; });
        document.querySelectorAll<HTMLInputElement>('.md-editor-modal-body input[type="file"]').forEach((input) => { input.disabled = true; });
        // MdEditor's image menu has link / upload / crop-upload in this order.
        // Keep the URL item usable; the menu can be rendered in a portal.
        document.querySelectorAll<HTMLElement>('.md-editor-menu-item-image').forEach((item, index) => {
            if (index % 3 === 0) return;
            item.dataset.articleNoUpload = '1';
            item.setAttribute('aria-disabled', 'true');
            item.title = hint;
            item.classList.add('oi33-upload-disabled');
        });
    };
    const block = (event: Event) => {
        if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key)) return;
        if ((event.target as Element)?.closest?.('[data-article-no-upload], .md-editor-clip-upload')) {
            event.preventDefault(); event.stopImmediatePropagation();
        }
    };
    const blockFiles = (event: ClipboardEvent | DragEvent) => {
        const files = 'clipboardData' in event ? event.clipboardData?.files : event.dataTransfer?.files;
        if (!files?.length) return;
        event.preventDefault(); event.stopImmediatePropagation();
    };
    const observer = new MutationObserver(disable);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', block, true);
    document.addEventListener('keydown', block, true);
    form.addEventListener('paste', blockFiles, true);
    form.addEventListener('drop', blockFiles, true);
    disable();
    return () => {
        observer.disconnect();
        document.removeEventListener('click', block, true);
        document.removeEventListener('keydown', block, true);
        form.removeEventListener('paste', blockFiles, true);
        form.removeEventListener('drop', blockFiles, true);
    };
}

export function mountArticleCompose() {
    const form = document.querySelector<HTMLFormElement>('[data-article-compose]');
    if (!form || form.dataset.draftMounted) return;
    form.dataset.draftMounted = '1';
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="content"]')!;
    const title = form.querySelector<HTMLInputElement>('[name="title"]')!;
    const problem = form.querySelector<HTMLInputElement>('[name="problemId"]')!;
    const notice = form.querySelector<HTMLElement>('[data-article-draft-notice]')!;
    const status = form.querySelector<HTMLElement>('[data-article-draft-status]')!;
    const key = articleDraftKey(form.dataset.articleOwner!, form.dataset.articleId!);
    const read = () => ({
        title: title.value, content: editorFor(textarea)?.isValid ? editorFor(textarea).value() : textarea.value,
        problemId: problem.value,
        visibility: form.querySelector<HTMLInputElement>('[name="visibility"]:checked')?.value || 'public',
    });
    const base = JSON.stringify(read());
    let last = base;
    let choosing = false;
    let submitting = false;
    let storageFailed = false;
    let lastSeenRaw: string | null = null;
    try { lastSeenRaw = localStorage.getItem(key); } catch { /* handled by save */ }
    const hasConflict = () => localStorage.getItem(key) !== lastSeenRaw;
    const conflict = () => {
        storageFailed = true;
        status.textContent = '另一页面已更新草稿；为避免覆盖，当前修改尚未保存。请先复制正文，再在一个页面中继续编辑。';
    };
    const save = () => {
        if (choosing) return;
        const fields = read();
        const value = JSON.stringify(fields);
        if (value === last) return;
        try {
            if (hasConflict()) { conflict(); return; }
            if (value === base) localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify({ version: 1, fields, base, savedAt: Date.now() }));
            lastSeenRaw = localStorage.getItem(key);
            status.textContent = value === base ? '' : '草稿已保存在本机，仅当前账号可恢复';
            last = value;
            storageFailed = false;
        } catch {
            storageFailed = true;
            status.textContent = '本机草稿保存失败，请先复制正文，避免离开后丢失';
        }
    };
    try {
        const draft = parseArticleDraft(localStorage.getItem(key));
        if (draft && JSON.stringify(draft.fields) !== base) {
            choosing = true;
            notice.hidden = false;
            notice.querySelector('[data-draft-description]')!.textContent = draft.base === base
                ? '找到未提交的本机草稿，是否恢复？' : '找到本机草稿。线上文章已有变化，恢复会将草稿放回编辑区，请核对后再提交。';
            notice.querySelector('[data-draft-restore]')!.addEventListener('click', async () => {
                try { if (hasConflict()) { conflict(); return; } } catch { conflict(); return; }
                const beforeRestore = JSON.stringify(read());
                let editor = editorFor(textarea);
                for (let attempt = 0; editor && !editor.isValid && attempt < 50; attempt++) {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    editor = editorFor(textarea);
                }
                if (editor && !editor.isValid) { status.textContent = '编辑器仍在加载，请稍后再恢复草稿'; return; }
                if (JSON.stringify(read()) !== beforeRestore) {
                    choosing = false; notice.hidden = true; last = ''; save();
                    status.textContent = '恢复已取消，已保留刚输入的内容。';
                    return;
                }
                title.value = draft.fields.title;
                problem.value = draft.fields.problemId;
                textarea.value = draft.fields.content;
                if (editor) {
                    editor.valueCache = draft.fields.content;
                    editor.value(draft.fields.content);
                }
                form.querySelectorAll<HTMLInputElement>('[name="visibility"]').forEach((radio) => {
                    radio.checked = radio.value === draft.fields.visibility;
                });
                choosing = false; notice.hidden = true; last = ''; save();
            });
            notice.querySelector('[data-draft-discard]')!.addEventListener('click', () => {
                try {
                    if (hasConflict()) { conflict(); return; }
                    localStorage.removeItem(key); lastSeenRaw = null;
                } catch { /* leave protection still applies */ }
                choosing = false; notice.hidden = true; save();
            });
        }
    } catch { status.textContent = '浏览器未允许本机草稿存储，离开前请保存或复制正文'; }
    form.addEventListener('input', save);
    form.addEventListener('change', save);
    form.addEventListener('submit', () => {
        // Do not clear here: failed validation/network must retain the draft.
        if (choosing) choosing = false;
        save(); submitting = true;
        window.setTimeout(() => { submitting = false; }, 30000);
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
        save();
        if (!submitting && (JSON.stringify(read()) !== base || storageFailed)) {
            event.preventDefault(); event.returnValue = '';
        }
    };
    window.addEventListener('beforeunload', beforeUnload);
    const releaseUploads = restrictArticleUploads(form);
    // MdEditor's changes update the hidden textarea without dispatching input.
    const timer = window.setInterval(() => {
        if (!form.isConnected) {
            clearInterval(timer); releaseUploads(); window.removeEventListener('beforeunload', beforeUnload); return;
        }
        save();
    }, 750);
}

export async function clearPublishedArticleDraft() {
    const marker = document.querySelector<HTMLElement>('[data-article-saved-id]');
    const owner = marker?.dataset.articleDraftOwner;
    const source = marker?.dataset.articleSavedId;
    const fingerprint = marker?.dataset.articleSavedFingerprint;
    if (!owner || !source || !fingerprint || !window.crypto?.subtle) return;
    const key = articleDraftKey(owner, source);
    try {
        const raw = localStorage.getItem(key);
        const draft = parseArticleDraft(raw);
        if (!draft) return;
        const bytes = new TextEncoder().encode(JSON.stringify(draft.fields));
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
        // Another tab may have typed again since this submission; keep it.
        if (hash === fingerprint && localStorage.getItem(key) === raw) localStorage.removeItem(key);
    } catch { /* Preserve the draft if validation or storage is unavailable. */ }
}

addPage(new NamedPage(['oi33_article_create', 'oi33_article_edit'], mountArticleCompose));
addPage(new NamedPage(['discussion_detail', 'oi33_article_detail', 'oi33_article_mine'], clearPublishedArticleDraft));
