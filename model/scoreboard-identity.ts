import { DomainModel } from 'hydrooj';
import { enrollmentColl } from './enrollment';
import { userColl } from './user';

function checkedName(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const name = value.trim();
    return name && name.length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : undefined;
}

// Request-scoped, projected reads only. Never copy private enrollment fields
// into global User objects/caches or change the account's public username.
export async function getScoreboardRealNames(domainId: string, uids: number[]): Promise<Record<number, string>> {
    const ids = [...new Set(uids.filter((uid) => Number.isSafeInteger(uid) && uid > 0))];
    const names: Record<number, string> = {};
    if (!domainId || !ids.length) return names;
    // Read enrollment presence across domains so a foreign/pending enrollment
    // cannot accidentally fall back to an old verified name.
    const enrollments = await enrollmentColl.find({ _id: { $in: ids } })
        .project({ _id: 1, domainId: 1, status: 1, realName: 1 }).toArray();
    const enrolled = new Set(enrollments.map((doc) => doc._id));
    for (const doc of enrollments) {
        const name = checkedName(doc.realName);
        if (doc.domainId === domainId && doc.status === 'approved' && name) names[doc._id] = name;
    }
    const legacyIds = ids.filter((uid) => !enrolled.has(uid));
    if (!legacyIds.length) return names;
    const members = await DomainModel.collUser.find({ domainId, uid: { $in: legacyIds }, join: true })
        .project({ uid: 1 }).toArray();
    const memberIds = members.map((doc) => doc.uid);
    if (!memberIds.length) return names;
    const legacy = await userColl.find({ _id: { $in: memberIds } })
        .project({ _id: 1, realname_flag: 1, realname_name: 1 }).toArray();
    for (const doc of legacy) {
        const name = checkedName(doc.realname_name);
        if (Number(doc.realname_flag) >= 1 && name) names[doc._id] = name;
    }
    return names;
}
