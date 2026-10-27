import { existsSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, sep } from 'path';
import type { Plugin } from 'esbuild';

/** Import the installed native reducers, not copies maintained by this addon. */
export function createEditorDraftBuildPlugin(packagePath = require.resolve('@hydrooj/ui-default/package.json')): Plugin {
    const uiRoot = dirname(realpathSync(packagePath));
    const reducerRoot = join(uiRoot, 'components', 'scratchpad', 'reducers');
    const guardPath = realpathSync(join(__dirname, 'frontend', 'editor-draft-guard.ts'));
    const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
    return {
        name: 'oi33-native-editor-draft',
        setup(build) {
            const isNativeReducer = (importer: string) => importer && existsSync(importer)
                && realpathSync(importer).startsWith(`${reducerRoot}${sep}`);
            build.onResolve({ filter: /^@hydrooj\/ui-default\/oi33-native-scratchpad-reducer$/ }, (args) => {
                if (!args.importer || !existsSync(args.importer) || realpathSync(args.importer) !== guardPath) {
                    throw new Error('Unexpected native draft reducer importer');
                }
                // The wrapper relies on the two native editor action names and
                // draft key format. Recheck them explicitly when upgrading Hydro.
                if (version !== '4.58.4') throw new Error(`Verify editor draft integration for ui-default ${version}`);
                return { path: realpathSync(join(reducerRoot, 'index.ts')) };
            });
            build.onResolve({ filter: /^(redux|lodash|@hydrooj\/common)$/ }, (args) => {
                if (!isNativeReducer(args.importer)) return undefined;
                // Global Hydro and the addon need not share a node_modules
                // ancestor. Redux is an explicit addon runtime dependency.
                return { path: require.resolve(args.path, { paths: args.path === 'redux' ? [__dirname] : [uiRoot, __dirname] }) };
            });
            build.onResolve({ filter: /^vj\// }, (args) => {
                if (!isNativeReducer(args.importer)) return undefined;
                if (!['vj/components/notification', 'vj/utils'].includes(args.path)) {
                    throw new Error(`Unexpected native reducer dependency: ${args.path}`);
                }
                return { path: args.path, namespace: 'oi33-native-reducer-api' };
            });
            build.onLoad({ filter: /.*/, namespace: 'oi33-native-reducer-api' }, (args) => ({
                contents: args.path === 'vj/utils'
                    ? 'export const i18n = window.HydroExports.i18n;'
                    : 'export default window.HydroExports.Notification;',
                loader: 'js',
            }));
        },
    };
}

export function installEditorDraftBuildPlugin() {
    const ui = (global as any).Hydro.ui;
    const plugins: Plugin[] = ui.esbuildPlugins ||= [];
    if (!plugins.some((plugin) => plugin.name === 'oi33-native-editor-draft')) plugins.push(createEditorDraftBuildPlugin());
}
