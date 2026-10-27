type RecoveryOptions = {
    getState: () => any;
    load: (rid: string) => Promise<any>;
    apply: (record: any) => void;
    isActive?: () => boolean;
    onStalled?: (stalled: boolean) => void;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => any;
    clearTimer?: (timer: any) => void;
};

export function isPendingRecord(record: any) {
    return !record || [0, 20, 21, 22].includes(record.status);
}

/** Bounded fallback for missed websocket updates; never creates submissions. */
export function createRecordResultRecovery(options: RecoveryOptions) {
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const pending = new Map<string, { started: number; attempts: number; next: number; stalled: boolean }>();
    let timer: any;
    let busy = false;
    let disposed = false;
    let shownStalled = false;

    const display = () => {
        const stalled = Array.from(pending.values()).some((entry) => entry.stalled);
        if (stalled !== shownStalled) options.onStalled?.(stalled);
        shownStalled = stalled;
    };
    const scan = () => {
        const state = options.getState();
        const ids = [state.pretest?.rid, ...(state.records?.rows || [])];
        for (const rid of ids.slice(0, 11)) {
            if (typeof rid !== 'string' || !/^[a-f\d]{24}$/i.test(rid)) continue;
            if (!isPendingRecord(state.records?.items?.[rid])) {
                pending.delete(rid);
                continue;
            }
            if (!pending.has(rid)) pending.set(rid, { started: now(), attempts: 0, next: now() + 1500, stalled: false });
        }
        for (const [rid, entry] of pending) {
            if (!isPendingRecord(state.records?.items?.[rid])) pending.delete(rid);
            else if (now() - entry.started >= 180000 || entry.attempts >= 24) entry.stalled = true;
        }
        display();
    };
    const schedule = () => {
        if (disposed || busy || timer != null || options.isActive?.() === false) return;
        const next = Array.from(pending.values()).filter((entry) => !entry.stalled);
        if (!next.length) return;
        timer = setTimer(() => { timer = undefined; void poll(); }, Math.max(0, Math.min(...next.map((entry) => entry.next)) - now()));
    };
    const poll = async () => {
        if (disposed || busy || options.isActive?.() === false) return;
        scan();
        const selected = Array.from(pending).find(([, entry]) => !entry.stalled && entry.next <= now());
        if (!selected) return schedule();
        const [rid, entry] = selected;
        busy = true;
        entry.attempts += 1;
        try {
            const record = await options.load(rid);
            if (!disposed && pending.get(rid) === entry && isPendingRecord(options.getState().records?.items?.[rid])) {
                if (String(record?._id) !== rid || !Number.isFinite(record.status)) throw new Error('Invalid record result');
                options.apply(record);
            }
        } catch {
            // The existing record handler enforces access. Do not fall back to
            // another endpoint or expose a failed response in the student UI.
        } finally {
            busy = false;
            entry.next = now() + Math.min(10000, 1500 * Math.max(1, entry.attempts));
            if (!disposed) { scan(); schedule(); }
        }
    };
    return {
        update() { if (!disposed) { scan(); schedule(); } },
        retry() {
            if (disposed) return;
            scan();
            for (const entry of pending.values()) {
                entry.started = now(); entry.attempts = 0; entry.next = now(); entry.stalled = false;
            }
            display();
            if (timer != null) { clearTimer(timer); timer = undefined; }
            schedule();
        },
        dispose() {
            disposed = true;
            if (timer != null) clearTimer(timer);
            pending.clear();
        },
    };
}
