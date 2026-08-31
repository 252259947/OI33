import {
    addPage, NamedPage, Notification, request,
} from '@hydrooj/ui-default';
import './record-main.css';

type RecordPageWindow = typeof window & {
    oi33RecordPageCleanup?: () => void;
};

addPage(new NamedPage('record_main', () => {
    const pageWindow = window as RecordPageWindow;
    pageWindow.oi33RecordPageCleanup?.();

    const controller = new AbortController();
    const tableBody = document.querySelector('.record_main__table tbody');
    let observer: MutationObserver | undefined;
    let reloading = false;

    const reloadFilteredView = () => {
        if (reloading || !tableBody?.querySelector('tr[data-oi33-filtered-out]')) return;
        reloading = true;
        window.location.reload();
    };

    if (tableBody) {
        observer = new MutationObserver(reloadFilteredView);
        observer.observe(tableBody, {
            attributes: true,
            attributeFilter: ['data-oi33-filtered-out'],
            childList: true,
            subtree: true,
        });
        reloadFilteredView();
    }

    document.addEventListener('click', async (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLButtonElement>(
            'button[name="operation"][value="rejudge"], button[name="operation"][value="cancel"]',
        );
        if (!button) return;
        const form = button.closest<HTMLFormElement>('form[action]');
        if (!form) return;
        if (button.value === 'cancel'
            && !window.confirm('确认取消这条记录的成绩吗？此操作会把成绩置为 0。')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();

        const payload = new URLSearchParams();
        new FormData(form).forEach((value, key) => {
            if (typeof value === 'string') payload.append(key, value);
        });
        payload.set('operation', button.value);
        if (!payload.get('csrfToken') && UiContext.oi33RecordCsrfToken) {
            payload.set('csrfToken', UiContext.oi33RecordCsrfToken);
        }
        button.disabled = true;
        try {
            await request.post(form.action, payload.toString());
        } catch (error) {
            Notification.error((error as Error).message);
        } finally {
            button.disabled = false;
        }
    }, { capture: true, signal: controller.signal });

    pageWindow.oi33RecordPageCleanup = () => {
        controller.abort();
        observer?.disconnect();
        delete pageWindow.oi33RecordPageCleanup;
    };
}));
