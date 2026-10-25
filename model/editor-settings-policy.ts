/** Shared by the browser and server. Only editor appearance is synchronized. */
export interface EditorSettings {
    fontSize?: number;
    tabSize?: number;
    theme?: string;
}

export const EDITOR_BUILTIN_THEMES: Array<[string, string]> = [
    ['vs', 'VS'], ['vs-dark', 'VS Dark'], ['hc-black', 'High Contrast (Dark)'],
];
export const EDITOR_CUSTOM_THEMES: Record<string, string> = {
    active4d: 'Active4D',
    'all-hallows-eve': 'All Hallows Eve',
    amy: 'Amy',
    'birds-of-paradise': 'Birds of Paradise',
    blackboard: 'Blackboard',
    'brilliance-black': 'Brilliance Black',
    'brilliance-dull': 'Brilliance Dull',
    'chrome-devtools': 'Chrome DevTools',
    'clouds-midnight': 'Clouds Midnight',
    clouds: 'Clouds', cobalt: 'Cobalt', cobalt2: 'Cobalt2', dawn: 'Dawn',
    dracula: 'Dracula', dreamweaver: 'Dreamweaver', eiffel: 'Eiffel',
    'espresso-libre': 'Espresso Libre',
    'github-dark': 'GitHub Dark', 'github-light': 'GitHub Light', github: 'GitHub',
    idle: 'IDLE', katzenmilch: 'Katzenmilch', 'kuroir-theme': 'Kuroir Theme', lazy: 'LAZY',
    'magicwb--amiga-': 'MagicWB (Amiga)', 'merbivore-soft': 'Merbivore Soft', merbivore: 'Merbivore',
    'monokai-bright': 'Monokai Bright', monokai: 'Monokai', 'night-owl': 'Night Owl', nord: 'Nord',
    'oceanic-next': 'Oceanic Next', 'pastels-on-dark': 'Pastels on Dark',
    'slush-and-poppies': 'Slush and Poppies',
    'solarized-dark': 'Solarized-dark', 'solarized-light': 'Solarized-light',
    spacecadet: 'SpaceCadet', sunburst: 'Sunburst', 'textmate--mac-classic-': 'Textmate (Mac Classic)',
    'tomorrow-night-blue': 'Tomorrow-Night-Blue', 'tomorrow-night-bright': 'Tomorrow-Night-Bright',
    'tomorrow-night-eighties': 'Tomorrow-Night-Eighties', 'tomorrow-night': 'Tomorrow-Night',
    tomorrow: 'Tomorrow', twilight: 'Twilight', 'upstream-sunburst': 'Upstream Sunburst',
    'vibrant-ink': 'Vibrant Ink', 'xcode-default': 'Xcode_default', zenburnesque: 'Zenburnesque',
    iplastic: 'iPlastic', idlefingers: 'idleFingers', krtheme: 'krTheme', monoindustrial: 'monoindustrial',
};

export function isEditorTheme(value: unknown): value is string {
    return typeof value === 'string' && (EDITOR_BUILTIN_THEMES.some(([key]) => key === value)
        || Object.prototype.hasOwnProperty.call(EDITOR_CUSTOM_THEMES, value));
}

export function validateEditorSettingsPatch(value: unknown): EditorSettings {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new Error('编辑器设置格式不正确。');
    }
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !['fontSize', 'tabSize', 'theme'].includes(key))) {
        throw new Error('只能修改字号、Tab 宽度和编辑器主题。');
    }
    const result: EditorSettings = {};
    if (Object.prototype.hasOwnProperty.call(input, 'fontSize')) {
        if (!Number.isInteger(input.fontSize) || Number(input.fontSize) < 10 || Number(input.fontSize) > 40) {
            throw new Error('字号应为 10 至 40 的整数。');
        }
        result.fontSize = input.fontSize as number;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'tabSize')) {
        if (![2, 4, 8].includes(input.tabSize as number)) throw new Error('Tab 宽度应为 2、4 或 8 个空格。');
        result.tabSize = input.tabSize as number;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'theme')) {
        if (!isEditorTheme(input.theme)) throw new Error('请选择可用的编辑器主题。');
        result.theme = input.theme;
    }
    return result;
}

/** A malformed legacy value cannot inject options or prevent valid preferences loading. */
export function readEditorSettings(value: unknown): EditorSettings | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result: EditorSettings = {};
    for (const key of ['fontSize', 'tabSize', 'theme'] as const) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        try { Object.assign(result, validateEditorSettingsPatch({ [key]: (value as EditorSettings)[key] })); }
        catch { /* Ignore invalid stored fields, never arbitrary Monaco options. */ }
    }
    return Object.keys(result).length ? result : null;
}
