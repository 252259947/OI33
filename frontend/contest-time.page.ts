import { $, addPage, NamedPage } from '@hydrooj/ui-default';
import { contestClock, contestDurationHours, contestDurationMinutes } from './contest-time';

const attached = new WeakSet<HTMLFormElement>();

export function attachContestTime(form: HTMLFormElement, timeZone: string) {
    const field = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    const beginDate = field('beginAtDate');
    const beginTime = field('beginAtTime');
    const endDate = field('oi33EndAtDate');
    const endTime = field('oi33EndAtTime');
    const duration = field('duration');
    if (!beginDate || !beginTime || !endDate || !endTime || !duration || attached.has(form)) return;
    attached.add(form);
    const fields = [beginDate, beginTime, endDate, endTime, duration];
    let lastEdited: 'end' | 'duration' = 'end';
    let clock: ReturnType<typeof contestClock>;
    try { clock = contestClock(timeZone); } catch {
        endTime.setCustomValidity('账户时区无效，请检查偏好设置中的时区。');
        return;
    }
    const readBegin = () => {
        const begin = clock.parse(beginDate.value, beginTime.value);
        if (begin === null) beginDate.setCustomValidity('请输入有效的开始日期和时间；夏令时跳过的时间不可使用。');
        return begin;
    };
    const setEnd = (timestamp: number) => {
        const end = clock.format(timestamp);
        // Keep flatpickr's internal selected date in sync without firing another change.
        const picker = (endDate as HTMLInputElement & { _flatpickr?: { setDate: (value: string, trigger: boolean) => void } })._flatpickr;
        if (picker) picker.setDate(end.date, false);
        endDate.value = end.date;
        endTime.value = end.time;
    };
    const update = (source: 'end' | 'duration') => {
        fields.forEach((input) => input.setCustomValidity(''));
        const begin = readBegin();
        if (source === 'duration') {
            const minutes = contestDurationMinutes(duration.value);
            if (minutes === null) duration.setCustomValidity('持续时间必须为正数，且至少为 1 分钟。');
            if (begin === null || minutes === null) return false;
            const end = begin + minutes * 60000;
            if (!Number.isFinite(end) || end > Date.UTC(9999, 11, 30)) {
                duration.setCustomValidity('持续时间过长，请填写有效的结束时间。');
                return false;
            }
            setEnd(end);
            if (clock.parse(endDate.value, endTime.value) !== end) {
                duration.setCustomValidity('结束时间落在夏令时重复时段，请直接修改结束日期和时间。');
                return false;
            }
            return true;
        }
        const end = clock.parse(endDate.value, endTime.value);
        if (end === null) endDate.setCustomValidity('请输入有效的结束日期和时间；夏令时跳过的时间不可使用。');
        if (begin === null || end === null) return false;
        if (end <= begin) {
            endTime.setCustomValidity('结束时间必须晚于开始时间。');
            return false;
        }
        duration.value = contestDurationHours((end - begin) / 60000);
        return true;
    };
    const remembered = new Map<HTMLInputElement, string>();
    const remember = () => fields.forEach((input) => remembered.set(input, input.value));
    // Hydro's time picker emits jQuery change, while typing/flatpickr emit native events.
    // A delayed native change on blur must not undo an end-time edit made since the input.
    $([beginDate, beginTime, duration]).on('input.oi33ContestTime change.oi33ContestTime', (event) => {
        const input = event.currentTarget as HTMLInputElement;
        if (remembered.get(input) === input.value) return;
        update(lastEdited = 'duration');
        remember();
    });
    $([endDate, endTime]).on('input.oi33ContestTime change.oi33ContestTime', () => {
        update(lastEdited = 'end');
        remember();
    });
    const validate = (event: Event | JQuery.SubmitEvent) => {
        // Respect the last edited field, then submit a minute-exact duration alongside
        // canonical end fields. Invalid inputs must not be repaired from stale values.
        if (!update(lastEdited) || !update('end')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            form.reportValidity();
        }
        remember();
    };
    form.addEventListener('submit', validate, true);
    $(form).on('submit.oi33ContestTime', validate);
    form.addEventListener('reset', () => setTimeout(() => { update(lastEdited = 'end'); remember(); }, 0));
    update('end');
    remember();
}

export function installContestTime() {
    document.querySelectorAll<HTMLFormElement>('form').forEach((form) => attachContestTime(form, UserContext.timeZone || 'Asia/Shanghai'));
}

addPage(new NamedPage(['contest_create', 'contest_edit'], installContestTime));
