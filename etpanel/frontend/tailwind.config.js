/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // ET:Legacy inspired colors
        et: {
          dark: '#1a1a2e',
          darker: '#0f0f1a',
          accent: '#ff6b35',
          green: '#4ade80',
          red: '#ef4444',
          blue: '#3b82f6',
        }
      }
    },
  },
  plugins: [],
}
