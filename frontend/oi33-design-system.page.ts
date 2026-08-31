import { addPage, addSpeculationRules } from '@hydrooj/ui-default';
import './oi33-design-system.css';

const revealUi = (window as Window & { __oi33RevealUI?: () => void }).__oi33RevealUI;
if (revealUi) requestAnimationFrame(() => requestAnimationFrame(revealUi));

addPage(() => {
  addSpeculationRules({
    prefetch: [{
      source: 'document',
      where: { selector_matches: 'a[data-oi33-prefetch]' },
      eagerness: 'moderate',
    }],
  });
  const search = document.querySelector<HTMLInputElement>('[data-oi33-global-search]');
  const hamburger = document.querySelector<HTMLButtonElement>('.header__hamburger');
  hamburger?.addEventListener('click', () => {
    hamburger.setAttribute('aria-expanded', hamburger.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
    if (!search || search.offsetParent === null) return;
    event.preventDefault();
    search.focus();
    search.select();
  });
});
