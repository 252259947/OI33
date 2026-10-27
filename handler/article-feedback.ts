import {
    Context, DiscussionModel, DocumentModel, Handler, NotFoundError, ObjectId, PERM, PRIV, Types, ValidationError, param,
} from 'hydrooj';
import { moderationColl } from '../model/moderate';
import { moderationTargetMatches, readModerationTarget, updateModerationTarget } from '../model/moderation-target';
import { kickModeration, shouldModerate, syncPrecheck } from './moderate';

function privateResponse(h: any) {
    h.response.addHeader('Cache-Control', 'private, no-store');
    h.response.addHeader('Referrer-Policy', 'no-referrer');
    h.response.addHeader('X-Robots-Tag', 'noindex, nofollow');
}

export async function ownFeedback(domainId: string, uid: number, id: ObjectId) {
    // Both identity boundaries are enforced by the query, before reading text.
    return moderationColl.findOne({ _id: id, uid, 'target.domainId': domainId, kind: { $ne: 'bio' } });
}

function label(entry: any) {
    if (entry.status === 'approved' || (entry.status === 'done' && entry.verdict === 'pass')) return '已通过';
    if (entry.status === 'rejected' || entry.verdict === 'block') return '未通过审核';
    return '审核中';
}

class ArticleFeedbackListHandler extends Handler {
    async get() {
        privateResponse(this);
        const entries = await moderationColl.find({
            uid: this.user._id, 'target.domainId': this.domain._id, kind: { $ne: 'bio' },
        }, { projection: { _id: 1, kind: 1, status: 1, verdict: 1, createdAt: 1 } })
            .sort({ createdAt: -1 }).limit(100).toArray();
        this.response.template = 'oi33_article_feedback.html';
        this.response.body = { feedbackEntries: entries.map((e) => ({
            id: e._id, status: label(e), createdAt: e.createdAt,
            kind: e.kind.startsWith('topic') ? '文章' : '回复',
        })), page_name: 'oi33_article_feedback' };
    }
}

class ArticleFeedbackHandler extends Handler {
    @param('id', Types.ObjectId)
    async get(domainId: string, id: ObjectId) {
        privateResponse(this);
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        const entry = await ownFeedback(domainId, this.user._id, id);
        if (!entry?.target) throw new NotFoundError('Discussion');
        const current = await readModerationTarget(entry.target);
        const editable = current?.owner === this.user._id && moderationTargetMatches(entry.target, current, entry)
            && (current.hidden || current.oi33ModerationPending);
        const topic = !entry.target.drid;
        this.response.template = 'oi33_article_feedback.html';
        this.response.body = {
            feedback: {
                id, status: label(entry), content: entry.content, createdAt: entry.createdAt,
                // Provider reasons and matched private words remain admin-only.
                category: ['政治', '色情', '暴力', '辱骂', '广告引流', '隐私', '刷屏', '注入尝试'].includes(entry.category)
                    ? entry.category : '',
                editable: editable && !topic,
                revision: (entry as any).targetRevision || entry.contentHash,
                editUrl: editable && topic ? this.url(current.oi33Kind === 'article' ? 'oi33_article_edit' : 'discussion_edit', {
                    did: entry.target.did,
                }) : null,
            },
            page_name: 'oi33_article_feedback',
        };
    }

    @param('id', Types.ObjectId)
    @param('content', Types.Content)
    @param('revision', Types.String)
    async post(domainId: string, id: ObjectId, content: string, revision: string) {
        privateResponse(this);
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        this.checkPerm(PERM.PERM_REPLY_DISCUSSION);
        this.checkPerm(PERM.PERM_EDIT_DISCUSSION_REPLY_SELF);
        const entry = await ownFeedback(domainId, this.user._id, id);
        if (!entry?.target?.drid) throw new NotFoundError('Discussion');
        const current = await readModerationTarget(entry.target);
        if (!current || current.owner !== this.user._id) throw new NotFoundError('Discussion');
        if (revision !== ((entry as any).targetRevision || entry.contentHash)
            || !moderationTargetMatches(entry.target, current, entry)
            || !(current.hidden || current.oi33ModerationPending)) {
            throw new ValidationError('这条内容已更新或审核通过，请刷新发布反馈后再操作。');
        }
        const parentReply = await DiscussionModel.getReply(domainId, entry.target.drid);
        const topic = parentReply && await readModerationTarget({ domainId, did: parentReply.parentId });
        if (!topic || topic.lock) throw new ValidationError('原讨论已删除或锁定，不能重新提交。');
        if ((topic.hidden || topic.oi33ModerationPending
            || (topic.oi33Kind === 'article' && topic.oi33Visibility !== 'public'))
            && topic.owner !== this.user._id) {
            throw new NotFoundError('Discussion');
        }
        if (entry.target.drrid && (parentReply.hidden || (parentReply as any).oi33ModerationPending)) {
            throw new NotFoundError('Discussion');
        }
        const vnode = await DiscussionModel.getVnode(domainId, topic.parentType, String(topic.parentId), this.user._id);
        if (!DiscussionModel.checkVNodeVisibility(topic.parentType, vnode, this.user)) throw new NotFoundError('Discussion');
        if (topic.oi33Kind === 'article' && topic.oi33ProblemId) {
            const problem = await DiscussionModel.getVnode(domainId, DocumentModel.TYPE_PROBLEM, String(topic.oi33ProblemId), this.user._id);
            if (!DiscussionModel.checkVNodeVisibility(DocumentModel.TYPE_PROBLEM, problem, this.user)) throw new NotFoundError('Discussion');
        }
        const kind = entry.target.drrid ? 'tailreply_edit' : 'reply_edit';
        await syncPrecheck(this, kind, content);
        await this.limitRate('add_discussion', 3600, 60);
        const needsModeration = await shouldModerate(this.user._id);
        const applied = await updateModerationTarget(entry.target, current, {
            content, hidden: needsModeration, oi33ModerationPending: needsModeration, oi33ModerationRejected: false,
            oi33ModerationRevision: new ObjectId().toHexString(),
            oi33ModerationHistoryPrivate: true,
            editor: this.user._id, ip: this.request.ip, edited: true,
        });
        if (!applied) throw new ValidationError('内容已更新，请刷新后重试。');
        if (needsModeration) kickModeration(kind, this.user._id, content, entry.target);
        this.response.redirect = needsModeration ? this.url('oi33_article_feedback')
            : this.url('discussion_detail', { did: topic.docId });
    }
}

export function applyArticleFeedback(ctx: Context) {
    ctx.Route('oi33_article_feedback', '/article/feedback', ArticleFeedbackListHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_article_feedback_detail', '/article/feedback/:id', ArticleFeedbackHandler, PRIV.PRIV_USER_PROFILE);
}
