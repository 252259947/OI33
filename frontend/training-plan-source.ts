import { $ } from '@hydrooj/ui-default';

// Both visual chapter controls and bulk import use the native JSON editor's
// value; the textarea is the fallback until its lazy initialization completes.
export function trainingPlanSource(textarea: HTMLTextAreaElement) {
    return {
        value(next?: string): string {
            const editor = $(textarea).data('vjEditorInstance');
            if (typeof next === 'string') {
                if (editor?.isValid) editor.value(next);
                textarea.value = next;
                textarea.dispatchEvent(new CustomEvent('oi33:training-plan-change', { bubbles: true }));
                return next;
            }
            return editor?.isValid ? editor.value() : textarea.value;
        },
    };
}
