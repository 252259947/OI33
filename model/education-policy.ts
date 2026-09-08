export interface RosterEntry {
    uid: number;
    assignedAt: Date;
    exemptAt?: Date;
    exemptReason?: string;
}

export function uniqueStudentIds(values: number[]): number[] {
    return [...new Set(values.filter((uid) => Number.isSafeInteger(uid) && uid > 0))].sort((a, b) => a - b);
}

export function classUnion(groups: { uids: number[] }[]): number[] {
    return uniqueStudentIds(groups.flatMap((group) => group.uids));
}

export function classifyTeachingStudents(
    domainId: string, requestedUids: number[], existingUids: number[],
    memberships: { uid: number; domainId: string; join?: boolean }[],
    enrollments: { _id: number; domainId: string; accountType: string }[],
) {
    const requested = uniqueStudentIds(requestedUids);
    const existing = new Set(existingUids);
    const members = new Set(memberships.filter((member) => member.domainId === domainId && member.join === true).map((member) => member.uid));
    // Enrollment may precede Hydro's domain membership write during provisioning.
    for (const enrollment of enrollments) if (enrollment.domainId === domainId) members.add(enrollment._id);
    const temporary = new Set(enrollments.filter((enrollment) => enrollment.accountType === 'temporary').map((enrollment) => enrollment._id));
    const inDomain = requested.filter((uid) => existing.has(uid) && members.has(uid));
    return {
        inDomain,
        eligible: inDomain.filter((uid) => !temporary.has(uid)),
        missing: requested.filter((uid) => !existing.has(uid)),
        outside: requested.filter((uid) => existing.has(uid) && !members.has(uid)),
        temporary: requested.filter((uid) => temporary.has(uid)),
    };
}

// Synchronization only adds missing students. It never silently exempts students
// who changed class, or reactivates a teacher's explicit exemption.
export function extendRoster(entries: RosterEntry[], uids: number[], now = new Date()): RosterEntry[] {
    const known = new Set(entries.map((entry) => entry.uid));
    return [...entries.map((entry) => ({ ...entry })), ...uniqueStudentIds(uids)
        .filter((uid) => !known.has(uid)).map((uid) => ({ uid, assignedAt: now }))]
        .sort((a, b) => a.uid - b.uid);
}

export function exemptRoster(entries: RosterEntry[], uids: number[], reason: string, now = new Date()): RosterEntry[] {
    if (!reason.trim()) throw new Error('免除作业必须填写原因。');
    const selected = new Set(uids);
    return entries.map((entry) => selected.has(entry.uid)
        ? { ...entry, exemptAt: now, exemptReason: reason.trim() } : { ...entry });
}

export function homeworkProgress(
    pids: number[], status: { journal?: any[]; detail?: Record<string, any>; attend?: number } | undefined,
    deadline: Date, now = new Date(), acceptedStatus = 1,
) {
    const journal = status?.journal || [];
    const detail: Record<number, any> = {};
    for (const entry of journal) if (pids.includes(entry.pid)) detail[entry.pid] = entry;
    for (const pid of pids) if (status?.detail?.[pid]) detail[pid] = status.detail[pid];
    const cells = pids.map((pid) => {
        const entry = detail[pid];
        const attempted = !!entry;
        const complete = entry?.status === acceptedStatus;
        return { pid, attempted, complete, score: Number(entry?.score || 0), rid: entry?.rid?.toString?.() || '' };
    });
    const completed = cells.filter((cell) => cell.complete).length;
    const attempted = cells.filter((cell) => cell.attempted).length;
    const complete = pids.length > 0 && completed === pids.length;
    const overdue = !complete && now.getTime() > deadline.getTime();
    return { cells, completed, attempted, complete, overdue, claimed: !!status?.attend,
        state: complete ? '已完成' : attempted ? '进行中' : '未开始' };
}
