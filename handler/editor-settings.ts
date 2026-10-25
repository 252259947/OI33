import { Context, ForbiddenError, Handler, PRIV, ValidationError } from 'hydrooj';
import { getEditorSettings, saveEditorSettings } from '../model/editor-settings';
import { validateEditorSettingsPatch } from '../model/editor-settings-policy';
import { requireAccountMutationOrigin } from './enrollment';

export class EditorSettingsHandler extends Handler {
    async prepare() {
        this.response.addHeader('Cache-Control', 'private, no-store');
        this.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!Number.isSafeInteger(this.user._id) || this.user._id <= 0) throw new ForbiddenError();
    }

    async get() {
        // The authenticated account is the only identity source; query parameters
        // and domain membership never select someone else's global preference.
        this.response.body = { uid: this.user._id, settings: await getEditorSettings(this.user._id) };
    }

    async post() {
        requireAccountMutationOrigin(this);
        const input = this.request.body;
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('editor_settings');
        if (!Number.isSafeInteger(input.expectedUid) || input.expectedUid !== this.user._id) {
            throw new ForbiddenError('登录账号已改变，请刷新页面后再修改编辑器设置。');
        }
        const { expectedUid, initialize, ...appearance } = input;
        if (initialize !== undefined && initialize !== true) throw new ValidationError('initialize');
        let patch;
        try { patch = validateEditorSettingsPatch(appearance); }
        catch (error: any) { throw new ValidationError('editor_settings', null, error.message); }
        this.response.body = { uid: this.user._id, settings: await saveEditorSettings(this.user._id, patch, initialize === true) };
    }
}

export async function injectEditorSettings(h: any) {
    if (h.request.method.toLowerCase() !== 'get' || h.response.redirect
        || (h.response.status && h.response.status >= 300) || h.response.template !== 'problem_detail.html'
        || !h.user.hasPriv(PRIV.PRIV_USER_PROFILE) || !Number.isSafeInteger(h.user._id) || h.user._id <= 0) return;
    h.response.addHeader('Cache-Control', 'private, no-store');
    try {
        h.UiContext.oi33EditorSettings = { uid: h.user._id, settings: await getEditorSettings(h.user._id) };
    } catch {
        // A preference-store failure must neither break the problem page nor
        // make the client overwrite an existing cloud preference as a migration.
        h.UiContext.oi33EditorSettings = { uid: h.user._id, settings: null, unavailable: true };
    }
}

export function apply(ctx: Context) {
    ctx.Route('oi33_editor_settings', '/oi33/editor-settings', EditorSettingsHandler, PRIV.PRIV_USER_PROFILE);
    ctx.on('handler/after/ProblemDetail#get', injectEditorSettings);
}
