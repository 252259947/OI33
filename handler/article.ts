import { createHash, timingSafeEqual } from 'crypto';
import {
    Context, DiscussionModel, DocumentModel, Handler, MessageModel, NotFoundError,
    ObjectId, OplogModel, PERM, PRIV, ProblemModel, ProblemNotFoundError, Types,
    UserModel, param, query,
} from 'hydrooj';
import { HomeHandler } from 'hydrooj/src/handler/home';
import { oi33Model } from '../model';
import {
    ARTICLE_NODE_ID, addArticle, articleGet, articleList, articleMine,
    articlePublicFilter, ensureArticleNode, normalizeArticleVisibility, resolveArticleBinding,
    rotateArticleShareToken, updateArticle,
} from '../model/article';
import type { Oi33ArticleVisibility } from '../model/types';
import { checkUserFlag } from './utils';

type ArticlePreset = 'article' | 'paste';
const ARTICLE_VISIBILITIES: Oi33ArticleVisibility[] = ['public', 'private', 'unlisted'];
const ARTICLE_PRESETS: ArticlePreset[] = ['article', 'paste'];
const SHARE_GRANT_TTL = 24 * 60 * 60 * 1000;
const SHARE_GRANT_LIMIT = 20;

interface ArticleShareGrant {
    domainId: string;
    did: string;
    tokenHash: string;
    expiresAt: number;
}

function notFound(): never {
    throw new NotFoundError('Article');
}

function canManageArticle(handler: any, ddoc: any) {
    return ddoc.owner === handler.user?._id || !!handler.user?.hasPerm?.(PERM.PERM_EDIT_DISCUSSION);
}

function articleForLog(ddoc: any) {
    const { oi33ShareToken: _shareToken, ...safeDdoc } = ddoc || {};
    return safeDdoc;
}

function tokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
}

function tokensEqual(actual: unknown, supplied: unknown) {
    if (typeof actual !== 'string' || typeof supplied !== 'string') return false;
    if (!/^[A-Za-z0-9_-]{32}$/.test(supplied)) return false;
    const a = Buffer.from(actual, 'utf8');
    const b = Buffer.from(supplied, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

function getShareGrants(handler: any): ArticleShareGrant[] {
    const now = Date.now();
    const source = Array.isArray(handler.session?.oi33ArticleShareGrants)
        ? handler.session.oi33ArticleShareGrants : [];
    const grants = source.filter((grant: any) => (
        grant && typeof grant.domainId === 'string' && typeof grant.did === 'string'
        && typeof grant.tokenHash === 'string' && Number.isSafeInteger(grant.expiresAt)
        && grant.expiresAt > now
    )).slice(-SHARE_GRANT_LIMIT);
    if (handler.session) handler.session.oi33ArticleShareGrants = grants;
    return grants;
}

function hasShareGrant(handler: any, ddoc: any) {
    if (!ddoc?.oi33ShareToken) return false;
    const expected = tokenHash(ddoc.oi33ShareToken);
    return getShareGrants(handler).some((grant) => (
        grant.domainId === ddoc.domainId
        && grant.did === ddoc.docId.toHexString()
        && grant.tokenHash === expected
    ));
}

function grantShareAccess(handler: any, ddoc: any) {
    const did = ddoc.docId.toHexString();
    const grants = getShareGrants(handler).filter((grant) => !(
        grant.domainId === ddoc.domainId && grant.did === did
    ));
    grants.push({
        domainId: ddoc.domainId,
        did,
        tokenHash: tokenHash(ddoc.oi33ShareToken),
        expiresAt: Date.now() + SHARE_GRANT_TTL,
    });
    handler.session.oi33ArticleShareGrants = grants.slice(-SHARE_GRANT_LIMIT);
}

function addPrivateArticleHeaders(handler: any) {
    handler.response.addHeader('Cache-Control', 'private, no-store');
    handler.response.addHeader('Referrer-Policy', 'no-referrer');
    handler.response.addHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

async function articleNeedsModeration(uid: number) {
    try {
        if (await checkUserFlag(uid) >= 2) return false;
        const cfg = await oi33Model.aiGetConfig();
        return (cfg.moderation_enabled ?? '1') === '1';
    } catch (e) {
        console.error('[oi33] article moderation check failed closed:', e);
        return true;
    }
}

async function prepareArticle(handler: any, requireManage = false) {
    const did = handler.args?.did instanceof ObjectId
        ? handler.args.did : new ObjectId(String(handler.args?.did || ''));
    const ddoc = await articleGet(handler.domain._id, did);
    if (!ddoc || ddoc.oi33Kind !== 'article') return null;
    const manageable = canManageArticle(handler, ddoc);
    if (requireManage && !manageable) notFound();
    const viaShare = ddoc.oi33Visibility === 'unlisted' && hasShareGrant(handler, ddoc);
    if ((ddoc.hidden || ddoc.oi33ModerationPending) && !manageable) notFound();
    if (ddoc.oi33Visibility === 'private' && !manageable) notFound();
    if (ddoc.oi33Visibility === 'unlisted' && !manageable && !viaShare) notFound();
    if (ddoc.oi33ProblemId) {
        const pdoc = await ProblemModel.get(
            handler.domain._id, ddoc.oi33ProblemId, ProblemModel.PROJECTION_LIST,
        );
        if (pdoc) {
            if (!DiscussionModel.checkVNodeVisibility(DocumentModel.TYPE_PROBLEM, pdoc, handler.user)) notFound();
            handler.oi33ArticleProblem = pdoc;
            handler.vnode = {
                ...pdoc,
                type: DocumentModel.TYPE_PROBLEM,
                id: pdoc.docId,
            };
        }
    }
    // The capability token remains server-side. In particular, do not merge it
    // into the core handler's ddoc because that object becomes the page body.
    const { oi33ShareToken: _shareToken, ...safeDdoc } = ddoc;
    const { oi33ShareToken: _oldShareToken, ...currentDdoc } = handler.ddoc || {};
    handler.ddoc = {
        ...currentDdoc,
        ...safeDdoc,
        hidden: !!(safeDdoc.hidden || safeDdoc.oi33ModerationPending),
    };
    handler.oi33ArticleDoc = ddoc;
    handler.oi33ArticleCanManage = manageable;
    handler.oi33ArticleAccessViaShare = viaShare && !manageable;
    if (ddoc.oi33Visibility !== 'public' || ddoc.hidden || ddoc.oi33ModerationPending) {
        addPrivateArticleHeaders(handler);
    }
    return ddoc;
}

async function getArticleProblems(handler: any, ddocs: any[]) {
    const ids = [...new Set(ddocs
        .filter((ddoc) => ddoc.oi33Kind === 'article' && Number.isSafeInteger(ddoc.oi33ProblemId))
        .map((ddoc) => ddoc.oi33ProblemId))];
    if (!ids.length) return {};
    const canViewHidden = handler.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN)
        ? true : handler.user._id;
    return await ProblemModel.getList(
        handler.domain._id, ids, canViewHidden, false,
        ProblemModel.PROJECTION_LIST, true,
    );
}

async function publicArticleFeedQuery(domainId: string) {
    // Resolve problem visibility from the source of truth on every public feed
    // request. A problem becoming hidden must remove its associated article
    // immediately, without relying on an asynchronous denormalized flag.
    const visibleProblems = await ProblemModel.getMulti(
        domainId, { hidden: false }, ['docId'] as any,
    ).toArray();
    return {
        oi33Kind: 'article',
        $or: [
            { oi33ProblemId: null },
            { oi33ProblemId: { $in: visibleProblems.map((pdoc: any) => pdoc.docId) } },
        ],
    } as any;
}

async function articleProblemInput(domainId: string, ddoc: any) {
    if (!ddoc.oi33ProblemId) return '';
    const pdoc = await ProblemModel.get(domainId, ddoc.oi33ProblemId, ['docId', 'pid', 'title'] as any);
    return pdoc?.pid || String(ddoc.oi33ProblemId);
}

function patchHomepageDiscussion(ctx: Context) {
    const proto = HomeHandler.prototype as any;
    const oldGetDiscussion = proto.getDiscussion;
    const oldGetDiscussionNodes = proto.getDiscussionNodes;
    const getDiscussion = async function getDiscussion(this: any, domainId: string, limit = 20) {
        if (!this.user.hasPerm(PERM.PERM_VIEW_DISCUSSION)) return [[], {}];
        // The homepage is an article feed, not an aggregate of legacy contest
        // and training discussions whose parent visibility may be restricted.
        const ddocs = await articleList(domainId, await publicArticleFeedQuery(domainId))
            .limit(limit).toArray();
        const vndict = await DiscussionModel.getListVnodes(
            domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group,
        );
        this.collectUser(ddocs.map((ddoc: any) => ddoc.owner));
        return [ddocs, vndict];
    };
    const getDiscussionNodes = async function getDiscussionNodes(this: any, domainId: string) {
        const nodes = await oldGetDiscussionNodes.call(this, domainId);
        return nodes.filter((node: any) => node.docId !== ARTICLE_NODE_ID && !node.oi33Internal);
    };
    ctx.effect(() => {
        proto.getDiscussion = getDiscussion;
        proto.getDiscussionNodes = getDiscussionNodes;
        return () => {
            if (proto.getDiscussion === getDiscussion) proto.getDiscussion = oldGetDiscussion;
            if (proto.getDiscussionNodes === getDiscussionNodes) proto.getDiscussionNodes = oldGetDiscussionNodes;
        };
    });
}

// Keep the class name aligned with Hydro's core handler so the existing
// DiscussionCreate moderation lifecycle hooks run for this route as well.
class DiscussionCreateHandler extends Handler {
    @query('problem', Types.String, true)
    @query('preset', Types.Range(ARTICLE_PRESETS), true)
    @query('visibility', Types.Range(ARTICLE_VISIBILITIES), true)
    async get(
        domainId: string,
        problem = '',
        preset: ArticlePreset = 'article',
        visibility?: Oi33ArticleVisibility,
    ) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        const binding = await resolveArticleBinding(domainId, problem, this.user);
        if (!binding) throw new ProblemNotFoundError(domainId, problem);
        const articleVisibility = normalizeArticleVisibility(
            visibility || (preset === 'paste' ? 'unlisted' : 'public'),
        );
        this.response.template = 'oi33_article_edit.html';
        this.response.body = {
            articleMode: 'create',
            articleVisibility,
            articleProblemId: binding.problem?.pid || (binding.problemId ? String(binding.problemId) : ''),
            articlePreset: preset,
            vnode: binding.problem || await DiscussionModel.getNode(domainId, ARTICLE_NODE_ID),
            page_name: 'oi33_article_create',
        };
    }

    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('visibility', Types.Range(ARTICLE_VISIBILITIES))
    @param('problemId', Types.String, true)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async post(
        domainId: string,
        title: string,
        content: string,
        visibility: Oi33ArticleVisibility = 'public',
        problemId = '',
        highlight = false,
        pin = false,
    ) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        await this.limitRate('add_discussion', 3600, 60);
        if (highlight) this.checkPerm(PERM.PERM_HIGHLIGHT_DISCUSSION);
        if (pin) this.checkPerm(PERM.PERM_PIN_DISCUSSION);
        const binding = await resolveArticleBinding(domainId, problemId, this.user);
        if (!binding) throw new ProblemNotFoundError(domainId, problemId);
        const did = await addArticle({
            domainId,
            owner: this.user._id,
            title,
            content,
            ip: this.request.ip,
            visibility: normalizeArticleVisibility(visibility),
            binding,
            highlight,
            pin,
        });
        this.response.body = { did };
        this.response.redirect = this.url('discussion_detail', { did });
    }
}

// Same lifecycle-name rule as create: the current AI moderation hooks attach to
// DiscussionEdit#post and therefore continue to protect article updates.
class DiscussionEditHandler extends Handler {
    ddoc: any;

    @param('did', Types.ObjectId)
    async _prepare(domainId: string, did: ObjectId) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        this.ddoc = await articleGet(domainId, did);
        if (!this.ddoc || this.ddoc.oi33Kind !== 'article') notFound();
        if (!canManageArticle(this, this.ddoc)) notFound();
    }

    async get() {
        if (this.ddoc.owner === this.user._id) this.checkPerm(PERM.PERM_EDIT_DISCUSSION_SELF);
        else this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        const { oi33ShareToken: _shareToken, ...safeDdoc } = this.ddoc;
        this.response.template = 'oi33_article_edit.html';
        this.response.body = {
            ddoc: safeDdoc,
            articleMode: 'edit',
            articleVisibility: this.ddoc.oi33Visibility,
            articleProblemId: await articleProblemInput(this.domain._id, this.ddoc),
            articlePreset: 'article',
            articleShareUrl: this.ddoc.oi33Visibility === 'unlisted'
                ? this.url('oi33_article_share', {
                    did: this.ddoc.docId,
                    token: this.ddoc.oi33ShareToken,
                }) : null,
            articleCanDelete: this.ddoc.owner === this.user._id
                ? this.user.hasPerm(PERM.PERM_DELETE_DISCUSSION_SELF)
                : this.user.hasPerm(PERM.PERM_DELETE_DISCUSSION),
            page_name: 'oi33_article_edit',
        };
        addPrivateArticleHeaders(this);
    }

    @param('did', Types.ObjectId)
    @param('title', Types.Title)
    @param('content', Types.Content)
    @param('visibility', Types.Range(ARTICLE_VISIBILITIES))
    @param('problemId', Types.String, true)
    @param('highlight', Types.Boolean)
    @param('pin', Types.Boolean)
    async postUpdate(
        domainId: string,
        did: ObjectId,
        title: string,
        content: string,
        visibility: Oi33ArticleVisibility,
        problemId = '',
        highlight = false,
        pin = false,
    ) {
        if (!canManageArticle(this, this.ddoc)) notFound();
        if (this.ddoc.owner === this.user._id) this.checkPerm(PERM.PERM_EDIT_DISCUSSION_SELF);
        else this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        if (!this.user.hasPerm(PERM.PERM_HIGHLIGHT_DISCUSSION)) highlight = this.ddoc.highlight;
        if (!this.user.hasPerm(PERM.PERM_PIN_DISCUSSION)) pin = this.ddoc.pin;
        const binding = await resolveArticleBinding(domainId, problemId, this.user);
        if (!binding) throw new ProblemNotFoundError(domainId, problemId);
        const moderationPending = await articleNeedsModeration(this.user._id);
        await Promise.all([
            updateArticle(domainId, did, this.ddoc, {
                title,
                content,
                visibility: normalizeArticleVisibility(visibility),
                binding,
                editor: this.user._id,
                ip: this.request.ip,
                hidden: moderationPending,
                moderationPending,
                highlight,
                pin,
            }),
            OplogModel.log(this, 'discussion.edit', articleForLog(this.ddoc)),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('discussion_detail', { did });
    }

    @param('did', Types.ObjectId)
    async postDelete(domainId: string, did: ObjectId) {
        const own = this.ddoc.owner === this.user._id;
        if (!own) this.checkPerm(PERM.PERM_DELETE_DISCUSSION);
        else this.checkPerm(PERM.PERM_DELETE_DISCUSSION_SELF);
        await Promise.all([
            OplogModel.log(this, 'discussion.delete', articleForLog(this.ddoc)),
            !own && MessageModel.send(
                1,
                this.ddoc.owner,
                JSON.stringify({
                    message: 'Admin {0} delete your discussion "{1}".',
                    params: [this.user.uname, this.ddoc.title],
                }),
                MessageModel.FLAG_RICHTEXT | MessageModel.FLAG_UNREAD,
            ),
            DiscussionModel.del(domainId, did),
        ]);
        this.response.body = { did };
        this.response.redirect = this.url('oi33_article_mine');
    }
}

class ArticleMineHandler extends Handler {
    @query('page', Types.PositiveInt, true)
    async get(domainId: string, page = 1) {
        this.checkPerm(PERM.PERM_VIEW_DISCUSSION);
        const [ddocs, dpcount] = await this.paginate(articleMine(domainId, this.user._id), page, 'discussion');
        for (const ddoc of ddocs as any[]) ddoc.hidden ||= !!ddoc.oi33ModerationPending;
        const [udict, vndict] = await Promise.all([
            UserModel.getList(domainId, [this.user._id]),
            DiscussionModel.getListVnodes(
                domainId, ddocs, this.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), this.user.group,
            ),
        ]);
        const articlePdict = await getArticleProblems(this, ddocs as any[]);
        this.response.template = 'oi33_article_mine.html';
        this.response.body = {
            ddocs, page, dpcount, vndict, udict, articlePdict,
            page_name: 'oi33_article_mine',
        };
        addPrivateArticleHeaders(this);
    }
}

class ArticleShareHandler extends Handler {
    @param('did', Types.ObjectId)
    @param('token', Types.String)
    async get(domainId: string, did: ObjectId, token: string) {
        await this.limitRate('article_share', 3600, 120);
        const ddoc = await articleGet(domainId, did);
        if (!ddoc || ddoc.oi33Kind !== 'article' || ddoc.oi33Visibility !== 'unlisted') notFound();
        if (!tokensEqual(ddoc.oi33ShareToken, token)) notFound();
        grantShareAccess(this, ddoc);
        addPrivateArticleHeaders(this);
        this.response.redirect = this.url('discussion_detail', { did });
    }
}

class ArticleShareRotateHandler extends Handler {
    @param('did', Types.ObjectId)
    async post(domainId: string, did: ObjectId) {
        const ddoc = await articleGet(domainId, did);
        if (!ddoc || ddoc.oi33Kind !== 'article' || !canManageArticle(this, ddoc)) notFound();
        if (ddoc.owner === this.user._id) this.checkPerm(PERM.PERM_EDIT_DISCUSSION_SELF);
        else this.checkPerm(PERM.PERM_EDIT_DISCUSSION);
        const token = await rotateArticleShareToken(domainId, did);
        const articleShareUrl = this.url('oi33_article_share', { did, token });
        this.response.body = { did, articleShareUrl };
        this.response.redirect = this.url('discussion_detail', { did });
        addPrivateArticleHeaders(this);
    }
}

async function rebuildDiscussionMain(handler: any) {
    const domainId = handler.domain._id;
    const page = handler.args?.page || 1;
    const [ddocs, dpcount] = await handler.paginate(
        articleList(domainId, await publicArticleFeedQuery(domainId)), page, 'discussion',
    );
    const [udict, vndict, vnodes, articlePdict] = await Promise.all([
        UserModel.getList(domainId, ddocs.map((ddoc: any) => ddoc.owner)),
        DiscussionModel.getListVnodes(
            domainId, ddocs, handler.user.hasPerm(PERM.PERM_VIEW_PROBLEM_HIDDEN), handler.user.group,
        ),
        DiscussionModel.getNodes(domainId),
        getArticleProblems(handler, ddocs),
    ]);
    handler.response.body = {
        ...(handler.response.body || {}),
        ddocs,
        dpcount,
        udict,
        page,
        vndict,
        articlePdict,
        vnode: {},
        vnodes: vnodes.filter((node: any) => node.docId !== ARTICLE_NODE_ID && !node.oi33Internal),
        page_name: 'discussion_main',
    };
}

async function rebuildDiscussionNode(handler: any) {
    const body = handler.response?.body;
    if (!body?.vnode) return;
    const domainId = handler.domain._id;
    const page = handler.args?.page || 1;
    const vnode = body.vnode;
    const query = vnode.type === DocumentModel.TYPE_PROBLEM
        ? {
            $or: [
                { oi33Kind: 'article', oi33ProblemId: vnode.id },
                {
                    oi33Kind: { $ne: 'article' },
                    parentType: vnode.type,
                    parentId: vnode.id,
                },
            ],
        }
        : { parentType: vnode.type, parentId: vnode.id };
    const [ddocs, dpcount] = await handler.paginate(
        articleList(domainId, query as any), page, 'discussion',
    );
    const uids = ddocs.map((ddoc: any) => ddoc.owner);
    if (vnode.owner) uids.push(vnode.owner);
    const [udict, vnodes, articlePdict] = await Promise.all([
        UserModel.getList(domainId, uids),
        DiscussionModel.getNodes(domainId),
        getArticleProblems(handler, ddocs),
    ]);
    handler.response.body = {
        ...body,
        ddocs,
        dpcount,
        udict,
        page,
        vndict: { [vnode.type]: { [vnode.id.toString()]: vnode } },
        articlePdict,
        vnodes: vnodes.filter((node: any) => node.docId !== ARTICLE_NODE_ID && !node.oi33Internal),
    };
}

export async function apply(ctx: Context) {
    patchHomepageDiscussion(ctx);
    ctx.Route(
        'oi33_article_create', '/article/new', DiscussionCreateHandler,
        PRIV.PRIV_USER_PROFILE, PERM.PERM_CREATE_DISCUSSION,
    );
    ctx.Route(
        'oi33_article_edit', '/article/:did/edit', DiscussionEditHandler,
        PRIV.PRIV_USER_PROFILE,
    );
    ctx.Route('oi33_article_mine', '/article/mine', ArticleMineHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_article_share', '/article/share/:did/:token', ArticleShareHandler);
    ctx.Route(
        'oi33_article_share_rotate', '/article/:did/share/rotate', ArticleShareRotateHandler,
        PRIV.PRIV_USER_PROFILE,
    );

    // The internal node only satisfies Hydro's required discussion parent. It
    // must never appear as a user-facing discussion category.
    ctx.on('domain/create', (ddoc: any) => ensureArticleNode(ddoc._id));
    ctx.on('problem/delete', async (domainId: string, problemId: number) => {
        await DocumentModel.coll.updateMany(
            {
                domainId,
                docType: DocumentModel.TYPE_DISCUSSION,
                oi33Kind: 'article',
                oi33ProblemId: problemId,
            } as any,
            {
                $set: { oi33ProblemId: null, updateAt: new Date() },
            } as any,
        );
    });

    ctx.on('handler/before/DiscussionNode', (handler: any) => {
        if (handler.vnode?.type !== DocumentModel.TYPE_DISCUSSION_NODE
            || handler.vnode?.id !== ARTICLE_NODE_ID) return;
        handler.response.redirect = handler.url('discussion_main');
        return 'cleanup';
    });

    ctx.on('handler/before/DiscussionCreate', (handler: any) => {
        if (handler.vnode?.type !== DocumentModel.TYPE_DISCUSSION_NODE
            || handler.vnode?.id !== ARTICLE_NODE_ID
            || handler.request.path.startsWith('/article/')) return;
        handler.response.redirect = handler.url('oi33_article_create');
        return 'cleanup';
    });

    ctx.on('handler/before/DiscussionDetail', async (handler: any) => {
        await prepareArticle(handler);
    });
    ctx.on('handler/before/DiscussionRaw', async (handler: any) => {
        await prepareArticle(handler);
    });
    ctx.on('handler/before/DiscussionEdit', async (handler: any) => {
        // The custom article editor already performs an owner/admin check in
        // _prepare. Avoid fetching it twice (and avoid putting the raw token on
        // its ordinary ddoc property).
        if (handler.request.path.startsWith('/article/')) return;
        const ddoc = await prepareArticle(handler, true);
        if (!ddoc) return;
        handler.response.redirect = handler.url('oi33_article_edit', { did: ddoc.docId });
        return 'cleanup';
    });

    ctx.on('handler/after/DiscussionDetail', async (handler: any) => {
        const ddoc = handler.oi33ArticleDoc;
        if (!ddoc) return;
        const canManage = !!handler.oi33ArticleCanManage;
        const { oi33ShareToken: _shareToken, ...safeDdoc } = ddoc;
        const { oi33ShareToken: _oldShareToken, ...currentDdoc } = handler.response.body?.ddoc || {};
        handler.response.template = 'oi33_article_detail.html';
        handler.response.body = {
            ...(handler.response.body || {}),
            ddoc: {
                ...currentDdoc,
                ...safeDdoc,
                hidden: !!(safeDdoc.hidden || safeDdoc.oi33ModerationPending),
            },
            articleVisibility: ddoc.oi33Visibility,
            articleShareUrl: canManage && ddoc.oi33Visibility === 'unlisted'
                ? handler.url('oi33_article_share', { did: ddoc.docId, token: ddoc.oi33ShareToken }) : null,
            articleCanManage: canManage,
            articleAccessViaShare: !!handler.oi33ArticleAccessViaShare,
            page_name: 'oi33_article_detail',
        };
        if (ddoc.oi33Visibility !== 'public' || ddoc.hidden || ddoc.oi33ModerationPending) {
            addPrivateArticleHeaders(handler);
        }
    });

    ctx.on('handler/after/DiscussionMain', rebuildDiscussionMain);
    ctx.on('handler/after/DiscussionNode', rebuildDiscussionNode);

    ctx.on('handler/after/ProblemDetail', async (handler: any) => {
        const pdoc = handler.response?.body?.pdoc;
        if (!pdoc) return;
        handler.response.body.discussionCount = await DiscussionModel.count(handler.domain._id, {
            $and: [
                {
                    $or: [
                        {
                            oi33Kind: { $ne: 'article' },
                            parentType: DocumentModel.TYPE_PROBLEM,
                            parentId: pdoc.docId,
                        },
                        { oi33Kind: 'article', oi33ProblemId: pdoc.docId },
                    ],
                },
                articlePublicFilter(),
            ],
        } as any);
    });

    ctx.on('handler/after/HomeworkDetail', async (handler: any) => {
        const body = handler.response?.body;
        const tdoc = body?.tdoc;
        if (!tdoc) return;
        const page = handler.args?.page || 1;
        const [ddocs, dpcount, dcount] = await handler.paginate(
            articleList(handler.domain._id, { parentType: tdoc.docType, parentId: tdoc.docId }),
            page,
            'discussion',
        );
        const uids = ddocs.map((ddoc: any) => ddoc.owner);
        if (tdoc.owner) uids.push(tdoc.owner);
        body.ddocs = ddocs;
        body.dpcount = dpcount;
        body.dcount = dcount;
        body.udict = await UserModel.getList(handler.domain._id, uids);
    });
}
