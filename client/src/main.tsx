import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './auth'
import { applyWallpaper, getWallpaperId } from './lib/wallpaper'
import { initTheme } from './lib/theme'
import { releaseBackgroundRecording } from './lib/backgroundRecording'
import './styles.css'
import './tailwind.css' // after styles.css — see the note in tailwind.css

// Restore the user's chosen app wallpaper before first paint.
applyWallpaper(getWallpaperId())
// index.html has already painted the theme; this re-applies it and, more to the
// point, subscribes to the OS setting so "System" keeps following it live.
initTheme()
// A page that has just loaded is recording nothing. A "Recording meeting"
// service left over from before a reload would keep the phone's microphone
// notification up over a recording that no longer exists.
releaseBackgroundRecording()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
)
