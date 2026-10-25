import {
    Context, ForbiddenError, Handler, NotFoundError, PRIV, Types, UserModel, ValidationError, param, requireSudo,
} from 'hydrooj';
import { getEnrollment } from '../model/enrollment';
import { addLog } from '../model/log';
import { requireAccountMutationOrigin } from './enrollment';

export function normalizeLoginUsername(value: string): string {
    const username = typeof value === 'string' ? value.trim() : '';
    // Hydro accepts at most 31 characters. Keeping @ and numeric-only names out
    // prevents ambiguity with its email-first login lookup and stable UIDs.
    if (!/^[A-Za-z][A-Za-z0-9_]{2,30}$/.test(username)) {
        throw new ValidationError('username', null, '用户名须为 3–31 位，以英文字母开头，只能包含字母、数字和下划线。');
    }
    return username;
}

function requireExpectedAccount(handler: any) {
    const expected = handler.args?.expectedUid;
    if (expected !== handler.user._id && expected !== String(handler.user._id)) {
        throw new ForbiddenError('登录账号已改变，请刷新页面后再修改用户名。');
    }
}

export class Oi33AccountUsernameHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        this.response.addHeader('Cache-Control', 'private, no-store');
        this.response.addHeader('Pragma', 'no-cache');
        if (!Number.isSafeInteger(this.user._id) || this.user._id <= 0 || this.session.sudoUid) {
            throw new ForbiddenError('请使用自己的账号修改登录用户名，代登录状态下不能修改。');
        }
        // This must precede requireSudo, which may retain submitted arguments.
        if (this.request.method.toLowerCase() === 'post') {
            requireAccountMutationOrigin(this);
            requireExpectedAccount(this);
        }
        const enrollment = await getEnrollment(this.user._id);
        if (enrollment && (!enrollment.enabled || enrollment.accountType === 'temporary')) {
            throw new ForbiddenError('此账号暂不能自行修改用户名，请联系管理员。');
        }
    }

    async get() {
        const current = await UserModel.coll.findOne({ _id: this.user._id }, { projection: { uname: 1 } });
        if (!current) throw new NotFoundError(this.user._id);
        this.response.template = 'oi33_account_username.html';
        this.response.body = { currentUsername: current.uname, currentUid: this.user._id };
    }

    @requireSudo
    @param('username', Types.String)
    @param('expectedUid', Types.PositiveInt)
    async post(domainId: string, input: string) {
        requireAccountMutationOrigin(this);
        requireExpectedAccount(this);
        const username = normalizeLoginUsername(input);
        const uid = this.user._id;
        await this.limitRate('oi33_username_change', 3600, 5, String(uid));
        const current = await UserModel.coll.findOne({ _id: uid }, { projection: { uname: 1 } });
        if (!current) throw new NotFoundError(uid);
        if (username !== current.uname) {
            const duplicate = await UserModel.getByUname('system', username);
            if (duplicate && duplicate._id !== uid) {
                throw new ValidationError('username', null, '这个用户名已被使用，请换一个。');
            }
            try {
                // Native model updates unameLower and invalidates both cache keys.
                await UserModel.setUname(uid, username);
            } catch (error: any) {
                if (error?.code === 11000) throw new ValidationError('username', null, '这个用户名已被使用，请换一个。');
                throw error;
            }
            // Do not retain the former username here: it may contain a real name.
            await addLog({ type: 'admin', action: 'change_username', sender: uid, userId: uid,
                domainId: this.domain?._id || domainId, reason: '用户自助修改登录用户名' });
        }
        this.response.redirect = this.url('oi33_account_username', {
            query: { notification: '登录用户名已保存。下次登录可使用新用户名和原密码。' },
        });
    }
}

export function apply(ctx: Context) {
    ctx.Route('oi33_account_username', '/oi33/account/username', Oi33AccountUsernameHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('UserDropdown', 'oi33_account_username', { icon: 'account--circle', displayName: '登录用户名' },
        (handler: any) => handler.user.hasPriv(PRIV.PRIV_USER_PROFILE));
}
