import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Enregistrement des captures d'ecran, pendant le developpement seulement.
 *
 * Le jeu dessine dans un canevas : son contenu ne sort du navigateur que si
 * quelqu'un l'ecrit. Cette route accepte l'image que `__q3.capture()` envoie et
 * la pose dans docs/, sous un nom borne. Elle n'existe que sous le serveur de
 * developpement : la version compilee n'a pas de serveur du tout.
 */
function screenshotWriter(): Plugin {
  const root = dirname(new URL(import.meta.url).pathname);
  return {
    name: 'quake-redux-screenshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (request, response) => {
        const query = new URL(request.url ?? '', 'http://localhost').searchParams;
        const name = query.get('name') ?? '';
        const extension = query.get('type') === 'jpeg' ? 'jpg' : 'png';
        // Nom borne : des lettres, des chiffres et des tirets, rien d'autre.
        if (request.method !== 'POST' || !/^[a-z0-9-]{1,48}$/.test(name)) {
          response.statusCode = 400;
          response.end('nom de capture invalide');
          return;
        }

        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const target = join(resolve(root, 'docs'), `${name}.${extension}`);
          void mkdir(dirname(target), { recursive: true })
            .then(() => writeFile(target, Buffer.concat(chunks)))
            .then(() => {
              response.statusCode = 200;
              response.end(target);
            })
            .catch((error: Error) => {
              response.statusCode = 500;
              response.end(error.message);
            });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [screenshotWriter()],
  server: { port: 5213, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
});
