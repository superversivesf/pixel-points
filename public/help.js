/* Shared chrome for the static help page: theme from localStorage, same rule as the app. */
const THEMES = ['crt-dark', 'crt-light', 'pixel-dark', 'pixel-light', 'mono-dark', 'mono-light'];

const stored = localStorage.getItem('pp-theme');
const theme = THEMES.includes(stored)
  ? stored
  : (matchMedia('(prefers-color-scheme: light)').matches ? 'crt-light' : 'crt-dark');
document.documentElement.dataset.theme = theme;