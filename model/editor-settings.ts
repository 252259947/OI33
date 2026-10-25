import { db } from 'hydrooj';
import { EditorSettings, readEditorSettings, validateEditorSettingsPatch } from './editor-settings-policy';
import { addLog } from './log';

interface EditorSettingsDocument extends EditorSettings { _id: number; updatedAt: Date }
declare module 'hydrooj' { interface Collections { oi33_editor_settings: EditorSettingsDocument } }
export const editorSettingsColl = db.collection('oi33_editor_settings');

function validUid(uid: number) {
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('Invalid editor settings account');
}

export async function getEditorSettings(uid: number): Promise<EditorSettings | null> {
    validUid(uid);
    return readEditorSettings(await editorSettingsColl.findOne({ _id: uid }));
}

export async function saveEditorSettings(uid: number, input: unknown, initialize = false): Promise<EditorSettings> {
    validUid(uid);
    const patch = validateEditorSettingsPatch(input);
    const update = { $set: { ...patch, updatedAt: new Date() } };
    if (initialize) {
        let inserted = false;
        try {
            const result = await editorSettingsColl.updateOne({ _id: uid },
                { $setOnInsert: update.$set }, { upsert: true });
            inserted = !!result.upsertedCount;
        } catch (error: any) {
            if (error?.code !== 11000) throw error;
            // Another tab created the record first. Its settings win intact.
        }
        const settings = await getEditorSettings(uid);
        if (!settings) throw new Error('编辑器设置保存失败，请重试。');
        if (inserted) await addLog({ type: 'education', action: 'editor_settings_initialize', userId: uid,
            operator: uid, reason: Object.keys(patch).sort().join(',') });
        return settings;
    }
    let saved: EditorSettingsDocument | null;
    try {
        // Set only changed fields; another tab changing a different preference
        // cannot be overwritten by an older full snapshot from this tab.
        saved = await editorSettingsColl.findOneAndUpdate({ _id: uid }, update,
            { upsert: true, returnDocument: 'after' });
    } catch (error: any) {
        if (error?.code !== 11000) throw error;
        // Two first-time saves may race the unique UID index. Retain both patches.
        saved = await editorSettingsColl.findOneAndUpdate({ _id: uid }, update,
            { returnDocument: 'after' });
    }
    if (!saved) throw new Error('编辑器设置保存失败，请重试。');
    await addLog({ type: 'education', action: 'editor_settings_update', userId: uid, operator: uid,
        reason: Object.keys(patch).sort().join(',') });
    return readEditorSettings(saved)!;
}
