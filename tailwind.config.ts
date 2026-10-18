import type { Config } from 'tailwindcss';

/**
 * Megneto palette: light blue and white.
 *
 * Two families, and only two:
 *   frost  - the surfaces. White through to a pale blue-white wash.
 *   ink    - the type. Deep blue-slate, never pure black.
 *   signal - the semantic accents, retuned for contrast ON WHITE. The cyan,
 *            teal, amber and red here are all darker than their neon
 *            equivalents, because a 4.5:1 ratio against a white panel is what
 *            makes a dashboard readable from the back of a room.
 */
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        frost: {
          50: '#ffffff',
          100: '#f7fbff',
          200: '#eef6fd',
          300: '#e1f0fb',
          400: '#cfe6f7',
          500: '#b4d8f1',
          600: '#8ec3e6',
        },
        ink: {
          900: '#0d2b3f',
          800: '#143c56',
          700: '#1f5270',
          600: '#336d8d',
          500: '#5b8aa6',
          400: '#86a8bd',
          300: '#a9c3d4',
        },
        signal: {
          cyan: '#1a8fd1',
          teal: '#0c9183',
          amber: '#c57600',
          red: '#d13a57',
          violet: '#5b55c9',
        },
      },
      boxShadow: {
        hud: '0 0 0 1px rgba(26,143,209,0.14), 0 14px 34px -16px rgba(13,43,63,0.34)',
        glow: '0 0 22px -6px rgba(26,143,209,0.55)',
        'glow-amber': '0 0 22px -6px rgba(197,118,0,0.5)',
        'glow-red': '0 0 22px -6px rgba(209,58,87,0.5)',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { transform: 'scale(0.8)', opacity: '0.75' },
          '100%': { transform: 'scale(2.4)', opacity: '0' },
        },
        sweep: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(400%)' },
        },
        flicker: {
          '0%,100%': { opacity: '1' },
          '45%': { opacity: '0.68' },
          '50%': { opacity: '1' },
        },
        'slide-up': {
          from: { transform: 'translateY(8px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 2.4s cubic-bezier(0.22,1,0.36,1) infinite',
        sweep: 'sweep 3.6s linear infinite',
        flicker: 'flicker 6s ease-in-out infinite',
        'slide-up': 'slide-up 240ms cubic-bezier(0.22,1,0.36,1) both',
      },
    },
  },
  plugins: [],
};

export default config;
