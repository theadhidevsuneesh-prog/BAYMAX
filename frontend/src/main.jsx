import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/nunito'
import App from './App.jsx'
import { initGaze } from './lib/gaze'
import './index.css'

// Start eye-tracking, then draw the app.
initGaze()
createRoot(document.getElementById('root')).render(<App />)
