import { addPage, NamedPage } from '@hydrooj/ui-default';

const attached = new WeakSet<HTMLFormElement>();

export function installEnrollmentReviewFilters() {
    document.querySelectorAll<HTMLFormElement>('form[data-enrollment-status-filter]').forEach((form) => {
        const select = form.querySelector<HTMLSelectElement>('select[name="status"]');
        if (!select || attached.has(form)) return;
        attached.add(form);
        // This separate GET form intentionally omits the name and page filters.
        select.addEventListener('change', () => form.requestSubmit());
    });
}

addPage(new NamedPage('oi33_enrollment_review', installEnrollmentReviewFilters));
