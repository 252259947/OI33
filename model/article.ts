import { randomBytes } from 'crypto';
import {
    DiscussionModel, DocumentModel, ObjectId, ProblemModel,
} from 'hydrooj';
import bus from 'hydrooj/src/service/bus';
import type { Filter } from 'mongodb';
import type { Oi33ArticleVisibility } from './types';

export const ARTICLE_NODE_ID = 'oi33-articles-internal';
export const ARTICLE_SHARE_TOKEN_BYTES = 24;

export const ARTICLE_LIST_PROJECTION = [
    ...DiscussionModel.PROJECTION_LIST,
    'content', 'edited', 'react', 'lock',
    'oi33Kind', 'oi33Visibility', 'oi33ProblemId',
    'oi33ModerationPending',
    'oi33CreatedAt', 'oi33PublishedAt', 'oi33ContentUpdatedAt',
] as any;

const ARTICLE_ACCESS_PROJECTION = [
    ...DiscussionModel.PROJECTION_PUBLIC,
    'oi33Kind', 'oi33Visibility', 'oi33ProblemId',
    'oi33ModerationPending',
    'oi33CreatedAt', 'oi33PublishedAt', 'oi33ContentUpdatedAt',
    // Deliberately kept out of ARTICLE_LIST_PROJECTION and every public list.
    'oi33ShareToken',
] as any;

export interface ArticleBinding {
    parentType: number;
    parentId: ObjectId | number | string;
    problemId: number | null;
    problem?: any;
}

export interface AddArticleArgs {
    domainId: string;
    owner: number;
    title: string;
    content: string;
    ip: string | null;
    visibility: Oi33ArticleVisibility;
    binding: ArticleBinding;
    highlight?: boolean;
    pin?: boolean;
}

export function normalizeArticleVisibility(value: unknown): Oi33ArticleVisibility {
    if (value === 'private' || value === 'unlisted') return value;
    return 'public';
}

export function newArticleShareToken() {
    return randomBytes(ARTICLE_SHARE_TOKEN_BYTES).toString('base64url');
}

export function articlePublicFilter(): Record<string, any> {
    return {
        hidden: false,
        oi33ModerationPending: { $ne: true },
        $or: [
            { oi33Kind: { $ne: 'article' } },
            {
                oi33Kind: 'article',
                oi33Visibility: 'public',
            },
        ],
    };
}

export function articleOnlyPublicFilter(): Record<string, any> {
    return {
        hidden: false,
        oi33Kind: 'article',
        oi33Visibility: 'public',
        oi33ModerationPending: { $ne: true },
    };
}

export function articleList(domainId: string, query: Filter<any> = {}) {
    return DocumentModel.getMulti(
        domainId,
        DocumentModel.TYPE_DISCUSSION,
        { $and: [query, articlePublicFilter()] } as any,
        ARTICLE_LIST_PROJECTION,
    ).sort({ pin: -1, updateAt: -1, docId: -1 });
}

export function articleMine(domainId: string, owner: number) {
    return DocumentModel.getMulti(
        domainId,
        DocumentModel.TYPE_DISCUSSION,
        { oi33Kind: 'article', owner } as any,
        ARTICLE_LIST_PROJECTION,
    ).sort({ updateAt: -1, docId: -1 });
}

export async function articleGet(domainId: string, did: ObjectId) {
    return await DocumentModel.get(
        domainId, DocumentModel.TYPE_DISCUSSION, did, ARTICLE_ACCESS_PROJECTION,
    ) as any;
}

export async function ensureArticleNode(domainId: string) {
    const current = await DiscussionModel.getNode(domainId, ARTICLE_NODE_ID);
    if (!current) {
        try {
            await DiscussionModel.addNode(domainId, ARTICLE_NODE_ID, '文章', { oi33Internal: true });
        } catch (e) {
            // Another worker may have created the same per-domain node first.
            if (!await DiscussionModel.getNode(domainId, ARTICLE_NODE_ID)) throw e;
        }
        return;
    }
    if (!current.oi33Internal) {
        await DocumentModel.set(
            domainId, DocumentModel.TYPE_DISCUSSION_NODE, ARTICLE_NODE_ID,
            { oi33Internal: true } as any,
        );
    }
}

export async function resolveArticleBinding(
    domainId: string, rawProblemId: unknown, user: any,
): Promise<ArticleBinding | null> {
    const problemId = String(rawProblemId ?? '').trim();
    await ensureArticleNode(domainId);
    if (!problemId) {
        return {
            parentType: DocumentModel.TYPE_DISCUSSION_NODE,
            parentId: ARTICLE_NODE_ID,
            problemId: null,
        };
    }
    const pdoc = await ProblemModel.get(domainId, problemId, ProblemModel.PROJECTION_LIST);
    if (!pdoc || !DiscussionModel.checkVNodeVisibility(DocumentModel.TYPE_PROBLEM, pdoc, user)) return null;
    return {
        // Articles stay owned by the internal article node. The problem is an
        // association, not a parent: deleting a problem must not cascade-delete
        // somebody's article, replies, reactions, or history.
        parentType: DocumentModel.TYPE_DISCUSSION_NODE,
        parentId: ARTICLE_NODE_ID,
        problemId: pdoc.docId,
        problem: pdoc,
    };
}

export async function addArticle(args: AddArticleArgs): Promise<ObjectId> {
    const now = new Date();
    const shareToken = newArticleShareToken();
    const payload: any = {
        domainId: args.domainId,
        content: args.content,
        owner: args.owner,
        editor: args.owner,
        parentType: args.binding.parentType,
        parentId: args.binding.parentId,
        title: args.title,
        ip: args.ip,
        nReply: 0,
        highlight: !!args.highlight,
        pin: !!args.pin,
        updateAt: now,
        views: 0,
        sort: 100,
        // `hidden` is reserved for moderation. Bound-problem visibility is
        // tracked separately because Hydro rewrites `hidden` on problem edits.
        hidden: false,
        oi33Kind: 'article',
        oi33Visibility: args.visibility,
        oi33ProblemId: args.binding.problemId,
        oi33CreatedAt: now,
        oi33PublishedAt: args.visibility === 'public' ? now : null,
        oi33ContentUpdatedAt: now,
    };
    // Preserve Hydro's discussion lifecycle: OI33's synchronous/AI moderation
    // mutates `hidden` here, before the document is ever visible.
    await bus.parallel('discussion/before-add', payload);
    // Keep the bearer capability out of the discussion lifecycle payload so
    // unrelated hook consumers cannot accidentally log or serialize it. It is
    // still part of the document's first (atomic) insert.
    const extra = { ...payload, oi33ShareToken: shareToken };
    for (const key of ['domainId', 'content', 'owner', 'parentType', 'parentId']) delete extra[key];
    const did = await DocumentModel.add(
        payload.domainId, payload.content, payload.owner,
        DocumentModel.TYPE_DISCUSSION, null, payload.parentType, payload.parentId, extra,
    ) as ObjectId;
    await DiscussionModel.coll.insertOne({
        domainId: payload.domainId,
        docId: did,
        content: payload.content,
        uid: payload.owner,
        ip: payload.ip,
        time: now,
    });
    payload.docId = did;
    await bus.parallel('discussion/add', payload);
    return did;
}

export async function updateArticle(
    domainId: string,
    did: ObjectId,
    ddoc: any,
    args: {
        title: string;
        content: string;
        visibility: Oi33ArticleVisibility;
        binding: ArticleBinding;
        editor: number;
        ip: string | null;
        hidden: boolean;
        moderationPending: boolean;
        highlight?: boolean;
        pin?: boolean;
    },
) {
    const now = new Date();
    return await DiscussionModel.edit(domainId, did, {
        title: args.title,
        content: args.content,
        editor: args.editor,
        ip: args.ip,
        edited: true,
        highlight: !!args.highlight,
        pin: !!args.pin,
        hidden: args.hidden,
        oi33ModerationPending: args.moderationPending,
        parentType: args.binding.parentType,
        parentId: args.binding.parentId,
        oi33Visibility: args.visibility,
        oi33ProblemId: args.binding.problemId,
        oi33PublishedAt: args.visibility === 'public' ? (ddoc.oi33PublishedAt || now) : ddoc.oi33PublishedAt,
        oi33ContentUpdatedAt: now,
        updateAt: now,
    } as any);
}

export async function rotateArticleShareToken(domainId: string, did: ObjectId) {
    const token = newArticleShareToken();
    await DiscussionModel.edit(domainId, did, { oi33ShareToken: token } as any);
    return token;
}

export async function ensureArticleIndexes() {
    await Promise.all([
        DocumentModel.coll.createIndex(
            {
                domainId: 1, docType: 1, oi33Kind: 1, oi33Visibility: 1,
                hidden: 1, oi33ModerationPending: 1,
                pin: -1, updateAt: -1, docId: -1,
            } as any,
            { name: 'oi33_article_public_v2' },
        ),
        DocumentModel.coll.createIndex(
            { domainId: 1, docType: 1, oi33Kind: 1, owner: 1, updateAt: -1, docId: -1 } as any,
            { name: 'oi33_article_owner_v2' },
        ),
        DocumentModel.coll.createIndex(
            {
                domainId: 1, docType: 1, oi33Kind: 1,
                oi33ProblemId: 1, oi33Visibility: 1, hidden: 1,
                oi33ModerationPending: 1, docId: -1,
            } as any,
            { name: 'oi33_article_problem' },
        ),
    ]);
}
