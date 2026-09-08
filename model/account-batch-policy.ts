export interface AccountBatchRowInput {
    username: string;
    realName: string;
    studentId: string;
    existingUid?: number;
}

function splitRow(line: string): string[] {
    if (line.includes('\t')) return line.split('\t').map((v) => v.trim());
    const fields: string[] = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            if (quoted && line[i + 1] === '"') { value += '"'; i++; }
            else quoted = !quoted;
        } else if (c === ',' && !quoted) { fields.push(value.trim()); value = ''; }
        else value += c;
    }
    if (quoted) throw new Error('引号未闭合；请每行填写一位学生。');
    fields.push(value.trim());
    return fields;
}

/** Columns: username, real name, student ID (optional), existing UID (optional). */
export function parseAccountBatch(source: string): AccountBatchRowInput[] {
    if (typeof source !== 'string' || source.length > 100000) throw new Error('名单过大。');
    const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/).filter((s) => s.trim());
    if (lines.length && /^(用户名|username)(\t|,)/i.test(lines[0])) lines.shift();
    if (!lines.length || lines.length > 200) throw new Error('每批请填写 1–200 位学生。');
    const usernames = new Set<string>();
    const uids = new Set<number>();
    return lines.map((line, index) => {
        const parts = splitRow(line);
        if (parts.length < 2 || parts.length > 4) throw new Error(`第 ${index + 1} 行应有 2–4 列。`);
        const [username, realName, studentId = '', uid = ''] = parts;
        if (!username || username.length > 64 || /[\x00-\x1f\x7f]/.test(username)) {
            throw new Error(`第 ${index + 1} 行用户名不正确。`);
        }
        if (!realName || realName.length > 60 || /[\x00-\x1f\x7f]/.test(realName)) {
            throw new Error(`第 ${index + 1} 行必须填写真实姓名（最多 60 字）。`);
        }
        if (studentId.length > 64 || /[\x00-\x1f\x7f]/.test(studentId)) throw new Error('学号格式不正确。');
        const existingUid = uid ? Number(uid) : undefined;
        if (uid && (!/^\d+$/.test(uid) || !Number.isSafeInteger(existingUid) || existingUid! < 2)) {
            throw new Error(`第 ${index + 1} 行已有 UID 不正确。`);
        }
        const key = username.toLocaleLowerCase('en-US');
        if (usernames.has(key) || (existingUid !== undefined && uids.has(existingUid))) {
            throw new Error(`第 ${index + 1} 行重复；同一学生请保留一行。`);
        }
        usernames.add(key);
        if (existingUid !== undefined) uids.add(existingUid);
        return { username, realName, studentId, existingUid };
    });
}

export function validateBatchWindow(kind: string, from: string, until: string, scopes: string[], now = Date.now()) {
    if (kind !== 'regular' && kind !== 'temporary') throw new Error('账号用途不正确。');
    if (kind === 'regular') return {};
    if (![from, until].every((s) => /(?:Z|[+-]\d{2}:\d{2})$/.test(s))) throw new Error('临时账号起止时间必须包含时区，例如 +08:00。');
    const validFrom = new Date(from);
    const validUntil = new Date(until);
    if (!Number.isFinite(validFrom.getTime()) || !Number.isFinite(validUntil.getTime())
        || validFrom >= validUntil || validUntil.getTime() <= now) throw new Error('请填写有效的临时账号起止时间。');
    if (!scopes.length || scopes.some((s) => !/^[a-f\d]{24}$/i.test(s))) throw new Error('临时账号必须指定比赛。');
    return { validFrom, validUntil };
}
