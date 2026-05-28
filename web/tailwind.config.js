/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        hub: {
          bg: '#0d1117',
          surface: '#161b22',
          border: '#30363d',
          'border-hover': '#58a6ff',
          text: '#c9d1d9',
          'text-muted': '#8b949e',
          accent: '#58a6ff',
          'accent-bg': '#1f6feb',
          green: '#3fb950',
          red: '#f85149',
          yellow: '#d29922',
          orange: '#f0883e',
        },
      },
    },
  },
  plugins: [],
}
