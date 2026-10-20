import { db } from 'hydrooj';

export type LearningKind = 'homework' | 'training';
export interface RecentLearning {
    _id: string;
    domainId: string;
    uid: number;
    kind: LearningKind;
    tid: string;
    visitedAt: Date;
}
declare module 'hydrooj' { interface Collections { oi33_recent_learning: RecentLearning } }
export const recentLearningColl = db.collection('oi33_recent_learning');

function key(domainId: string, uid: number): string {
    if (typeof domainId !== 'string' || !domainId || !Number.isSafeInteger(uid) || uid <= 0) {
        throw new Error('Invalid recent learning identity');
    }
    return JSON.stringify([domainId, uid]);
}

export function validLearningTarget(value: any): value is { kind: LearningKind; tid: string } {
    return !!value && ['homework', 'training'].includes(value.kind)
        && typeof value.tid === 'string' && /^[a-f\d]{24}$/i.test(value.tid);
}

export async function getRecentLearning(domainId: string, uid: number): Promise<RecentLearning | null> {
    const entry = await recentLearningColl.findOne({ _id: key(domainId, uid), domainId, uid });
    return validLearningTarget(entry) ? entry : null;
}

export async function rememberLearning(domainId: string, uid: number, kind: LearningKind, tid: string) {
    if (!validLearningTarget({ kind, tid })) throw new Error('Invalid recent learning target');
    // One navigation preference per account/domain, not a browsing-history log.
    // Never store arbitrary URLs, titles, real names, problem code or answers.
    await recentLearningColl.updateOne({ _id: key(domainId, uid) }, {
        $set: { domainId, uid, kind, tid: tid.toLowerCase(), visitedAt: new Date() },
    }, { upsert: true });
}
