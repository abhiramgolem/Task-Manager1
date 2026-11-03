import forms from '@tailwindcss/forms'
import containerQueries from '@tailwindcss/container-queries'

// The landing page (pages/Landing.tsx) is written in Tailwind utilities; the
// rest of the app is styles.css. This used to be compiled IN THE BROWSER by
// Tailwind's play CDN (cdn.tailwindcss.com, loaded from index.html): 419 KB of
// render-blocking script that watched the whole document and recompiled every
// stylesheet rule after each DOM change, on every screen of the app. Now it is
// compiled at build time, into two stylesheets that reproduce what the CDN
// generated (versions, settings and plugins are the CDN's; package.json pins
// them exactly):
//
//  - src/tailwind.css, app-wide, from THIS config. On app screens the CDN only
//    ever produced the forms plugin's base styles (every input, select and
//    checkbox in the app has been laid out with them), Tailwind's --tw-*
//    defaults, and the odd utility app markup happens to use (.grid, .sr-only).
//  - pages/landing.css, from tailwind.landing.config.js: the landing page's
//    hundreds of utilities, attached only while it is on screen. Shipped
//    app-wide they made every app screen slower to lay out — several selectors
//    (space-y-*, divide-*) are checked against every element on the page.
export default {
  // Every source file except the landing page's own (see above).
  content: ['./src/**/*.{ts,tsx}', '!./src/pages/Landing.tsx'],
  // preflight is OFF deliberately. It is a global CSS reset, and letting it run
  // would strip the margins and borders every OTHER screen relies on. The
  // landing page gets its own scoped copy of the few reset rules it actually
  // needs, under .lp-tw, in index.html.
  corePlugins: { preflight: false },
  // Class-based, not media-based: the landing page has to follow the app's own
  // Light/Dark/System choice, not the OS directly, or picking "Light" in the
  // app would leave this page dark anyway.
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
        handwriting: ['"Caveat"', 'cursive'],
      },
      colors: {
        brand: {
          50: '#fff7ed', 100: '#ffedd5', 200: '#fed7aa', 300: '#fdba74', 400: '#fb923c',
          500: '#f97316', 600: '#ea580c', 700: '#c2410c', 800: '#9a3412', 900: '#7c2d12',
        },
      },
      boxShadow: {
        subtle: '0 2px 10px rgba(0, 0, 0, 0.03)',
        card: '0 10px 30px -5px rgba(234, 88, 12, 0.05), 0 4px 18px rgba(0, 0, 0, 0.04)',
        float: '0 20px 40px -10px rgba(234, 88, 12, 0.12), 0 10px 20px -5px rgba(0,0,0,0.06)',
        app: '0 25px 60px -15px rgba(180, 83, 9, 0.15), 0 10px 25px -5px rgba(0, 0, 0, 0.05)',
      },
    },
  },
  plugins: [forms, containerQueries],
}
