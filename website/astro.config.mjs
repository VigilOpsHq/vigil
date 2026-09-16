import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: 'VigilOps',
      description: 'A self-hosted ops agent for your Docker servers.',
      favicon: '/favicon.svg',
      logo: { src: './src/assets/logo.svg', replacesTitle: false },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/VigilOpsHq/vigil' }],
      editLink: { baseUrl: 'https://github.com/VigilOpsHq/vigil/edit/main/website/' },
      customCss: ['./src/styles/theme.css'],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'What is VigilOps?', slug: 'docs' },
            { label: 'Install', slug: 'docs/install' },
            { label: 'First steps', slug: 'docs/first-steps' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Database backups', slug: 'docs/guides/backups' },
            { label: 'Restoring a backup', slug: 'docs/guides/restore' },
            { label: 'Off-server backup storage', slug: 'docs/guides/offsite-storage' },
            { label: 'Auto-fixes, AI and approvals', slug: 'docs/guides/auto-fixes' },
            { label: 'Deploying apps', slug: 'docs/guides/deploys' },
            { label: 'Updating VigilOps', slug: 'docs/guides/updating' },
            { label: 'Using VigilOps from AI agents (MCP)', slug: 'docs/guides/mcp' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI commands', slug: 'docs/reference/cli' },
            { label: 'Telegram commands', slug: 'docs/reference/telegram' },
            { label: 'Configuration (.env)', slug: 'docs/reference/configuration' },
            { label: 'Files and paths', slug: 'docs/reference/files' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'Developing locally', slug: 'docs/contributing/develop' },
            { label: 'Releasing a version', slug: 'docs/contributing/release' },
          ],
        },
      ],
    }),
  ],
});
