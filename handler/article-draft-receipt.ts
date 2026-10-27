import { createHash } from 'crypto';

export function articleDraftFingerprint(fields: any): string {
    return createHash('sha256').update(JSON.stringify({
        title: fields.title || '', content: fields.content || '',
        problemId: fields.problemId || '', visibility: fields.visibility || 'public',
    })).digest('hex');
}

export function saveArticleDraftReceipt(h: any, source: string, destination: string, fields: any) {
    const receipts = Array.isArray(h.session.oi33ArticleDraftReceipts) ? h.session.oi33ArticleDraftReceipts : [];
    h.session.oi33ArticleDraftReceipts = [...receipts, {
        uid: h.user._id, domainId: h.domain._id, source, destination,
        fingerprint: articleDraftFingerprint(fields), expires: Date.now() + 10 * 60 * 1000,
    }].slice(-10);
}

export function consumeArticleDraftReceipt(h: any, destination: string) {
    const receipts = Array.isArray(h.session?.oi33ArticleDraftReceipts) ? h.session.oi33ArticleDraftReceipts : [];
    const valid = receipts.filter((r: any) => r.uid === h.user._id && r.domainId === h.domain._id && r.expires > Date.now());
    const index = valid.findIndex((r: any) => r.destination === destination);
    const receipt = index < 0 ? null : valid.splice(index, 1)[0];
    if (h.session) h.session.oi33ArticleDraftReceipts = valid;
    return receipt ? { source: receipt.source, fingerprint: receipt.fingerprint } : null;
}
