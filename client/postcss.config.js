// Tailwind, then autoprefixer with remove:false — the same two passes, in the
// same order, as the play CDN ran (see tailwind.config.js). styles.css opts out
// of autoprefixer with a control comment, so the hand-written CSS ships as
// written; tailwindcss itself only acts on its own directives.
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: { remove: false },
  },
}
