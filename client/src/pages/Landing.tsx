// The landing page: the supplied mock, rebuilt as JSX inside the real app. It is
// styled with Tailwind utility classes, which the rest of this codebase does not
// use (it has one hand-written styles.css). Those utilities are compiled at
// build time into landing.css and attached only while this page is mounted;
// its scoped reset lives in index.html. See tailwind.config.js for why it is
// not a global stylesheet — and never the play CDN again.
//
// Two deliberate departures from the mock:
//   * the logo is the real /logo.png, not the mock's generic diamond mark
//   * the calls to action route to the app's real /signup and /login, so the
//     page can be walked through rather than only looked at
import React, { useEffect, useLayoutEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import landingCss from './landing.css?inline'
import { THEME_OPTIONS, ThemeChoice, getThemeChoice, applyTheme, resolveTheme, repaintTheme } from '../lib/theme'
import { COPY, LANDING_LANGS, LandingLang, getLandingLang, setLandingLang } from '../lib/landingCopy'

const Wave = ({ className, delay }: { className: string; delay?: string }) => (
  <span className={`wave-bar ${className}`} style={delay ? { animationDelay: delay } : undefined} />
)

const THEME_ICONS: Record<ThemeChoice, React.ReactNode> = {
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  dark: <path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />,
  system: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
}

// Theme switch — three states, one sliding pill.
//
// It drives the app's own lib/theme.ts rather than keeping a second copy of the
// setting, so choosing Dark here is the same choice as choosing Dark in the
// profile panel, and it survives a reload.
//
// Tailwind's dark variants key off a `dark` class, while the app keys off
// `data-theme` on <html>. Rather than change the app's contract for a preview,
// the class is mirrored from the resolved theme here.
function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice())

  useEffect(() => {
    const sync = () => {
      // Repaint first: arriving here through a client-side navigation (a logout,
      // or a link back to "/") never re-runs initTheme, so data-theme can still
      // be carrying whatever the previous route resolved to. Only then mirror the
      // result onto Tailwind's `dark` class.
      repaintTheme()
      document.documentElement.classList.toggle('dark', resolveTheme() === 'dark')
    }
    sync()
    // 'system' is a standing instruction, not a snapshot: if the OS flips while
    // the page is open, the page has to follow it without a reload.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [choice])

  const index = THEME_OPTIONS.findIndex((t) => t.id === choice)
  const current = THEME_OPTIONS[index] ?? THEME_OPTIONS[0]
  // Light → Dark → System → Light, the order THEME_OPTIONS already declares, so
  // the cycle and the settings panel can never disagree about what comes next.
  const next = THEME_OPTIONS[(index + 1) % THEME_OPTIONS.length]

  return (
    /* One button that cycles, not three sitting side by side. The segmented pill
       cost three tap targets' worth of width in a header that also carries a
       language picker, Sign in and Get Started — on a phone that pushed the
       wordmark and the CTA off their own edges. Cycling spends a tap to reach the
       third state and buys back two thirds of the width, which is the right trade
       for a control most people touch once.

       The icon shown is the CURRENT theme, and the title says what the next tap
       does — otherwise a cycling control leaves you guessing which way it turns. */
    <button
      type="button"
      aria-label={`Theme: ${current.label}. Switch to ${next.label}`}
      title={`${current.label} — ${current.hint}. Tap for ${next.label}.`}
      onClick={() => { applyTheme(next.id); setChoice(next.id) }}
      className="relative w-9 h-9 rounded-full flex items-center justify-center bg-slate-100 dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 transition-colors duration-200"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
        {THEME_ICONS[current.id]}
      </svg>
      <span className="sr-only">{current.label}</span>
    </button>
  )
}

// Language picker. Three languages, because that is the set the product supports
// everywhere else — the extractor is capped to en/hi/te, so offering more here
// would promise something the app cannot do.
//
// A plain <details> rather than a hand-built dropdown: it opens on click, closes
// on Escape and on a click outside, and is keyboard reachable, all from the
// browser. None of that is worth reimplementing for one control.
function LanguagePicker({ lang, onPick }: { lang: LandingLang; onPick: (l: LandingLang) => void }) {
  const current = LANDING_LANGS.find((l) => l.id === lang) || LANDING_LANGS[0]
  return (
    <details className="relative hidden sm:block group">
      <summary className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-brand-600 px-2.5 py-1.5 rounded-lg border border-slate-200/80 dark:border-slate-700 bg-white/70 dark:bg-slate-800/70 shadow-sm cursor-pointer list-none marker:content-['']">
        <svg className="w-4 h-4 text-slate-500 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        </svg>
        <span>{current.short}</span>
        <svg className="w-3 h-3 transition-transform duration-200 group-open:rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
        </svg>
      </summary>
      <div className="absolute right-0 mt-2 w-40 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-float overflow-hidden z-50">
        {LANDING_LANGS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={(e) => { onPick(l.id); (e.currentTarget.closest('details') as HTMLDetailsElement).open = false }}
            className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors ${
              l.id === lang
                ? 'bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 font-semibold'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
          >
            <span>{l.label}</span>
            {l.id === lang && (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
            )}
          </button>
        ))}
      </div>
    </details>
  )
}

export default function Landing() {
  // This page's Tailwind, present only while the page is. A layout effect, so
  // it is in place before the first paint. Appended to the end of <head> —
  // after the app's stylesheet, where the play CDN put its output — so rules
  // that tie on specificity resolve the way the page was designed against.
  useLayoutEffect(() => {
    const style = document.createElement('style')
    style.textContent = landingCss
    document.head.append(style)
    return () => style.remove()
  }, [])
  const [lang, setLang] = useState<LandingLang>(getLandingLang())
  const t = COPY[lang]
  const pickLang = (l: LandingLang) => { setLandingLang(l); setLang(l) }
  return (
    <div className="lp-tw bg-[#FCFAF7] dark:bg-[#0f1216] text-slate-800 dark:text-slate-200 antialiased overflow-x-hidden font-sans selection:bg-brand-100 selection:text-brand-700">
      {/* ---------------------------------------------------------------- nav */}
      <header className="sticky top-0 z-50 bg-[#FCFAF7]/90 dark:bg-[#0f1216]/90 backdrop-blur-md border-b border-orange-100/60 dark:border-orange-900/60">
        {/* Phone first: a shorter bar, tighter gutters, and a gap that only opens
            up once there is room for it. At 20px between four controls the
            wordmark and the Get Started pill were both being pushed past their
            own edges. min-w-0 lets the left half shrink instead of forcing the
            row wider than the screen — without it a flex child refuses to go
            below its content width, which is what actually caused the overflow. */}
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 h-16 sm:h-20 flex items-center justify-between gap-2">
          <div className="flex items-center space-x-10 min-w-0">
            <a className="flex items-center gap-2.5 group text-slate-900 dark:text-slate-100" href="#top">
              {/* The real mark, kept as-is. */}
              <img src="/logo.png" alt="" className="w-9 h-9 rounded-xl object-contain bg-white dark:bg-slate-900 shadow-md shadow-brand-500/20 group-hover:scale-105 transition-transform duration-200" />
              <span className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">VoTask</span>
            </a>
            <nav className="hidden md:flex items-center space-x-8 text-sm font-semibold text-slate-600 dark:text-slate-400">
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition-colors" href="#features">{t.navProduct}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition-colors" href="#how-it-works">{t.navSolutions}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition-colors" href="#pricing">{t.navPricing}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition-colors" href="#resources">{t.navResources}</a>
            </nav>
          </div>
          <div className="flex items-center gap-2 sm:gap-5 shrink-0">
            <LanguagePicker lang={lang} onPick={pickLang} />
            <ThemeSwitch />
            {/* "Log in" is the one thing here with a home elsewhere — the hero
                leads with its own Log in button, on the first screen of a phone.
                So it steps aside on a phone rather than squeezing the two
                controls that have nowhere else to appear. */}
            <Link className="hidden sm:inline text-sm font-semibold text-slate-700 dark:text-slate-300 hover:text-brand-600 px-2 py-1" to="/login">{t.signIn}</Link>
            <Link className="inline-flex items-center justify-center gap-2 whitespace-nowrap bg-gradient-to-r from-brand-600 to-amber-600 hover:from-brand-700 hover:to-amber-700 text-white font-medium text-sm px-4 sm:px-5 py-2 sm:py-2.5 rounded-full shadow-md shadow-brand-600/20 hover:shadow-lg hover:shadow-brand-600/30 transition duration-150" to="/signup">
              <span>{t.getStarted}</span>
              {/* The arrow is decoration, and on a phone it is decoration that costs
                  the label its last characters. */}
              <svg className="hidden sm:block w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
            </Link>
          </div>
        </div>
      </header>

      {/* -------------------------------------------------------------- hero */}
      <section className="relative pt-8 pb-16 md:pt-14 md:pb-24 overflow-hidden">
        <div className="absolute inset-0 pointer-events-none overflow-hidden -z-10">
          <svg className="absolute top-1/4 -left-20 w-[600px] h-[600px] opacity-25 text-amber-500/30" fill="none" viewBox="0 0 400 400">
            <circle cx="200" cy="200" r="40" stroke="currentColor" strokeDasharray="2 4" strokeWidth="1.5" />
            <circle cx="200" cy="200" r="80" stroke="currentColor" strokeDasharray="4 6" strokeWidth="1.5" />
            <circle cx="200" cy="200" r="120" stroke="currentColor" strokeWidth="1.2" className="opacity-70" />
            <circle cx="200" cy="200" r="160" stroke="currentColor" strokeDasharray="6 8" strokeWidth="1" className="opacity-50" />
            <circle cx="200" cy="200" r="195" stroke="currentColor" strokeWidth="0.8" className="opacity-30" />
          </svg>
          <svg className="absolute -top-10 right-0 w-[850px] h-[550px] opacity-25" fill="none" preserveAspectRatio="none" viewBox="0 0 800 500">
            <path d="M 0,220 C 150,140 280,320 420,200 C 560,90 680,260 800,180" stroke="url(#lp-wave-1)" strokeWidth="2.5" />
            <path d="M 0,260 C 160,180 290,360 450,230 C 590,120 690,290 800,220" stroke="url(#lp-wave-2)" strokeWidth="1.8" strokeDasharray="3 5" />
            <path d="M 0,300 C 140,240 310,390 480,270 C 620,160 710,310 800,260" stroke="url(#lp-wave-1)" strokeWidth="1.2" />
            <path d="M 0,340 C 180,290 340,420 520,300 C 660,190 730,340 800,290" stroke="url(#lp-wave-2)" strokeWidth="0.8" strokeDasharray="4 6" />
            <defs>
              <linearGradient id="lp-wave-1" x1="0%" x2="100%" y1="0%" y2="0%">
                <stop offset="0%" stopColor="#f97316" stopOpacity="0.1" />
                <stop offset="50%" stopColor="#f59e0b" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#ea580c" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="lp-wave-2" x1="0%" x2="100%" y1="0%" y2="0%">
                <stop offset="0%" stopColor="#ea580c" stopOpacity="0.05" />
                <stop offset="50%" stopColor="#fb923c" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.1" />
              </linearGradient>
            </defs>
          </svg>
          <div className="hidden md:flex absolute top-12 right-1/3 items-end gap-1.5 h-16 opacity-20">
            <span className="w-1 bg-amber-500 rounded-full h-4" />
            <span className="w-1 bg-brand-500 rounded-full h-8" />
            <span className="w-1 bg-brand-600 rounded-full h-12" />
            <span className="w-1 bg-amber-600 rounded-full h-16" />
            <span className="w-1 bg-brand-500 rounded-full h-10" />
            <span className="w-1 bg-amber-500 rounded-full h-5" />
            <span className="w-1 bg-brand-600 rounded-full h-3" />
          </div>
        </div>
        <div className="absolute -top-32 right-1/4 w-96 h-96 bg-amber-200/40 rounded-full blur-3xl pointer-events-none -z-10" />
        <div className="absolute top-20 left-10 w-80 h-80 bg-brand-200/30 rounded-full blur-3xl pointer-events-none -z-10" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-12 gap-12 lg:gap-8 items-center">
            {/* copy */}
            <div className="lg:col-span-6 flex flex-col items-start z-10">
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-brand-100/70 dark:bg-brand-900/70 border border-brand-200 dark:border-brand-800 text-brand-800 dark:text-brand-300 text-xs font-bold tracking-wide uppercase mb-6">
                <span className="flex items-center gap-0.5 px-1 py-0.5 bg-brand-500 rounded-full text-white">
                  <Wave className="w-1 h-2 bg-white dark:bg-slate-900 rounded-full" delay="0.1s" />
                  <Wave className="w-1 h-3.5 bg-white dark:bg-slate-900 rounded-full" delay="0.3s" />
                  <Wave className="w-1 h-2 bg-white dark:bg-slate-900 rounded-full" delay="0.2s" />
                </span>
                <span className="tracking-wider">{t.heroBadge}</span>
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping ml-0.5" />
              </div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100 leading-[1.12] mb-6">
                {t.heroTitleA}{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-brand-600 via-amber-500 to-amber-600">{t.heroTitleB}</span>
              </h1>
              <p className="text-lg text-slate-600 dark:text-slate-400 leading-relaxed max-w-xl mb-6">
                {t.heroSay} <span className="font-semibold bg-amber-50/70 dark:bg-amber-950/70 px-1.5 py-0.5 rounded border border-amber-100/70 dark:border-amber-900/70 text-brand-800 dark:text-brand-300">{t.heroQuote1}</span>{' '}
                <span className="font-semibold bg-amber-50/70 dark:bg-amber-950/70 px-1.5 py-0.5 rounded border border-amber-100/70 dark:border-amber-900/70 text-brand-800 dark:text-brand-300">{t.heroQuote2}</span>{t.heroBodyMid}{' '}
                <strong className="font-semibold text-slate-900 dark:text-slate-100">VoTask</strong> {t.heroBodyEnd}
              </p>

              <div className="w-full max-w-xl mb-8">
                {/* Most people who land here are not shopping — signed out, the web
                    app and the Android app both open on this page, so it is the
                    front door for every employee coming back to log in. The hero
                    used to offer only "Try VoTask Free", and on a phone the header's
                    Sign in is hidden, so logging in meant scrolling or guessing.
                    Log in now comes first and Create account second, both filled
                    and full-width on a phone, with the workspace code under them.

                    They are plain router Links to pages already in the main bundle
                    (Login and Signup are not lazy-loaded in App.tsx), so a tap is
                    a client-side route change with no network in between — keep it
                    that way. touch-manipulation drops the double-tap-to-zoom wait
                    and active:scale answers the finger on the same frame. */}
                <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 sm:gap-4 mb-4">
                  <Link className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-gradient-to-r from-brand-600 to-amber-600 hover:from-brand-700 hover:to-amber-700 text-white font-semibold text-base px-7 py-3.5 rounded-full shadow-lg shadow-brand-600/25 hover:shadow-xl hover:shadow-brand-600/35 touch-manipulation active:scale-[0.98] transition duration-150" to="/login">
                    {/* An arrow into a door: entering an account that already exists. */}
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" /></svg>
                    <span>{t.signIn}</span>
                  </Link>
                  <Link className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-slate-900 hover:bg-slate-800 dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 font-semibold text-base px-7 py-3.5 rounded-full shadow-md shadow-slate-900/15 touch-manipulation active:scale-[0.98] transition duration-150" to="/signup">
                    <span>{t.createAccount}</span>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                  </Link>
                  {/* The third hero action. It used to be "Watch Demo" — a button
                      with no onClick behind it, so the whole thing was a painted
                      placeholder. Joining with a workspace code is the real other
                      path onto the product: Create account is for the person
                      starting a company, this is for the person whose company
                      already exists and who was handed an 8-character code. */}
                  <Link className="w-full sm:w-auto inline-flex items-center justify-center gap-2.5 bg-white dark:bg-slate-900 hover:bg-slate-50 text-slate-700 dark:text-slate-300 font-semibold text-base px-6 py-3 rounded-full border border-slate-200 dark:border-slate-700 shadow-sm touch-manipulation active:scale-[0.98] transition duration-150" to="/join">
                    <span className="w-7 h-7 rounded-full bg-orange-100 dark:bg-orange-950 flex items-center justify-center text-brand-600 dark:text-brand-400">
                      {/* A key, for a code that unlocks a workspace you already belong to. */}
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
                        <circle cx="8" cy="15" r="4" /><path d="m10.85 12.15 8.15-8.15M18 5l2 2M15 8l2 2" />
                      </svg>
                    </span>
                    <span>{t.joinCode}</span>
                  </Link>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-2xl p-3 sm:p-3.5 border border-orange-200/90 dark:border-orange-900/90 shadow-card flex flex-col gap-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <button className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-600 to-amber-500 text-white flex items-center justify-center shadow-md shadow-brand-500/30 hover:scale-105 transition-transform shrink-0">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">{t.simulator}</span>
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        </div>
                        <p className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">{t.simulatorQuote}</p>
                      </div>
                    </div>
                    <div className="hidden sm:flex items-center gap-1 px-2 py-1 bg-amber-50/70 dark:bg-amber-950/70 rounded-lg border border-amber-100/70 dark:border-amber-900/70 shrink-0">
                      <Wave className="w-1 bg-brand-500 rounded-full h-3" />
                      <Wave className="w-1 bg-amber-500 rounded-full h-5" delay="0.2s" />
                      <Wave className="w-1 bg-brand-600 rounded-full h-4" delay="0.4s" />
                      <Wave className="w-1 bg-amber-600 rounded-full h-6" delay="0.1s" />
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px]">
                    <span className="text-slate-500 dark:text-slate-500 font-medium">{t.trySaying}</span>
                    <span className="cursor-pointer px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900 hover:bg-brand-100 text-brand-700 dark:text-brand-300 font-medium border border-brand-200/80 dark:border-brand-800/80 transition-colors">{`🎙️ ${t.chip1}`}</span>
                    <span className="cursor-pointer px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900 hover:bg-brand-100 text-brand-700 dark:text-brand-300 font-medium border border-brand-200/80 dark:border-brand-800/80 transition-colors">{`⚡ ${t.chip2}`}</span>
                    <span className="cursor-pointer px-2 py-0.5 rounded-full bg-brand-50 dark:bg-brand-900 hover:bg-brand-100 text-brand-700 dark:text-brand-300 font-medium border border-brand-200/80 dark:border-brand-800/80 transition-colors">{`📤 ${t.chip3}`}</span>
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-200/80 dark:border-slate-700/80 w-full max-w-md">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-3 tracking-wide">{t.availableOn}</p>
                <div className="flex flex-wrap items-center gap-5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <div className="flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-slate-500 dark:text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                    <span>{t.webApp}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-slate-500 dark:text-slate-500" fill="currentColor" viewBox="0 0 24 24"><path d="M17.6 9.48l1.84-3.18a.4.4 0 10-.69-.4l-1.87 3.23a11.4 11.4 0 00-9.76 0L5.25 5.9a.4.4 0 10-.69.4L6.4 9.48A10.8 10.8 0 00.9 18.4h22.2a10.8 10.8 0 00-5.5-8.92zM7 15.2a.95.95 0 110-1.9.95.95 0 010 1.9zm10 0a.95.95 0 110-1.9.95.95 0 010 1.9z" /></svg>
                    <span>Android</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-slate-500 dark:text-slate-500" fill="currentColor" viewBox="0 0 24 24"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.37c.62-.75 1.04-1.8.92-2.85-.9.04-1.99.6-2.63 1.35-.57.66-.99 1.73-.86 2.76 1.01.08 2.02-.51 2.57-1.26z" /></svg>
                    <span>iOS</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-brand-600 dark:text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" strokeWidth="2" /><path d="M12 2v4m0 12v4M2 12h4m12 0h4" strokeWidth="2" strokeLinecap="round" /></svg>
                    <span className="text-brand-700 dark:text-brand-300">Claude (MCP)</span>
                  </div>
                </div>
              </div>
            </div>

            {/* dashboard mockup */}
            <div className="lg:col-span-6 relative">
              <div className="hidden sm:block absolute -top-10 right-8 font-handwriting text-2xl text-slate-700 dark:text-slate-300 rotate-2 pointer-events-none z-20">
                {t.noteProgress}
                <svg className="w-10 h-8 text-amber-500 inline-block -rotate-12 ml-1" fill="none" stroke="currentColor" viewBox="0 0 50 30"><path d="M5 25 Q 25 5, 45 15 M38 8 L 47 15 L 42 22" strokeLinecap="round" strokeWidth="2" /></svg>
              </div>

              <div className="relative bg-white dark:bg-slate-900 rounded-2xl border border-orange-200/80 dark:border-orange-900/80 shadow-app overflow-hidden transition duration-300 hover:shadow-2xl">
                <div className="bg-slate-50/80 dark:bg-slate-800/80 border-b border-slate-200/70 dark:border-slate-700/70 px-4 py-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-red-400" />
                    <div className="w-3 h-3 rounded-full bg-amber-400" />
                    <div className="w-3 h-3 rounded-full bg-emerald-400" />
                  </div>
                  <div className="flex-1 max-w-sm relative">
                    <svg className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 absolute left-3 top-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                    <input className="w-full text-xs bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg pl-8 pr-3 py-1.5 text-slate-600 dark:text-slate-400 focus:outline-none cursor-default" readOnly type="text" value="Search meetings, tasks, or people..." />
                  </div>
                  <div className="flex items-center gap-2">
                    <button className="text-slate-400 dark:text-slate-500 hover:text-slate-600 p-1">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                    </button>
                    <div className="w-6 h-6 rounded-full bg-brand-500 text-white text-[10px] font-bold flex items-center justify-center">VS</div>
                  </div>
                </div>

                <div className="grid grid-cols-12 min-h-[360px]">
                  <aside className="col-span-3 border-r border-slate-100 dark:border-slate-800 bg-slate-50/40 dark:bg-slate-800/40 p-3 flex flex-col justify-between text-xs font-medium text-slate-600 dark:text-slate-400">
                    <div className="space-y-1">
                      {([
                        ['Home', 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6', false],
                        ['Meetings', 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z', true],
                        ['Tasks', 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', false],
                        ['Calendar', 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z', false],
                        ['Team', 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z', false],
                      ] as [string, string, boolean][]).map(([label, d, active]) => (
                        <div key={label} className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer ${active ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-slate-500 hover:bg-slate-100/80'}`}>
                          <svg className={`w-4 h-4 ${active ? 'text-brand-600 dark:text-brand-400' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d={d} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>
                    <div className="pt-2 border-t border-slate-200/60 dark:border-slate-700/60">
                      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-slate-500 dark:text-slate-500 hover:bg-slate-100/80 cursor-pointer">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" strokeWidth="2" /><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                        <span>Settings</span>
                      </div>
                    </div>
                  </aside>

                  <main className="col-span-9 p-4 flex flex-col justify-between">
                    <div>
                      <div className="flex items-start justify-between pb-3 border-b border-slate-100 dark:border-slate-800">
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-lg bg-brand-100 dark:bg-brand-900 text-brand-700 dark:text-brand-300 flex items-center justify-center font-bold text-xs">PS</div>
                          <div>
                            <h2 className="text-sm font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                              Product Sync
                              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            </h2>
                            <p className="text-[11px] text-slate-600 dark:text-slate-400">Apr 26, 2025 • 10:00 AM • 46 min</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button className="inline-flex items-center gap-1 bg-brand-500 hover:bg-brand-600 text-white text-[11px] font-semibold px-2.5 py-1 rounded-md">
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                            <span>Share</span>
                          </button>
                          <button className="text-slate-400 dark:text-slate-500 hover:text-slate-600 p-1 border border-slate-200 dark:border-slate-700 rounded-md">
                            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20"><circle cx="4" cy="10" r="2" /><circle cx="10" cy="10" r="2" /><circle cx="16" cy="10" r="2" /></svg>
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 border-b border-slate-100 dark:border-slate-800 text-xs font-semibold mt-3 mb-3">
                        <button className="pb-2 text-slate-600 dark:text-slate-400 hover:text-slate-700 flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                          Transcript
                        </button>
                        <button className="pb-2 border-b-2 border-brand-600 text-brand-600 dark:text-brand-400 flex items-center gap-1 font-bold">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                          Tasks <span className="bg-brand-100 dark:bg-brand-900 text-brand-700 dark:text-brand-300 text-[10px] px-1.5 rounded-full">4</span>
                        </button>
                        <button className="pb-2 text-slate-600 dark:text-slate-400 hover:text-slate-700 flex items-center gap-1">
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                          Participants
                        </button>
                      </div>

                      <div className="space-y-2">
                        <div className="grid grid-cols-12 text-[10px] uppercase font-bold text-slate-600 dark:text-slate-400 px-2">
                          <div className="col-span-6">Task</div>
                          <div className="col-span-2">Assigned</div>
                          <div className="col-span-2 text-center">Priority</div>
                          <div className="col-span-2 text-right">Due</div>
                        </div>
                        {([
                          ['Update product roadmap', 'Alex', 'A', 'bg-blue-500', 'High', 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300', 'Apr 28', true],
                          ['Prepare marketing deck', 'Priya', 'P', 'bg-purple-500', 'Medium', 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300', 'Apr 30', false],
                          ['Review budget proposal', 'Daniel', 'D', 'bg-emerald-500', 'High', 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300', 'May 3', false],
                          ['Set up user testing', 'Meera', 'M', 'bg-indigo-500', 'Low', 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300', 'May 5', false],
                        ] as [string, string, string, string, string, string, string, boolean][]).map(([task, who, initial, avatar, prio, prioClass, due, done]) => (
                          <div key={task} className="grid grid-cols-12 items-center text-xs p-2 rounded-lg bg-slate-50/70 dark:bg-slate-800/70 border border-slate-100 dark:border-slate-800 hover:bg-orange-50/40 transition">
                            <div className="col-span-6 flex items-center gap-2">
                              <input defaultChecked={done} className="w-3.5 h-3.5 text-brand-600 dark:text-brand-400 rounded border-slate-300 dark:border-slate-600" type="checkbox" />
                              <span className={`font-medium truncate ${done ? 'line-through text-slate-500' : 'text-slate-800 dark:text-slate-200'}`}>{task}</span>
                            </div>
                            <div className="col-span-2 flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-400">
                              <span className={`w-4 h-4 rounded-full ${avatar} text-white text-[9px] flex items-center justify-center font-bold`}>{initial}</span>
                              <span>{who}</span>
                            </div>
                            <div className="col-span-2 text-center">
                              <span className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded ${prioClass}`}>{prio}</span>
                            </div>
                            <div className="col-span-2 text-right text-[11px] text-slate-500 dark:text-slate-500">{due}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="pt-3 mt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-600 dark:text-slate-400">
                      <span>Synced automatically to Notion &amp; Jira</span>
                      <span className="text-brand-600 dark:text-brand-400 font-semibold cursor-pointer hover:underline">+ Add Custom Task</span>
                    </div>
                  </main>
                </div>
              </div>

              {/* floating voice widget */}
              <div className="absolute -bottom-8 -left-4 sm:-left-8 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md rounded-2xl p-4 shadow-float border border-orange-200/90 dark:border-orange-900/90 w-80 z-20 transition hover:-translate-y-1">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-500 to-amber-500 text-white flex items-center justify-center shadow-md shadow-brand-500/30 shrink-0">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
                        Voice Mode Active<span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
                      </p>
                      <p className="text-[10px] text-slate-600 dark:text-slate-400">Listening in real time...</p>
                    </div>
                  </div>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">LIVE</span>
                </div>
                <div className="p-2 rounded-lg bg-orange-50/40 dark:bg-orange-950/40 border border-orange-100/80 dark:border-orange-900/80 mb-2">
                  <div className="flex items-center gap-1 text-[10px] font-bold text-brand-700 dark:text-brand-300 mb-0.5">
                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
                    <span>Spoken Command Executed</span>
                  </div>
                  <p className="text-[11px] font-medium text-slate-800 dark:text-slate-200 italic truncate">&ldquo;Schedule sync with design team tomorrow at 10 AM...&rdquo;</p>
                  <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold pt-0.5">✓ Added to Calendar &amp; Slack notified</p>
                </div>
                <div className="h-7 flex items-center justify-center gap-1 px-2 py-1 bg-amber-50/70 dark:bg-amber-950/70 rounded-lg border border-amber-100/70 dark:border-amber-900/70 my-1">
                  <Wave className="w-1 bg-brand-500 rounded-full h-3" delay="0.1s" />
                  <Wave className="w-1 bg-amber-500 rounded-full h-6" delay="0.3s" />
                  <Wave className="w-1 bg-brand-600 rounded-full h-5" delay="0.5s" />
                  <Wave className="w-1 bg-amber-600 rounded-full h-7" delay="0.2s" />
                  <Wave className="w-1 bg-brand-500 rounded-full h-4" delay="0.4s" />
                  <Wave className="w-1 bg-amber-500 rounded-full h-6" delay="0.6s" />
                  <Wave className="w-1 bg-brand-600 rounded-full h-3" delay="0.2s" />
                  <Wave className="w-1 bg-amber-600 rounded-full h-5" delay="0.4s" />
                  <Wave className="w-1 bg-brand-500 rounded-full h-2" delay="0.1s" />
                </div>
                <div className="flex items-center justify-between text-[10px] text-slate-500 dark:text-slate-500 pt-1">
                  <span className="font-medium">Language: Auto-detect (50+)</span>
                  <span className="text-brand-700 dark:text-brand-300 font-semibold flex items-center cursor-pointer">
                    Audio Settings
                    <svg className="w-3 h-3 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                  </span>
                </div>
              </div>

              <div className="hidden sm:block absolute -bottom-10 right-2 font-handwriting text-2xl text-brand-600 dark:text-brand-400 rotate-[-4deg] pointer-events-none">
                {t.noteFlow}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- metrics strip */}
      <section className="border-y border-orange-100 dark:border-orange-900 bg-gradient-to-r from-amber-50/40 dark:from-slate-900 via-white dark:via-slate-900 to-orange-50/40 dark:to-slate-900 py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
            {([
              ['50+', t.mLangs, 'bg-orange-100 dark:bg-orange-950 text-brand-600 dark:text-brand-400', 'M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129'],
              ['10x', t.mFaster, 'bg-amber-100 dark:bg-amber-950 text-amber-600 dark:text-amber-400', 'M13 10V3L4 14h7v7l9-11h-7z'],
              [t.mTeams, t.mTeamsSub, 'bg-orange-100 dark:bg-orange-950 text-brand-600 dark:text-brand-400', 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4'],
              ['100%', t.mData, 'bg-emerald-100 dark:bg-emerald-950 text-emerald-600 dark:text-emerald-400', 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z'],
            ] as [string, string, string, string][]).map(([value, label, tone, d]) => (
              <div key={label} className="flex items-center gap-3.5">
                <div className={`w-11 h-11 rounded-xl ${tone} flex items-center justify-center shrink-0`}>
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d={d} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                </div>
                <div>
                  <div className={`font-extrabold text-slate-900 dark:text-slate-100 tracking-tight ${value.length > 6 ? 'text-base leading-tight' : 'text-2xl'}`}>{value}</div>
                  <div className="text-xs font-semibold text-slate-500 dark:text-slate-500">{label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------ voice command cards */}
      <section className="py-12 bg-white dark:bg-slate-900 border-b border-orange-100/70 dark:border-orange-900/70">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="bg-gradient-to-r from-brand-50 dark:from-slate-800/40 via-white dark:via-slate-900 to-amber-50/40 dark:to-slate-800/40 rounded-2xl border border-orange-200/80 dark:border-orange-900/80 p-6 sm:p-8 shadow-card">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
              <div className="max-w-xl">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-100 dark:bg-brand-900 text-brand-800 dark:text-brand-300 text-xs font-bold uppercase tracking-wider mb-2.5">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                  <span>{t.vcBadge}</span>
                </div>
                <h3 className="text-xl sm:text-2xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight mb-2">{t.vcTitle}</h3>
                <p className="text-sm text-slate-600 dark:text-slate-400">{t.vcBody}</p>
              </div>
              <div className="flex items-center gap-2 bg-white dark:bg-slate-900 px-4 py-2 rounded-xl border border-orange-100 dark:border-orange-900 shadow-sm shrink-0">
                <div className="w-2.5 h-2.5 rounded-full bg-brand-600 animate-ping" />
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200">{t.vcEngine}</span>
              </div>
            </div>
            <div className="grid sm:grid-cols-3 gap-4 mt-6">
              {([
                ['0.4s', t.vcQuote1, 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300', t.vcRes1],
                ['0.6s', t.vcQuote2, 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300', t.vcRes2],
                ['0.3s', t.vcQuote3, 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300', t.vcRes3],
              ] as [string, string, string, string][]).map(([ms, quote, tone, result]) => (
                <div key={ms} className="bg-white dark:bg-slate-900 p-4 rounded-xl border border-orange-100/90 dark:border-orange-900/90 hover:shadow-md transition">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold text-brand-700 dark:text-brand-300 uppercase tracking-wider">{t.vcIn}</span>
                    <span className="text-[10px] font-semibold text-slate-400 dark:text-slate-500">{ms}</span>
                  </div>
                  <p className="text-xs font-bold text-slate-900 dark:text-slate-100 italic mb-3">{quote}</p>
                  <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
                    <span className={`w-5 h-5 rounded-md ${tone} text-[10px] flex items-center justify-center font-bold`}>✓</span>
                    <span className="text-[11px] text-slate-600 dark:text-slate-400 font-medium">{result}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- features */}
      <section className="py-20 bg-[#FCFAF7] dark:bg-[#0f1216] relative" id="features">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <div className="inline-block px-3.5 py-1 rounded-full bg-brand-100 dark:bg-brand-900 border border-brand-200 dark:border-brand-800 text-brand-800 dark:text-brand-300 text-xs font-bold tracking-wide uppercase mb-3">{t.fBadge}</div>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight mb-3">{t.fTitle}</h2>
            <p className="text-base text-slate-600 dark:text-slate-400">{t.fSub}</p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {([
              [t.f1, t.f1b, 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z'],
              [t.f2, t.f2b, 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
              [t.f3, t.f3b, 'M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z'],
              [t.f4, t.f4b, 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z'],
            ] as [string, string, string][]).map(([title, body, d]) => (
              <div key={title} className="bg-white dark:bg-slate-900 rounded-2xl p-6 border border-orange-100/90 dark:border-orange-900/90 shadow-card hover:shadow-xl hover:-translate-y-1 transition duration-200">
                <div className="w-12 h-12 rounded-xl bg-brand-100 dark:bg-brand-900 text-brand-600 dark:text-brand-400 flex items-center justify-center mb-5">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d={d} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                </div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-slate-100 mb-2">{title}</h3>
                <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="py-20 bg-white dark:bg-slate-900 border-t border-orange-100/60 dark:border-orange-900/60 relative" id="how-it-works">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <div className="inline-block px-3.5 py-1 rounded-full bg-brand-100 dark:bg-brand-900 border border-brand-200 dark:border-brand-800 text-brand-800 dark:text-brand-300 text-xs font-bold tracking-wide uppercase mb-3">{t.hBadge}</div>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight mb-3">{t.hTitle}</h2>
            <p className="text-base text-slate-600 dark:text-slate-400">{t.hSub}</p>
          </div>
          <div className="grid md:grid-cols-4 gap-6 relative">
            {([
              [t.h1, t.h1b, 'M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z'],
              [t.h2, t.h2b, 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z'],
              [t.h3, t.h3b, 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z'],
              [t.h4, t.h4b, 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'],
            ] as [string, string, string][]).map(([title, body, d], i) => (
              <div key={title} className="relative bg-[#FCFAF7] dark:bg-[#0f1216] border border-orange-100 dark:border-orange-900 rounded-2xl p-6 text-center flex flex-col items-center">
                <div className="w-8 h-8 rounded-full bg-brand-600 text-white font-bold text-xs flex items-center justify-center mb-3">{i + 1}</div>
                <div className="w-12 h-12 rounded-xl bg-orange-100 dark:bg-orange-950 text-brand-600 dark:text-brand-400 flex items-center justify-center mb-4">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d={d} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                </div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">{title}</h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{body}</p>
                {i < 3 && (
                  <div className="hidden lg:block absolute -right-4 top-1/2 -translate-y-1/2 z-10 text-orange-300">
                    <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- spotlight */}
      <section className="py-20 bg-[#FCFAF7] dark:bg-[#0f1216] border-t border-orange-100/60 dark:border-orange-900/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid lg:grid-cols-12 gap-12 items-center">
            <div className="lg:col-span-5">
              <div className="inline-block px-3.5 py-1 rounded-full bg-brand-100 dark:bg-brand-900 border border-brand-200 dark:border-brand-800 text-brand-800 dark:text-brand-300 text-xs font-bold tracking-wide uppercase mb-4">{t.sBadge}</div>
              <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight leading-tight mb-4">
                {t.sTitleA} <span className="text-brand-600 dark:text-brand-400">{t.sTitleB}</span>
              </h2>
              <p className="text-base text-slate-600 dark:text-slate-400 leading-relaxed mb-8">
                {t.sBody}
              </p>
              <Link className="inline-flex items-center gap-2 bg-gradient-to-r from-brand-600 to-amber-600 hover:from-brand-700 hover:to-amber-700 text-white font-semibold text-sm px-6 py-3 rounded-full shadow-md shadow-brand-600/20 transition duration-150" to="/signup">
                <span>{t.sCta}</span>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
              </Link>
            </div>
            <div className="lg:col-span-7">
              <div className="bg-white dark:bg-slate-900 rounded-2xl border border-orange-200/80 dark:border-orange-900/80 shadow-card p-5 sm:p-6">
                <div className="grid md:grid-cols-2 gap-6">
                  <div className="border-b md:border-b-0 md:border-r border-slate-100 dark:border-slate-800 md:pr-6 pb-6 md:pb-0">
                    <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
                      <svg className="w-4 h-4 text-brand-600 dark:text-brand-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 100-6 3 3 0 000 6z" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t.sTranscript}</h3>
                    </div>
                    <div className="space-y-4 text-xs">
                      {([
                        ['Priya', 'P', 'bg-purple-500', '00:12', 'Let’s finalize the product roadmap for Q2 today.'],
                        ['Daniel', 'D', 'bg-emerald-500', '00:28', 'We need to focus on user feedback and improve onboarding.'],
                        ['Meera', 'M', 'bg-indigo-500', '01:14', 'Agreed. We should also prepare the new marketing deck.'],
                      ] as [string, string, string, string, string][]).map(([who, initial, tone, time, said]) => (
                        <div key={who} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              <span className={`w-5 h-5 rounded-full ${tone} text-white text-[10px] font-bold flex items-center justify-center`}>{initial}</span>
                              <span className="font-bold text-slate-800 dark:text-slate-200">{who}</span>
                            </div>
                            <span className="text-[10px] text-slate-600 dark:text-slate-400">{time}</span>
                          </div>
                          <p className="text-slate-600 dark:text-slate-400 pl-7 text-[11px] leading-relaxed">{said}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 mb-4 pb-2 border-b border-slate-100 dark:border-slate-800">
                      <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
                      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">{t.sTasks}</h3>
                    </div>
                    <div className="space-y-2.5 text-xs">
                      {([
                        ['Update product roadmap', 'High', 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300', true],
                        ['Prepare marketing deck', 'Medium', 'bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300', false],
                        ['Review budget proposal', 'High', 'bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300', false],
                        ['Set up user testing', 'Low', 'bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300', false],
                      ] as [string, string, string, boolean][]).map(([task, prio, tone, done]) => (
                        <div key={task} className="flex items-center justify-between p-2 rounded-lg bg-orange-50/40 dark:bg-orange-950/40 border border-orange-100/60 dark:border-orange-900/60">
                          <div className="flex items-center gap-2 truncate">
                            <input defaultChecked={done} className="w-3.5 h-3.5 text-brand-600 dark:text-brand-400 rounded" type="checkbox" />
                            <span className="font-medium text-slate-800 dark:text-slate-200 text-[11px] truncate">{task}</span>
                          </div>
                          <span className={`text-[9px] font-semibold px-2 py-0.5 rounded ${tone} shrink-0`}>{prio}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- testimonials */}
      <section className="py-20 bg-white dark:bg-slate-900 border-t border-orange-100/60 dark:border-orange-900/60 relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-2xl mx-auto mb-16">
            <div className="inline-block px-3.5 py-1 rounded-full bg-brand-100 dark:bg-brand-900 border border-brand-200 dark:border-brand-800 text-brand-800 dark:text-brand-300 text-xs font-bold tracking-wide uppercase mb-3">{t.tBadge}</div>
            <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight">{t.tTitle}</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {([
              [t.tQ1, 'Priya Sharma', t.tR1, 'PS', 'from-amber-400 to-brand-500'],
              [t.tQ2, 'Lucas Meyer', t.tR2, 'LM', 'from-blue-400 to-indigo-500'],
              [t.tQ3, 'Emily Chen', t.tR3, 'EC', 'from-emerald-400 to-teal-500'],
            ] as [string, string, string, string, string][]).map(([quote, name, role, initials, tone]) => (
              <div key={name} className="bg-[#FCFAF7] dark:bg-[#0f1216] border border-orange-100/80 dark:border-orange-900/80 rounded-2xl p-6 shadow-subtle hover:shadow-card transition flex flex-col justify-between">
                <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed italic mb-6">{quote}</p>
                <div className="flex items-center gap-3 pt-4 border-t border-orange-100 dark:border-orange-900">
                  <div className={`w-10 h-10 rounded-full bg-gradient-to-tr ${tone} text-white font-bold text-sm flex items-center justify-center`}>{initials}</div>
                  <div>
                    <h4 className="text-sm font-bold text-slate-900 dark:text-slate-100">{name}</h4>
                    <p className="text-xs text-slate-600 dark:text-slate-400">{role}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- bottom CTA */}
      <section className="py-20 relative bg-gradient-to-b from-white dark:from-slate-900 via-orange-50/50 dark:via-slate-900 to-[#FCFAF7] dark:to-[#0f1216] border-t border-orange-100/70 dark:border-orange-900/70 overflow-hidden">
        <div className="absolute inset-x-0 bottom-0 h-40 opacity-15 flex items-end justify-center gap-1.5 pointer-events-none -z-10">
          {[6, 12, 20, 16, 28, 36, 24, 32, 44, 36, 28, 20, 16, 10, 5].map((h, i) => (
            <div key={i} className="w-1.5 rounded-full bg-brand-500" style={{ height: `${h * 4}px` }} />
          ))}
        </div>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative">
          <h2 className="text-3xl sm:text-4xl font-extrabold text-slate-900 dark:text-slate-100 tracking-tight mb-3">{t.cTitle}</h2>
          <p className="text-base text-slate-600 dark:text-slate-400 mb-8 max-w-lg mx-auto">{t.cSub}</p>
          <Link className="inline-flex items-center justify-center gap-2 bg-gradient-to-r from-brand-600 to-amber-600 hover:from-brand-700 hover:to-amber-700 text-white font-semibold text-base px-8 py-3.5 rounded-full shadow-lg shadow-brand-600/25 hover:shadow-xl hover:shadow-brand-600/35 transition duration-150" to="/signup">
            <span>{t.cBtn}</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M14 5l7 7m0 0l-7 7m7-7H3" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" /></svg>
          </Link>
          <div className="mt-6 font-handwriting text-2xl text-brand-600 dark:text-brand-400">{t.cNote}</div>
        </div>
      </section>

      {/* ------------------------------------------------------------ footer */}
      <footer className="bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 py-12 text-sm text-slate-600 dark:text-slate-400">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 pb-8 border-b border-slate-100 dark:border-slate-800">
            <div className="flex items-center gap-2.5">
              <img src="/logo.png" alt="" className="w-7 h-7 rounded-lg object-contain bg-white dark:bg-slate-900" />
              <span className="text-xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">VoTask</span>
            </div>
            <div className="flex flex-wrap items-center gap-6 text-xs font-semibold">
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition" href="#features">{t.navProduct}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition" href="#how-it-works">{t.navSolutions}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition" href="#pricing">{t.navPricing}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition" href="#resources">{t.fBlog}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-brand-600 transition" href="#resources">{t.navResources}</a>
            </div>
            <div className="flex items-center gap-4 text-slate-400 dark:text-slate-500">
              <a aria-label="LinkedIn" className="text-slate-400 dark:text-slate-500 hover:text-brand-600 transition" href="#social">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h14m-.5 15.5v-5.3a3.26 3.26 0 00-3.26-3.26c-.85 0-1.84.52-2.28 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 011.4 1.4v4.93h2.75M6.88 8.56a1.68 1.68 0 001.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 00-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z" /></svg>
              </a>
              <a aria-label="Twitter" className="text-slate-400 dark:text-slate-500 hover:text-brand-600 transition" href="#social">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M23 3a10.9 10.9 0 01-3.14 1.53 4.48 4.48 0 00-7.86 3v1A10.66 10.66 0 013 4s-4 9 5 13a11.64 11.64 0 01-7 2c9 5 20 0 20-11.5a4.5 4.5 0 00-.08-.83A7.72 7.72 0 0023 3z" /></svg>
              </a>
              <a aria-label="YouTube" className="text-slate-400 dark:text-slate-500 hover:text-brand-600 transition" href="#social">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M23.5 6.19a3.02 3.02 0 00-2.12-2.14C19.5 3.55 12 3.55 12 3.55s-7.5 0-9.38.5A3.02 3.02 0 00.5 6.19C0 8.07 0 12 0 12s0 3.93.5 5.81a3.02 3.02 0 002.12 2.14c1.87.5 9.38.5 9.38.5s7.5 0 9.38-.5a3.02 3.02 0 002.12-2.14C24 15.93 24 12 24 12s0-3.93-.5-5.81zM9.55 15.57V8.43L15.82 12l-6.27 3.57z" /></svg>
              </a>
            </div>
          </div>
          <div className="pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-600 dark:text-slate-400">
            <div>{t.fRights}</div>
            <div className="flex items-center gap-6">
              <Link className="text-slate-600 dark:text-slate-400 hover:text-slate-700" to="/privacy">{t.fPrivacy}</Link>
              <a className="text-slate-600 dark:text-slate-400 hover:text-slate-700" href="#terms">{t.fTerms}</a>
              <a className="text-slate-600 dark:text-slate-400 hover:text-slate-700" href="#contact">{t.fContact}</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
