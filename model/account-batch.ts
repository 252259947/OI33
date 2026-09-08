import { randomBytes } from 'crypto';
import { ContestModel, db, DomainModel, ObjectId, PRIV, SystemModel, Types, UserModel, ValidationError } from 'hydrooj';
import { addLog } from './log';
import { getEnrollment, provisionEnrollment } from './enrollment';
import { addStudentsToGroups } from './education';
import { AccountBatchRowInput, parseAccountBatch, validateBatchWindow } from './account-batch-policy';

interface BatchRow extends AccountBatchRowInput {
    mail: string;
    uid?: number;
    state: 'pending' | 'creating' | 'created' | 'done' | 'failed';
    error?: string;
}
interface AccountBatch {
    _id: ObjectId;
    domainId: string;
    owner: number;
    accountType: 'regular' | 'temporary';
    groups: string[];
    contestIds: string[];
    validFrom?: Date;
    validUntil?: Date;
    createdAt: Date;
    expiresAt: Date;
    status: 'preview' | 'processing' | 'partial' | 'completed';
    rows: BatchRow[];
    lease?: string;
    leaseUntil?: Date;
}
declare module 'hydrooj' { interface Collections { oi33_account_batch: AccountBatch; } }
const batches = db.collection('oi33_account_batch');
const rawUsers = db.collection<any>('user');

async function validateTargets(domainId: string, groups: string[], contestIds: string[]) {
    const existing = new Set((await UserModel.listGroup(domainId)).map((g) => g.name));
    if (groups.some((g) => !existing.has(g) || /^\d+$/.test(g))) throw new ValidationError('groups', null, '班型不存在，请先创建班型。');
    for (const id of contestIds) {
        const contest = await ContestModel.get(domainId, new ObjectId(id));
        if (!contest || contest.rule === 'homework') throw new ValidationError('contestIds', null, '请选择当前域内的比赛。');
    }
}

async function validateExisting(domainId: string, row: AccountBatchRowInput) {
    const user = await UserModel.getById(domainId, row.existingUid!);
    const raw = await rawUsers.findOne({ _id: row.existingUid });
    if (!user || !raw || raw.uname.toLowerCase() !== row.username.toLowerCase()
        || user.hasPriv(PRIV.PRIV_ALL) || user.role === 'root' || user.role === 'coach'
        || Number(user.realname_flag || 0) >= 2) throw new ValidationError('users', null, '已有 UID 和用户名不匹配，或该账号不能作为学生导入。');
    const enrollment = await getEnrollment(row.existingUid!);
    const legacy = await db.collection('oi33_user').findOne({ _id: row.existingUid });
    const membership = await db.collection<any>('domain.user').findOne({ domainId, uid: row.existingUid, join: true });
    if (enrollment ? enrollment.domainId !== domainId : !membership) {
        throw new ValidationError('users', null, '已有账号必须已加入当前域，不能通过批量关联隐式导入其他域的身份。');
    }
    const verified = enrollment
        ? enrollment.domainId === domainId && enrollment.status === 'approved' && enrollment.enabled && enrollment.accountType === 'regular'
        : Number(legacy?.realname_flag) === 1;
    if (!verified || (enrollment?.realName || legacy?.realname_name || '').trim() !== row.realName) {
        throw new ValidationError('users', null, '已有账号必须是已核验的日常账号，且姓名一致；不会覆盖原账号身份。');
    }
}

export async function previewAccountBatch(domainId: string, owner: number, input: {
    users: string; accountType: string; groups: string[]; contestIds: string[]; validFrom: string; validUntil: string;
}) {
    let parsed: AccountBatchRowInput[];
    let window: { validFrom?: Date; validUntil?: Date };
    const groups = [...new Set(input.groups.map((s) => s.trim()).filter(Boolean))];
    const contestIds = [...new Set(input.contestIds.map((s) => s.trim().toLowerCase()).filter(Boolean))];
    try {
        parsed = parseAccountBatch(input.users);
        window = validateBatchWindow(input.accountType, input.validFrom, input.validUntil, contestIds);
    } catch (e: any) { throw new ValidationError('users', null, e.message); }
    if (input.accountType === 'temporary' && (groups.length || parsed.some((row) => row.existingUid))) {
        throw new ValidationError('users', null, '临时比赛批次只能新建专用账号，不能关联正式账号或加入教学班型。');
    }
    await validateTargets(domainId, groups, contestIds);
    const _id = new ObjectId();
    const rows: BatchRow[] = [];
    for (const [index, row] of parsed.entries()) {
        if (!Types.Username[1](row.username)) throw new ValidationError('users', null, `第 ${index + 1} 行用户名不符合站点要求。`);
        if (row.existingUid) await validateExisting(domainId, row);
        else if (await UserModel.getByUname('system', row.username)) {
            throw new ValidationError('users', null, `用户名 ${row.username} 已存在，请核对并填写已有 UID。`);
        }
        rows.push({ ...row, mail: `batch-${_id.toHexString()}-${index}@accounts.invalid`, state: 'pending' });
    }
    const doc: AccountBatch = {
        _id, domainId, owner, groups, contestIds, accountType: input.accountType as any, ...window, rows,
        createdAt: new Date(), expiresAt: new Date(Date.now() + 30 * 60 * 1000), status: 'preview',
    };
    await batches.insertOne(doc);
    await addLog({ type: 'education', action: 'batch_preview', sender: owner, educationBatchId: _id.toHexString(), count: rows.length });
    return doc;
}

export async function getAccountBatch(domainId: string, owner: number, id: ObjectId) {
    const doc = await batches.findOne({ _id: id, domainId, owner });
    if (!doc) throw new ValidationError('id', null, '批次不存在或不属于当前操作人。');
    return doc;
}

/** Unique initial passwords are returned once, never persisted in batches or logs. */
export async function confirmAccountBatch(domainId: string, owner: number, id: ObjectId) {
    const current = await getAccountBatch(domainId, owner, id);
    if (current.status === 'completed') return { batch: current, credentials: [] };
    if (current.status === 'preview' && current.expiresAt.getTime() <= Date.now()) throw new ValidationError('id', null, '预览已过期，请重新预览。');
    if (current.accountType === 'temporary' && current.validUntil!.getTime() <= Date.now()) throw new ValidationError('id', null, '临时账号有效期已经结束。');
    if (current.accountType === 'temporary' && (current.groups.length || current.rows.some((row) => row.existingUid))) {
        throw new ValidationError('id', null, '临时比赛批次不能关联正式账号或加入教学班型，请重新预览。');
    }
    await validateTargets(domainId, current.groups, current.contestIds);
    const lease = randomBytes(16).toString('hex');
    const batch = await batches.findOneAndUpdate({
        _id: id, domainId, owner,
        $or: [{ status: 'preview', expiresAt: { $gt: new Date() } }, { status: 'partial' },
            { status: 'processing', leaseUntil: { $lte: new Date() } }],
    }, { $set: { status: 'processing', lease, leaseUntil: new Date(Date.now() + 10 * 60 * 1000) } }, { returnDocument: 'after' });
    if (!batch) throw new ValidationError('id', null, '该批次正在处理，请勿重复确认。');
    const credentials: { username: string; realName: string; uid: number; password: string }[] = [];
    const saveRow = async (index: number, row: BatchRow) => {
        const result = await batches.updateOne({ _id: id, lease, status: 'processing' }, {
            $set: { [`rows.${index}`]: row, leaseUntil: new Date(Date.now() + 10 * 60 * 1000) },
        });
        if (!result.matchedCount) throw new Error('批次锁已失效，请重新打开批次查看结果。');
    };
    for (const [index, row] of batch.rows.entries()) {
        if (row.state === 'done') continue;
        let password = '';
        try {
            await saveRow(index, row);
            if (row.existingUid) {
                await validateExisting(domainId, row);
                row.uid = row.existingUid;
            } else if (!row.uid) {
                // Do not adopt a concurrently created or uncertain account merely by its name.
                if (await UserModel.getByUname('system', row.username)) throw new Error('用户名已存在；为避免接管或重复建号，已停止此行，请管理员核对。');
                row.state = 'creating';
                await saveRow(index, row);
                password = `Hj!${randomBytes(15).toString('base64url')}`;
                // A partially configured account cannot sign in or bypass its contest scope.
                row.uid = await UserModel.create(row.mail, row.username, password, undefined, '127.0.0.1', 0);
                row.state = 'created';
                await saveRow(index, row);
                credentials.push({ username: row.username, realName: row.realName, uid: row.uid!, password });
            }
            if (!row.existingUid) {
                await provisionEnrollment({
                    uid: row.uid!, domainId, realName: row.realName, studentId: row.studentId,
                    accountType: batch.accountType, validFrom: batch.validFrom, validUntil: batch.validUntil,
                    contestScopes: batch.contestIds.map((contestId) => ({ domainId, contestId })),
                    batchId: id.toHexString(), rosterKey: String(index),
                    requiresPasswordChange: batch.accountType === 'regular',
                }, owner);
            }
            await addStudentsToGroups(domainId, [row.uid!], batch.groups, owner);
            // Existing student accounts keep their role, privilege bits, password and UID.
            await DomainModel.setUserInDomain(domainId, row.uid!, { join: true });
            if (!row.existingUid) {
                await UserModel.setById(row.uid!, { priv: SystemModel.get('default.priv') });
            }
            row.state = 'done';
            delete row.error;
        } catch {
            row.state = 'failed';
            // Never persist arbitrary downstream exceptions: they may echo a password.
            row.error = '此行未完成，请管理员核对用户名、UID 和账号状态后重试；不会覆盖已有账号或密码。';
        }
        await saveRow(index, row);
    }
    const status = batch.rows.every((row) => row.state === 'done') ? 'completed' : 'partial';
    await batches.updateOne({ _id: id, lease }, { $set: { status }, $unset: { lease: '', leaseUntil: '' } });
    await addLog({ type: 'education', action: 'batch_confirm', sender: owner, educationBatchId: id.toHexString(), reason: status,
        count: batch.rows.filter((row) => row.state === 'done').length });
    return { batch: await getAccountBatch(domainId, owner, id), credentials };
}

export async function ensureAccountBatchIndexes() {
    await batches.createIndex({ domainId: 1, owner: 1, createdAt: -1 });
    // Audit/history is retained. Expired previews are unusable, not automatically deleted.
}
