import { addPage, NamedPage } from '@hydrooj/ui-default';

const attached = new WeakSet<HTMLFormElement>();
const resetAttached = new WeakSet<HTMLFormElement>();

export function installEnrollmentReviewFilters() {
    document.querySelectorAll<HTMLFormElement>('form[data-enrollment-status-filter]').forEach((form) => {
        const select = form.querySelector<HTMLSelectElement>('select[name="status"]');
        if (!select || attached.has(form)) return;
        attached.add(form);
        // This separate GET form intentionally omits the name and page filters.
        select.addEventListener('change', () => form.requestSubmit());
    });
    document.querySelectorAll<HTMLFormElement>('form[data-enrollment-password-reset]').forEach((form) => {
        if (resetAttached.has(form)) return;
        resetAttached.add(form);
        form.addEventListener('submit', (event) => {
            if (!window.confirm('确认将此账号的密码重置为 123456？学生下次登录后必须先修改密码。')) {
                event.preventDefault();
            }
        });
    });
}

addPage(new NamedPage('oi33_enrollment_review', installEnrollmentReviewFilters));
