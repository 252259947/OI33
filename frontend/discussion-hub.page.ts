import { addPage, NamedPage } from '@hydrooj/ui-default';
import './discussion-hub.css';

async function copyArticleLink(value: string) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.readOnly = true;
    textarea.setAttribute('aria-hidden', 'true');
    Object.assign(textarea.style, {
        position: 'fixed',
        inset: '0 auto auto -9999px',
        opacity: '0',
    });
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('copy command was rejected');
}

function mountArticleCopyLinks() {
    document.querySelectorAll<HTMLButtonElement>('[data-article-copy-link]').forEach((button) => {
        if (button.dataset.copyMounted) return;
        button.dataset.copyMounted = '1';
        const originalLabel = button.textContent?.trim() || '复制专属链接';
        let resetTimer: number | undefined;

        button.addEventListener('click', async () => {
            const value = button.dataset.articleCopyLink;
            if (!value) return;
            const absoluteUrl = new URL(value, window.location.origin).toString();
            button.disabled = true;
            if (resetTimer) window.clearTimeout(resetTimer);
            try {
                await copyArticleLink(absoluteUrl);
                button.textContent = '✓ 已复制';
                button.classList.add('is-copied');
            } catch {
                button.textContent = '复制失败，请手动复制';
                window.prompt('复制下面的专属链接：', absoluteUrl);
            } finally {
                button.disabled = false;
                resetTimer = window.setTimeout(() => {
                    button.textContent = originalLabel;
                    button.classList.remove('is-copied');
                }, 2200);
            }
        });
    });
}

addPage(new NamedPage(['discussion_detail', 'oi33_article_detail'], mountArticleCopyLinks));
