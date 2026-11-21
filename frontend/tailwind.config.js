/** @type {import('tailwindcss').Config} */
// Baymax palette: vinyl white, ink black, suit red, and the lavender shading from his head.
// Tailwind picks class names from these files and adds the BAYMAX colours, font and shadows below.
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#F7F4FA',
        ink: '#17141C',
        brand: { DEFAULT: '#E2362F', deep: '#B72620', soft: '#FCE3E1' },
        violet: { DEFAULT: '#8C7BC6', deep: '#6D5BAA' },
        lav: { DEFAULT: '#E6E0F4', deep: '#D3C9EC', mist: '#F0ECF8' },
      },
      fontFamily: {
        sans: ['"Nunito Variable"', 'Nunito', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 0 rgba(23,20,28,.05), 0 8px 24px -14px rgba(23,20,28,.28)',
        sticker: '5px 6px 0 0 #17141C',
        pop: '0 24px 60px -18px rgba(23,20,28,.55)',
      },
    },
  },
  plugins: [],
}
