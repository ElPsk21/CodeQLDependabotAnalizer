import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  plugins: [
    react(),
    {
      name: "save-token-middleware",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/api/save-token" && req.method === "POST") {
            let body = "";
            req.on("data", chunk => {
              body += chunk.toString();
            });
            req.on("end", () => {
              try {
                const data = JSON.parse(body);
                if (data.token) {
                  const tokenPath = path.resolve(__dirname, "../firebase_token.txt");
                  fs.writeFileSync(tokenPath, data.token.trim() + "\n");
                  console.debug(`[Vite Dev Server] Token FCM guardado automáticamente en ${tokenPath}`);
                  res.writeHead(200, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ success: true }));
                  return;
                }
              } catch (err) {
                console.error("[Vite Dev Server] Error al procesar token:", err);
              }
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid payload" }));
            });
          } else {
            next();
          }
        });
      },
    },
  ],
});
