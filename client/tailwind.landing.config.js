import app from './tailwind.config.js'

// The landing page's own Tailwind build (pages/landing.css): the same settings
// as the app-wide one, scanning only the landing page. See tailwind.config.js.
export default { ...app, content: ['./src/pages/Landing.tsx'] }
