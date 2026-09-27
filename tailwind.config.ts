import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#0a0d14",
        card: "#111625",
        "card-hover": "#171f33",
        "border-glow": "#1e293b",
        neon: {
          cyan: "#00f0ff",
          purple: "#7000ff",
          emerald: "#10b981",
          rose: "#f43f5e",
          amber: "#f59e0b"
        }
      },
      boxShadow: {
        "neon-cyan": "0 0 15px rgba(0, 240, 255, 0.35)",
        "neon-purple": "0 0 15px rgba(112, 0, 255, 0.4)",
        "glass-inset": "inset 0 1px 1px 0 rgba(255, 255, 255, 0.08)"
      }
    },
  },
  plugins: [],
};
export default config;
