import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://twmalllibrary.pages.dev',
  trailingSlash: 'ignore',
  vite: { plugins: [tailwindcss()] },
});
