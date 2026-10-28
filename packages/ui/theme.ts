/**
 * Yumi — Design Tokens (theme.ts)
 * Typed mirror of theme.css. Source of truth: design.md v1.0.
 * Use these constants in JS/TS (charts, canvas rendering, computed styles).
 * For CSS, prefer the custom properties in theme.css — do not hardcode.
 */

export const collaboratorPalette = [
  { name: 'Gold',    color: '#C79A1E', label: '#1A1712' },
  { name: 'Green',   color: '#3C8C43', label: '#FFFFFF' },
  { name: 'Teal',    color: '#0E8F82', label: '#FFFFFF' },
  { name: 'Sky',     color: '#2E86C1', label: '#FFFFFF' },
  { name: 'Cobalt',  color: '#2F5FE0', label: '#FFFFFF' },
  { name: 'Violet',  color: '#7A4FE0', label: '#FFFFFF' },
  { name: 'Berry',   color: '#9B3FA8', label: '#FFFFFF' },
  { name: 'Magenta', color: '#C6317E', label: '#FFFFFF' },
] as const;

/** Stable per-user color assignment (mirror server-side `users.avatarColor`). */
export function collaboratorColor(index: number) {
  return collaboratorPalette[index % collaboratorPalette.length];
}

export const light = {
  bg: '#F4F1EA', bgRaised: '#FBFAF7', bgSunken: '#ECE7DC', bgInverse: '#1A1712',
  ink: '#1A1A1A', inkSecondary: '#55514A', inkMuted: '#8A857B',
  border: '#DED8CB', borderStrong: '#C7BFAE',
  accent: '#C4622D', accentStrong: '#B5482E', accentSoft: '#F0DFD2', accentContrast: '#FFFFFF',
  success: '#2E8B4F', warning: '#D9902B', error: '#C4362E', info: '#2B6CB0',
} as const;

export const dark = {
  bg: '#17150F', bgRaised: '#221F18', bgSunken: '#100E0A', bgInverse: '#F4F1EA',
  ink: '#F4F1EA', inkSecondary: '#B8B2A5', inkMuted: '#857F72',
  border: '#322E25', borderStrong: '#4A4437',
  accent: '#E0784A', accentStrong: '#EC8A5C', accentSoft: '#3A2A1E', accentContrast: '#17150F',
  success: '#4FBE77', warning: '#E8A94F', error: '#E85C52', info: '#5A9BE0',
} as const;

export const fonts = {
  display: '"Space Grotesk", "Archivo", "Helvetica Neue", Arial, sans-serif',
  ui: '"Space Grotesk", "Inter", system-ui, sans-serif',
  mono: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
} as const;

/** size in px / lineHeight / weight — see design.md §3.2 */
export const typeScale = {
  displayXl: { size: 72, lineHeight: 1.0,  weight: 800 },
  displayL:  { size: 56, lineHeight: 1.05, weight: 800 },
  h1:        { size: 40, lineHeight: 1.1,  weight: 700 },
  h2:        { size: 30, lineHeight: 1.15, weight: 700 },
  h3:        { size: 22, lineHeight: 1.25, weight: 600 },
  bodyLg:    { size: 18, lineHeight: 1.5,  weight: 400 },
  body:      { size: 15, lineHeight: 1.55, weight: 400 },
  small:     { size: 13, lineHeight: 1.45, weight: 400 },
  meta:      { size: 11, lineHeight: 1.4,  weight: 600, tracking: '0.08em', uppercase: true },
  code:      { size: 13.5, lineHeight: 1.6, weight: 400 },
} as const;

export const space = { 1:4, 2:8, 3:12, 4:16, 5:24, 6:32, 7:48, 8:64, 9:96, 10:128 } as const;
export const radius = { sm:4, md:8, lg:12, xl:20, pill:999 } as const;

export const elevation = {
  light: {
    e1: '0 1px 2px rgba(26,22,15,.06)',
    e2: '0 4px 12px rgba(26,22,15,.08)',
    e3: '0 12px 32px rgba(26,22,15,.14)',
  },
  dark: {
    e1: '0 1px 2px rgba(0,0,0,.30)',
    e2: '0 4px 12px rgba(0,0,0,.36)',
    e3: '0 12px 32px rgba(0,0,0,.44)',
  },
} as const;

export const motion = {
  durFast: 120, durBase: 200, durSlow: 320,
  ease: 'cubic-bezier(.2,.8,.2,1)',
  easeOut: 'cubic-bezier(0,0,.2,1)',
} as const;

export type ThemeName = 'light' | 'dark';
export const themes = { light, dark } as const;
