import {
    Context, DomainModel, Handler, ObjectId, param, PERM, PRIV, Types, UserModel, ValidationError,
} from 'hydrooj';
import { assertEducationAdmin, isEducationAdmin } from '../model/education-auth';
import { confirmAccountBatch, getAccountBatch, previewAccountBatch, ensureAccountBatchIndexes } from '../model/account-batch';
import { addLog } from '../model/log';

function privatePage(h: Handler) {
    h.response.addHeader('Cache-Control', 'private, no-store');
    h.response.addHeader('Pragma', 'no-cache');
}

class AccountBatchCreateHandler extends Handler {
    async prepare() { assertEducationAdmin(this.user); privatePage(this); }

    async get({ domainId }) {
        this.response.template = 'oi33_account_batch.html';
        this.response.body = { groups: (await UserModel.listGroup(domainId)).filter((g) => !/^\d+$/.test(g.name)) };
    }

    @param('users', Types.Content)
    @param('accountType', Types.String)
    @param('groups', Types.CommaSeperatedArray, true)
    @param('contestIds', Types.CommaSeperatedArray, true)
    @param('validFrom', Types.String, true)
    @param('validUntil', Types.String, true)
    async post(domainId: string, users: string, accountType: string, groups: string[] = [],
        contestIds: string[] = [], validFrom = '', validUntil = '') {
        assertEducationAdmin(this.user);
        const batch = await previewAccountBatch(domainId, this.user._id, { users, accountType, groups, contestIds, validFrom, validUntil });
        this.response.redirect = this.url('oi33_account_batch_detail', { id: batch._id });
    }
}

class AccountBatchDetailHandler extends Handler {
    async prepare() { assertEducationAdmin(this.user); privatePage(this); }

    @param('id', Types.ObjectId)
    async get(domainId: string, id: ObjectId) {
        this.response.template = 'oi33_account_batch_detail.html';
        const batch = await getAccountBatch(domainId, this.user._id, id);
        this.response.body = { batch, credentials: [],
            retryable: batch.status === 'processing' && batch.leaseUntil && batch.leaseUntil.getTime() <= Date.now() };
    }

    @param('id', Types.ObjectId)
    @param('confirmed', Types.Boolean)
    async post(domainId: string, id: ObjectId, confirmed: boolean) {
        if (!confirmed) throw new ValidationError('confirmed', null, '请确认已核对学生身份和批次内容。');
        const result = await confirmAccountBatch(domainId, this.user._id, id);
        this.response.template = 'oi33_account_batch_detail.html';
        this.response.body = result;
        // Never put credentials in the URL, logs, persistent previews or a cached GET.
    }
}

class EducationAccessHandler extends Handler {
    async prepare() { assertEducationAdmin(this.user); privatePage(this); }

    async get({ domainId }) {
        this.response.template = 'oi33_education_access.html';
        const roles = await DomainModel.getRoles(domainId);
        this.response.body = { coachRole: roles.find((r) => r._id === 'coach') };
    }

    @param('confirmed', Types.Boolean)
    async postSetup(domainId: string, confirmed: boolean) {
        if (!confirmed) throw new ValidationError('confirmed');
        const roles = await DomainModel.getRoles(domainId);
        if (roles.some((role) => role._id === 'coach')) throw new ValidationError('role', null, '教练角色已存在，不会覆盖它的现有权限。');
        // Start from Hydro's built-in student capabilities, not a possibly elevated custom default role.
        await DomainModel.addRole(domainId, 'coach', PERM.PERM_DEFAULT | PERM.PERM_CREATE_HOMEWORK | PERM.PERM_EDIT_HOMEWORK_SELF);
        await addLog({ type: 'education', action: 'create_coach_role', sender: this.user._id, domainId });
        this.back();
    }

    @param('uid', Types.PositiveInt)
    @param('confirmed', Types.Boolean)
    async postCoach(domainId: string, uid: number, confirmed: boolean) {
        if (!confirmed) throw new ValidationError('confirmed');
        const roles = await DomainModel.getRoles(domainId);
        if (!roles.some((role) => role._id === 'coach')) throw new ValidationError('role', null, '请先创建教练角色。');
        const user = await UserModel.getById(domainId, uid);
        if (!user || isEducationAdmin(user) || !['default', 'guest', 'coach'].includes(user.role)) {
            throw new ValidationError('uid', null, '不能覆盖管理员或自定义角色；请在域权限管理中处理。');
        }
        await DomainModel.setUserRole(domainId, uid, 'coach', true);
        await addLog({ type: 'education', action: 'assign_coach', sender: this.user._id, userId: uid, domainId });
        this.back();
    }
}

export async function apply(ctx: Context) {
    ctx.Route('oi33_account_batch', '/oi33/accounts/batch', AccountBatchCreateHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_account_batch_detail', '/oi33/accounts/batch/:id', AccountBatchDetailHandler, PRIV.PRIV_USER_PROFILE);
    ctx.Route('oi33_education_access', '/oi33/education/access', EducationAccessHandler, PRIV.PRIV_USER_PROFILE);
    ctx.injectUI('UserDropdown', 'oi33_account_batch', { icon: 'user--multiple', displayName: '批量建号' }, (h: any) => isEducationAdmin(h.user));
    ctx.injectUI('UserDropdown', 'oi33_education_access', { icon: 'wrench', displayName: '教学权限设置' }, (h: any) => isEducationAdmin(h.user));
    ctx.on('app/started', ensureAccountBatchIndexes);
}
