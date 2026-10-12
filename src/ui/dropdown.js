// A small accessible dropdown (button + listbox) to replace native <select>s.
// options: [{ value, label, hint?, count?, swatch?, disabled? }]

const CHEVRON = '<svg class="dd-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
const CHECK = '<svg class="dd-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';
const SWATCH_COLORS = { google: '#3b6fe0', fontshare: '#e0a019', fontsquirrel: '#2e9a4b', fontsource: '#7b4ce0' };

let uid = 0;

export function createDropdown(root, { label, options = [], value, onChange }) {
  const id = `dd-${++uid}`;
  root.innerHTML = `
    <button class="dd-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${id}">
      <span class="dd-label"></span><span class="dd-value"></span><span class="dd-count" hidden></span>${CHEVRON}
    </button>
    <ul class="dd-menu" id="${id}" role="listbox" tabindex="-1"></ul>`;
  const trigger = root.querySelector('.dd-trigger');
  const menu = root.querySelector('.dd-menu');
  root.querySelector('.dd-label').textContent = label;
  menu.setAttribute('aria-label', label);

  let opts = options;
  let current = value;
  let active = -1;

  const items = () => Array.from(menu.children);
  const enabled = (i) => opts[i] && !opts[i].disabled;

  function renderTrigger() {
    const o = opts.find((x) => x.value === current) || opts[0];
    root.querySelector('.dd-value').textContent = o ? o.label : '';
    const count = root.querySelector('.dd-count');
    count.hidden = o?.count == null;
    if (o?.count != null) count.textContent = o.count;
  }

  function renderMenu() {
    menu.innerHTML = '';
    opts.forEach((o, i) => {
      const li = document.createElement('li');
      li.className = 'dd-option';
      li.id = `${id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(o.value === current));
      if (o.disabled) li.setAttribute('aria-disabled', 'true');
      li.innerHTML = `${CHECK}<span class="dd-text"></span><span class="dd-count"></span>`;
      const text = li.querySelector('.dd-text');
      if (o.swatch) {
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = SWATCH_COLORS[o.swatch] || 'currentColor';
        text.append(sw);
      }
      text.append(o.label);
      if (o.hint) {
        const small = document.createElement('small');
        small.textContent = o.hint;
        text.append(small);
      }
      const count = li.querySelector('.dd-count');
      if (o.count != null) count.textContent = o.count;
      else count.remove();
      li.addEventListener('pointermove', () => setActive(i));
      li.addEventListener('click', () => choose(i));
      menu.append(li);
    });
  }

  function setActive(i) {
    active = i;
    items().forEach((li, j) => li.classList.toggle('active', j === i));
    if (i >= 0) {
      menu.setAttribute('aria-activedescendant', `${id}-${i}`);
      items()[i]?.scrollIntoView({ block: 'nearest' });
    } else {
      menu.removeAttribute('aria-activedescendant');
    }
  }

  function isOpen() { return root.hasAttribute('data-open'); }

  function open() {
    if (isOpen()) return;
    renderMenu();
    root.setAttribute('data-open', '');
    trigger.setAttribute('aria-expanded', 'true');
    setActive(Math.max(0, opts.findIndex((o) => o.value === current)));
    menu.focus();
  }

  function close(refocus = true) {
    if (!isOpen()) return;
    root.removeAttribute('data-open');
    trigger.setAttribute('aria-expanded', 'false');
    setActive(-1);
    if (refocus) trigger.focus();
  }

  function choose(i) {
    if (!enabled(i)) return;
    const changed = opts[i].value !== current;
    current = opts[i].value;
    renderTrigger();
    close();
    if (changed) onChange?.(current);
  }

  function move(dir) {
    if (!opts.length) return;
    let i = active;
    for (let n = 0; n < opts.length; n++) {
      i = (i + dir + opts.length) % opts.length;
      if (enabled(i)) return setActive(i);
    }
  }

  trigger.addEventListener('click', () => (isOpen() ? close() : open()));
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
  });
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(-1); move(1); }
    else if (e.key === 'End') { e.preventDefault(); setActive(0); move(-1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  });
  document.addEventListener('pointerdown', (e) => { if (!root.contains(e.target)) close(false); });

  renderTrigger();

  return {
    setOptions(next) {
      opts = next;
      renderTrigger();
      if (isOpen()) { renderMenu(); setActive(active); }
    },
    setValue(v) {
      current = v;
      renderTrigger();
      if (isOpen()) renderMenu();
    },
  };
}
