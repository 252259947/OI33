import { ActionDialog, addPage, NamedPage } from '@hydrooj/ui-default';

const attached = new WeakSet<HTMLFormElement>();

export function installClassActions() {
    document.querySelectorAll<HTMLFormElement>('[data-class-delete-form]').forEach((form) => {
        if (attached.has(form)) return;
        const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
        const confirmation = form.querySelector<HTMLInputElement>('[name="confirmDelete"]');
        const status = form.querySelector<HTMLElement>('[data-class-delete-status]');
        if (!button || !confirmation || button.disabled) return;
        attached.add(form);
        let pending = false;
        let confirmed = false;
        form.addEventListener('submit', async (event) => {
            if (confirmed) return;
            event.preventDefault();
            if (pending) return;
            pending = true;
            confirmation.value = 'false';
            if (status) status.textContent = '';
            try {
                const body = document.createElement('div');
                const title = document.createElement('h2');
                title.textContent = '删除班型？';
                const description = document.createElement('p');
                description.textContent = `将删除「${form.dataset.className || ''}」及其 ${form.dataset.classCount || '0'} 名成员的班型归属。`;
                const note = document.createElement('p');
                note.className = 'education-class-delete-note';
                note.textContent = '学生账号、其他班型和历史成绩会保留。删除后无法直接撤销。';
                body.append(title, description, note);
                const action = await new ActionDialog({
                    classes: 'education-class-delete-dialog', width: '480px', $body: body,
                    $action: '<button type="button" class="rounded button" data-action="cancel">取消</button><button type="button" class="primary rounded button" data-action="ok">确认删除</button>',
                }).open();
                if (action !== 'ok' || !form.isConnected) return;
                confirmation.value = 'true';
                confirmed = true;
                try { form.requestSubmit(button); }
                finally { confirmed = false; confirmation.value = 'false'; }
            } catch {
                confirmation.value = 'false';
                if (status) status.textContent = '暂时无法打开确认窗口，请重试。';
            } finally {
                pending = false;
            }
        });
    });
}

addPage(new NamedPage('oi33_education_classes', installClassActions));
