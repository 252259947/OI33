import { DocumentModel } from 'hydrooj';
import type { Oi33ModerationTarget } from './types';
import { hashOf, normalizeText } from './moderate';

export function moderationTargetText(target: Oi33ModerationTarget, doc: any): string {
    return target.drid ? String(doc.content || '')
        : [doc.title, doc.content].filter((s) => typeof s === 'string' && s.trim()).join('\n');
}

export async function readModerationTarget(target: Oi33ModerationTarget): Promise<any> {
    const doc = await DocumentModel.coll.findOne({
        domainId: target.domainId,
        docType: target.drid ? DocumentModel.TYPE_DISCUSSION_REPLY : DocumentModel.TYPE_DISCUSSION,
        docId: target.drid || target.did,
    });
    return target.drrid ? (doc as any)?.reply?.find((r: any) => String(r._id) === String(target.drrid)) : doc;
}

export function moderationTargetMatches(target: Oi33ModerationTarget, doc: any, entry: any): boolean {
    return !!doc && hashOf(normalizeText(moderationTargetText(target, doc))) === entry.contentHash
        && (typeof entry.content !== 'string' || moderationTargetText(target, doc) === entry.content)
        && (entry.targetRevision ? doc.oi33ModerationRevision === entry.targetRevision : !doc.oi33ModerationRevision);
}

// No upsert: a verdict for deleted or edited content must never recreate it,
// expose a newer revision, or overwrite somebody else's concurrent edit.
export async function updateModerationTarget(target: Oi33ModerationTarget, snapshot: any, fields: any, pendingReviewOnly = false): Promise<boolean> {
    if (!snapshot) return false;
    const match: any = {
        content: snapshot.content,
        oi33ModerationRevision: snapshot.oi33ModerationRevision || { $exists: false },
    };
    if (!target.drid) match.title = snapshot.title;
    if (pendingReviewOnly) {
        match.oi33ModerationPending = true;
        match.oi33ModerationRejected = { $ne: true };
    }
    const filter: any = {
        domainId: target.domainId,
        docType: target.drid ? DocumentModel.TYPE_DISCUSSION_REPLY : DocumentModel.TYPE_DISCUSSION,
        docId: target.drid || target.did,
    };
    let $set = fields;
    if (target.drrid) {
        filter.reply = { $elemMatch: { _id: target.drrid, ...match } };
        $set = Object.fromEntries(Object.entries(fields).map(([key, value]) => [`reply.$.${key}`, value]));
    } else Object.assign(filter, match);
    const result = await DocumentModel.coll.updateOne(filter, { $set });
    return result.matchedCount === 1;
}
