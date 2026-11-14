import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// VITE_API_TARGET: base del backend real (ej. http://<ip-del-server>).
// Va en web/.env.local, que NO se commitea: la IP del server no entra al repo.
// Solo sirve para `npm run dev` (proxy). El build de producción no la usa:
// nginx sirve /api en el mismo origen (ver usingFixtures en src/api/client.ts).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_API_TARGET;

  return {
    plugins: [
      react({ babel: { plugins: [["babel-plugin-react-compiler", {}]] } }),
      tailwindcss(),
    ],
    // maplibre-gl 6 carga su worker con new URL(..., import.meta.url). Si Vite
    // lo pre-empaqueta, el worker no queda en .vite/deps (504) y el mapa queda
    // en negro con "Worker failed to load". Se sirve tal cual.
    optimizeDeps: { exclude: ["maplibre-gl"] },
    // Al cliente le llega solo SI hay proxy, nunca la dirección: el código de
    // src/ no lee VITE_API_TARGET, así la IP no puede terminar en el bundle.
    define: { __API_PROXY__: JSON.stringify(Boolean(target)) },
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
