import { addPage, NamedPage } from '@hydrooj/ui-default';

const attached = new WeakSet<HTMLFormElement>();
const actionAttached = new WeakSet<HTMLFormElement>();

function positionKey() {
    const uid = document.querySelector<HTMLElement>('[data-enrollment-review]')?.dataset.adminUid;
    return uid ? `oi33:enrollment-review-position:${uid}` : '';
}

function rememberPosition(form: HTMLFormElement) {
    const key = positionKey();
    if (!key) return;
    try {
        const value = (name: string) => form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value || '';
        sessionStorage.setItem(key, JSON.stringify({ path: location.pathname, y: window.scrollY, at: Date.now(),
            status: value('returnStatus'), name: value('returnName'), page: value('returnPage') || '1' }));
    } catch { /* Position restoration is optional when browser storage is blocked. */ }
}

function restorePosition() {
    const key = positionKey();
    if (!key || !document.querySelector('[data-enrollment-action-success]')) return;
    try {
        const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
        sessionStorage.removeItem(key);
        const query = new URLSearchParams(location.search);
        if (!saved || saved.path !== location.pathname || Date.now() - saved.at > 300000
            || saved.status !== (query.get('status') || '') || saved.name !== (query.get('name') || '')
            || saved.page !== (query.get('page') || '1') || !Number.isFinite(saved.y)) return;
        requestAnimationFrame(() => window.scrollTo({ top: Math.max(0, saved.y), behavior: 'instant' as ScrollBehavior }));
    } catch { /* Malformed or unavailable storage must not break account actions. */ }
}

export function installEnrollmentReviewFilters() {
    document.querySelectorAll<HTMLFormElement>('form[data-enrollment-status-filter]').forEach((form) => {
        const select = form.querySelector<HTMLSelectElement>('select[name="status"]');
        if (!select || attached.has(form)) return;
        attached.add(form);
        // This separate GET form intentionally omits the name and page filters.
        select.addEventListener('change', () => form.requestSubmit());
    });
    document.querySelectorAll<HTMLFormElement>('form[data-enrollment-action], form[data-enrollment-password-reset]').forEach((form) => {
        if (actionAttached.has(form)) return;
        actionAttached.add(form);
        form.addEventListener('submit', (event) => {
            const action = (event as SubmitEvent).submitter?.getAttribute('value')
                || form.querySelector<HTMLInputElement>('[name="action"]')?.value
                || (form.hasAttribute('data-enrollment-password-reset') ? 'reset_password' : '');
            const student = `${form.dataset.studentName || '此学生'}（UID ${form.dataset.studentUid || '未知'}）`;
            const confirmation = action === 'disable' ? `确认停用 ${student} 的账号？停用后将无法继续使用 OJ，可在此页面恢复启用。`
                : action === 'reset_password' ? `确认将 ${student} 的密码重置为 123456？学生下次登录后必须先修改密码。` : '';
            if (confirmation && !window.confirm(confirmation)) {
                event.preventDefault();
                return;
            }
            if (!event.defaultPrevented) rememberPosition(form);
        });
    });
    restorePosition();
}

addPage(new NamedPage('oi33_enrollment_review', installEnrollmentReviewFilters));
