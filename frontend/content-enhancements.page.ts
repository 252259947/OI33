import { $, addPage, NamedPage } from '@hydrooj/ui-default';
import './content-enhancements.css';

function emphasizeFileIoTag() {
    document.querySelectorAll<HTMLElement>('.problem__tag-item.icon-book').forEach((tag) => {
        const text = (tag.textContent || '').trim();
        if (/^(文件\s*IO|File\s*IO)\s*[:：]/i.test(text)) tag.classList.add('oi33-file-io-tag');
    });
}

function headingId(index: number) {
    return `oi33-heading-${index + 1}`;
}

function headingText(heading: HTMLElement) {
    const copy = heading.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.katex-mathml').forEach((element) => element.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
}

const tocCleanups = new WeakMap<HTMLElement, () => void>();

function contentTocRoots(scope: ParentNode) {
    const roots = Array.from(scope.querySelectorAll<HTMLElement>('[data-content-toc]'));
    if (scope instanceof HTMLElement && scope.matches('[data-content-toc]')) roots.unshift(scope);
    return roots;
}

function unmountContentToc(scope: ParentNode) {
    contentTocRoots(scope).forEach((root) => {
        tocCleanups.get(root)?.();
        tocCleanups.delete(root);
        delete root.dataset.tocMounted;
    });
}

function mountContentToc(scope: ParentNode = document) {
    contentTocRoots(scope).forEach((root) => {
        if (root.dataset.tocMounted) return;
        const source = root.querySelector<HTMLElement>('[data-content-toc-source]');
        const layout = root.querySelector<HTMLElement>('[data-content-toc-layout]');
        const controls = root.querySelector<HTMLElement>('[data-content-toc-controls]');
        const toggle = root.querySelector<HTMLInputElement>('[data-content-toc-toggle]');
        const outputs = Array.from(root.querySelectorAll<HTMLElement>('[data-content-toc-aside]'))
            .map((aside) => ({ aside, list: aside.querySelector<HTMLElement>('[data-content-toc-list]') }))
            .filter((output): output is { aside: HTMLElement; list: HTMLElement } => !!output.list);
        const aside = outputs[0]?.aside;
        const sidebarMode = root.dataset.contentTocMode === 'sidebar';
        if (!source || !aside || !outputs.length || (!sidebarMode && (!layout || !controls || !toggle))) return;

        const headings = Array.from(source.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
            .filter((heading) => !!headingText(heading));
        if (!headings.length) return;
        root.dataset.tocMounted = '1';
        outputs.forEach((output) => output.list.replaceChildren());

        const usedIds = new Set<string>();
        document.querySelectorAll<HTMLElement>('[id]').forEach((element) => {
            if (!headings.includes(element)) usedIds.add(element.id);
        });
        const reservedHeadingIds = new Set(headings.map((heading) => heading.id).filter(Boolean));
        const minimumLevel = Math.min(...headings.map((heading) => Number(heading.tagName.slice(1))));
        const links = new Map<HTMLElement, HTMLAnchorElement[]>();
        const setActive = (activeHeading: HTMLElement) => {
            links.forEach((headingLinks, heading) => {
                const active = heading === activeHeading;
                headingLinks.forEach((link) => {
                    link.classList.toggle('is-active', active);
                    if (active) link.setAttribute('aria-current', 'location');
                    else link.removeAttribute('aria-current');
                });
            });
        };

        headings.forEach((heading, index) => {
            const text = headingText(heading);
            let id = heading.id || headingId(index);
            const base = id;
            let suffix = 2;
            while (usedIds.has(id) || (!heading.id && reservedHeadingIds.has(id))) id = `${base}-${suffix++}`;
            heading.id = id;
            usedIds.add(id);

            const headingLinks = outputs.map((output) => {
                const item = document.createElement('li');
                const link = document.createElement('a');
                link.className = 'oi33-content-toc__link';
                link.setAttribute('href', `#${id}`);
                link.textContent = text;
                link.style.setProperty('--oi33-toc-depth', String(Number(heading.tagName.slice(1)) - minimumLevel));
                link.addEventListener('click', (event: MouseEvent) => {
                    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    setActive(heading);
                    heading.scrollIntoView({
                        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
                        block: 'start',
                    });
                    if (window.location.hash !== link.hash) {
                        window.history.pushState(window.history.state, '', link.getAttribute('href'));
                    }
                });
                item.append(link);
                output.list.append(item);
                return link;
            });
            links.set(heading, headingLinks);
        });

        let observer: IntersectionObserver | undefined;
        let scrollFrame = 0;
        let hashFrame = 0;
        const updateActive = () => {
            const passedHeadings = headings
                .filter((heading) => heading.getBoundingClientRect().top <= 104);
            setActive(passedHeadings[passedHeadings.length - 1] || headings[0]);
        };
        const scheduleActiveUpdate = () => {
            if (scrollFrame) return;
            scrollFrame = window.requestAnimationFrame(() => {
                scrollFrame = 0;
                updateActive();
            });
        };
        const headingForHash = () => {
            const rawHash = window.location.hash.slice(1);
            if (!rawHash) return undefined;
            let decodedHash = rawHash;
            try { decodedHash = decodeURIComponent(rawHash); } catch { /* keep the raw fragment */ }
            return headings.find((heading) => heading.id === rawHash || heading.id === decodedHash);
        };
        const syncHash = () => {
            const heading = headingForHash();
            if (!heading) return;
            setActive(heading);
            if (hashFrame) window.cancelAnimationFrame(hashFrame);
            hashFrame = window.requestAnimationFrame(() => {
                hashFrame = 0;
                heading.scrollIntoView({ behavior: 'auto', block: 'start' });
            });
        };

        setActive(headings[0]);
        if ('IntersectionObserver' in window) {
            observer = new IntersectionObserver(() => {
                updateActive();
            }, { rootMargin: '-96px 0px -68% 0px', threshold: [0, 1] });
            headings.forEach((heading) => observer.observe(heading));
        } else {
            window.addEventListener('scroll', scheduleActiveUpdate, { passive: true });
        }
        window.addEventListener('resize', scheduleActiveUpdate, { passive: true });
        window.addEventListener('hashchange', syncHash);
        window.addEventListener('popstate', syncHash);

        if (sidebarMode) outputs.forEach((output) => { output.aside.hidden = false; });

        let updateToggle: (() => void) | undefined;
        if (!sidebarMode && layout && controls && toggle) {
            const storageKey = 'oi33.contentToc.visible';
            let visible = true;
            try {
                const saved = window.localStorage.getItem(storageKey);
                if (saved !== null) visible = saved === '1';
            } catch { /* localStorage may be unavailable */ }

            updateToggle = () => {
                layout.classList.toggle('is-toc-visible', toggle.checked);
                aside.hidden = !toggle.checked;
                try { window.localStorage.setItem(storageKey, toggle.checked ? '1' : '0'); } catch { /* ignore */ }
            };
            toggle.checked = visible;
            controls.hidden = false;
            toggle.addEventListener('change', updateToggle);
            updateToggle();
        }

        tocCleanups.set(root, () => {
            observer?.disconnect();
            if (!('IntersectionObserver' in window)) window.removeEventListener('scroll', scheduleActiveUpdate);
            window.removeEventListener('resize', scheduleActiveUpdate);
            window.removeEventListener('hashchange', syncHash);
            window.removeEventListener('popstate', syncHash);
            if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
            if (hashFrame) window.cancelAnimationFrame(hashFrame);
            if (toggle && updateToggle) toggle.removeEventListener('change', updateToggle);
        });

        updateActive();
        syncHash();
    });
}

let contentTocHooksInstalled = false;
function initContentToc() {
    mountContentToc();
    if (contentTocHooksInstalled) return;
    contentTocHooksInstalled = true;
    $(document).on('vjContentNew.oi33ContentToc', (event) => {
        mountContentToc(event.target as ParentNode);
    });
    $(document).on('vjContentRemove.oi33ContentToc', (event) => {
        unmountContentToc(event.target as ParentNode);
    });
}

function mountAiSummaryTag() {
    const parseGlobal = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v) || {};
    const user = parseGlobal((window as any).UserContext);
    if ((Number(user.realname_flag) || 0) < 2) return;
    const m = /\/p\/([\w-]+)(?:[/?#]|$)/.exec(window.location.pathname);
    if (!m) return;
    const menu = document.querySelector('.section--problem-sidebar ol.menu');
    if (!menu || menu.querySelector('.oi33-ai-summary-item')) return;
    const seperator = document.createElement('li');
    seperator.className = 'menu__seperator oi33-ai-summary-item';
    const li = document.createElement('li');
    li.className = 'menu__item oi33-ai-summary-item';
    const a = document.createElement('a');
    a.className = 'menu__link';
    a.href = `/oi33/ai/summary?pid=${m[1]}`;
    const icon = document.createElement('span');
    icon.className = 'icon icon-book';
    a.append(icon, ' AI 精简题意');
    li.appendChild(a);
    menu.append(seperator, li);
}

addPage(new NamedPage(['problem_detail', 'contest_detail_problem', 'homework_detail_problem'], emphasizeFileIoTag));
addPage(new NamedPage('problem_detail', mountAiSummaryTag));
addPage(initContentToc);
