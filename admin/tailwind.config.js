/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f0fdfa",
          100: "#ccfbf1",
          500: "#0d9488",
          600: "#0F766E",
          700: "#0f766e",
          800: "#115e59",
          900: "#134e4a",
        },
        accent: { 500: "#D97706", 600: "#b45309" },
      },
    },
  },
  plugins: [],
};
