const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Interpret the editor's wall-clock fields in the account timezone, not the browser's. */
export function contestClock(timeZone: string) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const parts = (timestamp: number) => {
        const fields: Record<string, string> = {};
        formatter.formatToParts(timestamp).forEach((part) => { fields[part.type] = part.value; });
        return fields;
    };
    const format = (timestamp: number) => {
        const fields = parts(timestamp);
        return { date: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}` };
    };
    const parse = (date: string, time: string): number | null => {
        const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
        const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
        if (!day || !clock) return null;
        const [year, month, dom] = day.slice(1).map(Number);
        const [hour, minute] = clock.slice(1).map(Number);
        if (year < 1000 || month < 1 || month > 12 || dom < 1 || hour > 23 || minute > 59) return null;
        const wall = Date.UTC(year, month - 1, dom, hour, minute);
        const check = new Date(wall);
        if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== dom) return null;
        const expected = { date: `${year}-${String(month).padStart(2, '0')}-${String(dom).padStart(2, '0')}`, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
        const offsets = new Set<number>();
        // Sample both sides of a DST transition. Validate candidates by round-trip:
        // gaps are invalid and repeated wall times use the earlier occurrence (Hydro/moment default).
        for (let hours = -36; hours <= 36; hours += 12) {
            const sample = wall + hours * HOUR;
            const fields = parts(sample);
            offsets.add(Date.UTC(+fields.year, +fields.month - 1, +fields.day, +fields.hour, +fields.minute, +fields.second) - sample);
        }
        const candidates = [...offsets].map((offset) => wall - offset).filter((timestamp) => {
            const result = format(timestamp);
            return result.date === expected.date && result.time === expected.time;
        });
        return candidates.length ? Math.min(...candidates) : null;
    };
    return { parse, format };
}

export function contestDurationMinutes(value: string): number | null {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
    const minutes = Math.round(Number(value) * 60);
    return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : null;
}

export function contestDurationHours(minutes: number): string {
    // Do not round to two decimals: one minute is 0.01666... hours.
    return String(Number((minutes / 60).toFixed(12)));
}
