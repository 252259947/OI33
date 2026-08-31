import { Context } from 'hydrooj';

export function apply(ctx: Context) {
    // Keep redesigned core pages namespaced so they can be rolled back without
    // competing with another addon's same-name template override.
    ctx.on('handler/after/ProblemMain', (handler: any) => {
        if (handler.response?.template === 'problem_main.html') {
            handler.response.template = 'oi33_v2_problem_main.html';
        }
    });
    const useDiscussionHub = (handler: any) => {
        if (handler.response?.template === 'discussion_main_or_node.html') {
            handler.response.template = 'oi33_v2_discussion_main.html';
        }
    };
    ctx.on('handler/after/DiscussionMain', useDiscussionHub);
    ctx.on('handler/after/DiscussionNode', useDiscussionHub);

    // The Hydro settings registry still contains multi-domain switches. Keep
    // their stored values for core compatibility, but do not expose them in
    // huaji OJ's single-site control panel.
    const hiddenSingleSiteSettings = new Set([
        'ui-default.domainNavigation',
        'server.allowInvite',
        'server.showDefaultRole',
    ]);
    ctx.on('handler/after/SystemSetting', (handler: any) => {
        const settings = handler.response?.body?.settings;
        if (!Array.isArray(settings)) return;
        handler.response.body.settings = settings.filter(
            (setting: any) => !hiddenSingleSiteSettings.has(setting.key),
        );
    });
}
