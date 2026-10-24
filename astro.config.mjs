import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://twmalllibrary.i71924.workers.dev',
  trailingSlash: 'always',
  vite: { plugins: [tailwindcss()] },
});
