import { Context, UserModel } from 'hydrooj';
import avatar from 'hydrooj/src/lib/avatar';
import { isEducationCoach } from '../model/education-auth';

// These are public identity views, not teaching scoreboards or account settings.
const PUBLIC_IDENTITY_HANDLERS = new Set([
    'UserDetail', 'Home', 'DomainRank', 'RatingShow',
    'DiscussionMain', 'DiscussionNode', 'DiscussionDetail', 'ArticleMine',
]);

export function publicStudentName(identity: any, uid: number): string {
    const username = typeof identity?.uname === 'string' ? identity.uname.trim() : '';
    const email = typeof identity?.mail === 'string' ? identity.mail.trim() : '';
    return username || email || `UID ${uid}`;
}

export async function applyPublicStudentIdentity(h: any) {
    const name = h.constructor.name.replace(/Handler$/, '');
    if (!PUBLIC_IDENTITY_HANDLERS.has(name) || h.request.method.toLowerCase() !== 'get'
        || isEducationCoach(h.user)) return;
    const body = h.response?.body;
    if (!body || typeof body !== 'object') return;
    const users = [body.udoc, ...(body.udocs || []), ...Object.values(body.udict || {}), h.user]
        .filter((user: any) => user && Number.isSafeInteger(user._id));
    const uids = [...new Set<number>(users.map((user: any) => user._id).filter((uid) => uid > 0))];
    // Read just the authoritative login identity: getById/getList intentionally
    // anonymize pending profiles before this request-specific presentation step.
    const identities = uids.length ? await UserModel.coll.find({ _id: { $in: uids } })
        .project({ _id: 1, uname: 1, mail: 1 }).toArray() : [];
    const byUid = new Map(identities.map((identity) => [identity._id, identity]));
    const copies = new Map<any, any>();
    const present = (original: any) => {
        if (!original || !Number.isSafeInteger(original._id)) return original;
        if (copies.has(original)) return copies.get(original);
        const user = Object.create(Object.getPrototypeOf(original), Object.getOwnPropertyDescriptors(original));
        user.oi33_public_name = publicStudentName(byUid.get(user._id), user._id);
        if (Array.isArray(user._publicFields)) user._publicFields = [...user._publicFields, 'oi33_public_name'];
        // Keep the stored username and pending-profile flags intact. Only this
        // response gets the public label, and extra identity fields stay private.
        user.displayName = '';
        user.realname_name = '';
        if (user._id !== h.user?._id) user.mail = '';
        if (typeof user.avatar === 'string' && user.avatar.startsWith('gravatar:')) {
            user.avatar = `url:${avatar(user.avatar, 128)}`;
        }
        copies.set(original, user);
        return user;
    };
    if (body.udoc) body.udoc = present(body.udoc);
    if (Array.isArray(body.udocs)) body.udocs = body.udocs.map(present);
    if (body.udict) body.udict = Object.fromEntries(Object.entries(body.udict).map(([uid, user]) => [uid, present(user)]));
    // Ranking's pinned self row and the navigation use the request's session user.
    h.user = present(h.user);
    if (name === 'UserDetail' && body.udoc && h.UiContext) h.UiContext.extraTitleContent = body.udoc.oi33_public_name;
    h.response.addHeader('Cache-Control', 'private, no-store');
}

export function apply(ctx: Context) {
    // The generic after event runs after specific hooks, including article-list
    // rebuilding. Registering on the specific events would let rebuilt users
    // silently replace these sanitized response copies.
    ctx.on('handler/after', applyPublicStudentIdentity);
}
