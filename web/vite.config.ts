import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// VITE_API_TARGET: base del backend real (ej. http://<ip-del-server>).
// Va en web/.env.local, que NO se commitea: la IP del server no entra al repo.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_TARGET;

  return {
    plugins: [
      react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } }),
      tailwindcss(),
    ],
    server: target
      ? {
          proxy: {
            "/api": { target, changeOrigin: true },
            "/tiles": { target, changeOrigin: true },
          },
        }
      : {},
  };
});
