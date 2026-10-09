const STORAGE_KEY = 'meme-deck-theme-v2';
const LEGACY_STORAGE_KEY = 'meme-deck-theme-v1';
export const THEMES = Object.freeze([
  { id: 'original', era: 'Original', title: 'Pocket classic', description: 'Molded plastic, tactile pads, and a recessed display.', base: '#f36f39' },
  { id: '1960', era: '60s', title: 'Transistor', description: 'Walnut, bakelite, woven grille, and ivory keys.', base: '#a76b3f' },
  { id: '1970', era: '70s', title: 'Hi-Fi', description: 'Warm cabinetry, brushed metal, and chunky buttons.', base: '#c58227' },
  { id: '1980', era: '80s', title: 'Tape deck', description: 'Dark molded plastic, luminous controls, and cassette-era detail.', base: '#ec3f89' },
  { id: '1990', era: '90s', title: 'Pocket console', description: 'Warm gray plastic, colored rubber, and a small LCD.', base: '#7660c9' },
  { id: '2000', era: '00s', title: 'Aqua', description: 'Silver, translucent plastic, and polished glass buttons.', base: '#2aaad0' },
  { id: '2010', era: '10s', title: 'Beat machine', description: 'Matte charcoal, soft rubber, and precise studio controls.', base: '#ec6b53' },
  { id: '2020', era: '20s', title: 'Porcelain', description: 'Soft porcelain, gentle contours, and satin controls.', base: '#b6a3d3' },
  { id: '2090', era: '2090', title: 'Orbital', description: 'Black technical glass, illuminated edges, and orbital instrumentation.', base: '#00dfd8' }
].map(theme => Object.freeze(theme)));
const THEME_BY_ID = new Map(THEMES.map(theme => [theme.id, theme]));
const validColor = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function rgb(hex) {
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
}
function mix(first, second, amount) {
  const target = rgb(second);
  return '#' + rgb(first).map((value, index) => Math.round(value + (target[index] - value) * amount).toString(16).padStart(2, '0')).join('');
}
function luminance(hex) {
  const linear = rgb(hex).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function foreground(background) {
  return contrast(background, '#000000') >= contrast(background, '#ffffff') ? '#000000' : '#ffffff';
}
function readableShade(base, target, amount, ink) {
  const proposed = mix(base, target, amount);
  if (contrast(proposed, ink) >= 4.52) return proposed;
  // Preserve the seed and reduce only the gradient's excursion. Both endpoints
  // remain readable even for middle grays and highly saturated custom colors.
  let low = 0, high = amount, best = base;
  for (let step = 0; step < 20; step++) {
    const current = (low + high) / 2;
    const candidate = mix(base, target, current);
    if (contrast(candidate, ink) >= 4.52) { best = candidate; low = current; }
    else high = current;
  }
  return best;
}
function surface(base, light = 0.16, dark = 0.2) {
  const ink = foreground(base);
  return { base, ink, light: readableShade(base, '#ffffff', light, ink), dark: readableShade(base, '#000000', dark, ink), edge: mix(base, '#000000', 0.42) };
}
function mutedForeground(surface) {
  const backgrounds = [surface.base, surface.light, surface.dark];
  let low = 0, high = 0.45, best = surface.ink;
  for (let step = 0; step < 18; step++) {
    const amount = (low + high) / 2;
    const candidate = mix(surface.ink, surface.base, amount);
    if (backgrounds.every(background => contrast(candidate, background) >= 4.52)) { best = candidate; low = amount; }
    else high = amount;
  }
  return best;
}

/** Pure, deterministic palette generation. Base must be an explicit #RRGGBB. */
export function createPalette(era, base) {
  if (!THEME_BY_ID.has(era)) throw new RangeError('Unknown theme era: ' + String(era));
  if (!validColor(base)) throw new TypeError('Theme color must be a six-digit hex color.');
  const seed = base.toLowerCase();
  // The fixed colors describe each era's materials; every surface is tinted by
  // the selected seed. The accent always preserves the exact selected color.
  const tint = (material, weight) => mix(seed, material, weight);
  let shell, pad, alternate, alternate2, panel, display, metal, polish = 0.12;
  switch (era) {
    case '1960':
      shell = tint('#2d1a12', 0.42); pad = tint('#fff4d5', 0.8);
      alternate = tint('#e6d5ad', 0.83); alternate2 = tint('#8d6f47', 0.55);
      panel = tint('#241910', 0.7); display = tint('#111b12', 0.88); metal = tint('#bfa778', 0.78); polish = 0.1;
      break;
    case '1970':
      shell = tint('#bba47b', 0.42); pad = tint('#382f15', 0.2);
      alternate = tint('#c5bd82', 0.52); alternate2 = tint('#675231', 0.37);
      panel = tint('#d0c8b5', 0.82); display = tint('#142119', 0.86); metal = tint('#d7d0bd', 0.84); polish = 0.16;
      break;
    case '1980':
      shell = tint('#171721', 0.93); pad = tint('#262037', 0.42);
      alternate = tint('#4c3675', 0.45); alternate2 = tint('#777281', 0.3);
      panel = tint('#17131e', 0.85); display = tint('#040911', 0.97); metal = tint('#48464f', 0.88); polish = 0.13;
      break;
    case '1990':
      shell = tint('#ece0c7', 0.89); pad = tint('#4f4c62', 0.25);
      alternate = tint('#dad3be', 0.55); alternate2 = tint('#657d81', 0.45);
      panel = tint('#c4bdab', 0.85); display = tint('#d0d8b5', 0.9); metal = tint('#a6a6a0', 0.92); polish = 0.08;
      break;
    case '2000':
      shell = tint('#eef3f4', 0.89); pad = tint('#ffffff', 0.56);
      alternate = tint('#dee5e8', 0.66); alternate2 = tint('#406b75', 0.24);
      panel = tint('#b3c1c9', 0.78); display = tint('#e8ffff', 0.7); metal = tint('#e1e8ec', 0.88); polish = 0.24;
      break;
    case '2010':
      shell = tint('#27292d', 0.96); pad = tint('#3a3e44', 0.86);
      alternate = tint('#777b7e', 0.72); alternate2 = tint('#202b30', 0.55);
      panel = tint('#34383c', 0.92); display = tint('#0a171c', 0.97); metal = tint('#565b61', 0.94); polish = 0.05;
      break;
    case '2020':
      shell = tint('#fffdfa', 0.94); pad = tint('#ffffff', 0.35);
      alternate = tint('#f3f5e6', 0.68); alternate2 = tint('#e3dedc', 0.4);
      panel = tint('#f3f1ed', 0.91); display = tint('#eef3e7', 0.79); metal = tint('#dededa', 0.9); polish = 0.08;
      break;
    case '2090':
      shell = tint('#060b16', 0.97); pad = tint('#0a1a29', 0.82);
      alternate = tint('#061721', 0.68); alternate2 = tint('#2b3248', 0.87);
      panel = tint('#111822', 0.94); display = tint('#000509', 0.98); metal = tint('#53606a', 0.88); polish = 0.14;
      break;
    default:
      shell = tint('#ebe7d8', 0.95); pad = tint('#b9c1a8', 0.83);
      alternate = tint('#efe8bc', 0.83); alternate2 = tint('#c9cfc4', 0.9);
      panel = tint('#afb6a1', 0.9); display = tint('#18392d', 0.92); metal = tint('#c1c8b7', 0.9);
  }
  const caseSurface = surface(shell, era === '2000' ? 0.22 : 0.12, era === '2020' ? 0.08 : 0.17);
  const padSurface = surface(pad, era === '2000' ? 0.29 : 0.18, 0.22);
  const alternateSurface = surface(alternate, 0.18, 0.22);
  const alternate2Surface = surface(alternate2, 0.18, 0.22);
  const accentSurface = surface(seed, 0.22, 0.22);
  const metalSurface = surface(metal, 0.26, 0.25);
  const palette = {};
  for (const [prefix, value] of [['case', caseSurface], ['pad', padSurface], ['pad-alt', alternateSurface], ['pad-alt2', alternate2Surface], ['accent', accentSurface], ['metal', metalSurface]]) {
    palette['--' + prefix] = value.base;
    palette['--' + prefix + '-light'] = value.light;
    palette['--' + prefix + '-dark'] = value.dark;
    palette['--' + prefix + '-ink'] = value.ink;
    palette['--' + prefix + '-edge'] = value.edge;
  }
  return {
    ...palette,
    '--muted-ink': mutedForeground(caseSurface),
    '--panel': panel, '--panel-ink': foreground(panel),
    '--display': display, '--display-ink': foreground(display),
    '--display-glow': mix(display, seed, 0.65),
    '--line': mix(shell, caseSurface.ink, 0.35),
    '--surface-gloss': `rgba(255, 255, 255, ${polish})`
  };
}

function readStored(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function readState() {
  const state = { version: 2, era: 'original', bases: Object.create(null) };
  const saved = readStored(STORAGE_KEY);
  if (isRecord(saved) && saved.version === 2) {
    if (THEME_BY_ID.has(saved.era)) state.era = saved.era;
    if (isRecord(saved.bases)) for (const theme of THEMES) {
      if (validColor(saved.bases[theme.id])) state.bases[theme.id] = saved.bases[theme.id].toLowerCase();
    }
    return state;
  }
  const legacy = readStored(LEGACY_STORAGE_KEY);
  if (isRecord(legacy)) {
    if (THEME_BY_ID.has(legacy.era)) state.era = legacy.era;
    if (isRecord(legacy.custom)) for (const theme of THEMES) {
      const colors = legacy.custom[theme.id];
      if (!isRecord(colors)) continue;
      const base = [colors.accent, colors.pads, colors.shell].find(validColor);
      if (base) state.bases[theme.id] = base.toLowerCase();
    }
  }
  return state;
}

let initialized = false;
export function initThemes() {
  if (initialized) return;
  const dialog = document.querySelector('#theme-dialog');
  const options = document.querySelector('#theme-options');
  const input = document.querySelector('#theme-color');
  if (!dialog || !options || !input) return;
  initialized = true;
  const state = readState();
  const root = document.documentElement;
  const cards = new Map();
  const baseFor = id => state.bases[id] || THEME_BY_ID.get(id).base;
  const persist = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* Live theming works when storage is unavailable. */ }
  };
  function updatePreview(id) {
    const preview = cards.get(id).preview;
    for (const [name, value] of Object.entries(createPalette(id, baseFor(id)))) preview.style.setProperty(name, value);
  }
  function apply() {
    const theme = THEME_BY_ID.get(state.era), base = baseFor(state.era);
    const palette = createPalette(state.era, base);
    root.dataset.era = state.era;
    for (const [name, value] of Object.entries(palette)) root.style.setProperty(name, value);
    for (const [id, card] of cards) {
      const selected = id === state.era;
      card.button.setAttribute('aria-pressed', String(selected));
      card.button.classList.toggle('selected', selected);
    }
    const name = document.querySelector('#theme-name'), description = document.querySelector('#theme-description');
    if (name) name.textContent = `${theme.era} · ${theme.title}`;
    if (description) description.textContent = theme.description;
    input.value = base;
    const output = document.querySelector('#color-base');
    if (output) output.textContent = base.toUpperCase();
    const swatches = document.querySelector('#generated-palette');
    if (swatches) {
      const fragment = document.createDocumentFragment();
      for (const [label, key] of [['Case', '--case'], ['Pads', '--pad'], ['Accent', '--accent'], ['Display', '--display'], ['Metal', '--metal']]) {
        const swatch = document.createElement('span');
        swatch.className = 'generated-swatch';
        swatch.style.backgroundColor = palette[key];
        swatch.title = `${label}: ${palette[key].toUpperCase()}`;
        swatch.setAttribute('role', 'img');
        swatch.setAttribute('aria-label', swatch.title);
        fragment.append(swatch);
      }
      swatches.replaceChildren(fragment);
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette['--case']);
    updatePreview(state.era);
    document.dispatchEvent(new CustomEvent('themechange', { bubbles: true, detail: { era: state.era, base, palette: { ...palette } } }));
  }
  const fragment = document.createDocumentFragment();
  for (const theme of THEMES) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'theme-card'; button.dataset.era = theme.id;
    button.setAttribute('aria-label', `Use ${theme.era}: ${theme.title}. ${theme.description}`);
    const preview = document.createElement('span'); preview.className = 'theme-preview'; preview.setAttribute('aria-hidden', 'true');
    const grille = document.createElement('span'); grille.className = 'preview-grille';
    const display = document.createElement('span'); display.className = 'preview-display';
    const pads = document.createElement('span'); pads.className = 'preview-pads';
    pads.append(...Array.from({ length: 8 }, () => document.createElement('i')));
    preview.append(grille, display, pads);
    const era = document.createElement('span'); era.className = 'theme-era'; era.textContent = theme.era;
    const title = document.createElement('span'); title.className = 'theme-title'; title.textContent = theme.title;
    button.append(preview, era, title);
    button.addEventListener('click', () => { state.era = theme.id; persist(); apply(); });
    cards.set(theme.id, { button, preview }); updatePreview(theme.id); fragment.append(button);
  }
  options.replaceChildren(fragment);
  const updateColor = () => {
    if (!validColor(input.value)) return;
    const base = input.value.toLowerCase();
    if (baseFor(state.era) === base) return;
    state.bases[state.era] = base; persist(); apply();
  };
  input.addEventListener('input', updateColor);
  input.addEventListener('change', updateColor);
  document.querySelector('#theme-reset')?.addEventListener('click', () => { delete state.bases[state.era]; persist(); apply(); });
  document.querySelector('#theme-button')?.addEventListener('click', () => { if (!dialog.open) dialog.showModal(); });
  document.querySelector('#theme-close')?.addEventListener('click', () => { if (dialog.open) dialog.close(); });
  persist();
  apply();
}
