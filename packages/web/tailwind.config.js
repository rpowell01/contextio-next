/** @type {import('tailwindcss').Config} */
import animate from "tailwindcss-animate";

const config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [animate],
}

export default config