import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'ContextIO-Next',
  description: 'Single-port Docker proxy for LLM API traffic with redaction, logging, rate limiting, and OIDC auth',
  lang: 'en-US',
  lastUpdated: true,
  cleanUrls: true,
  metaChunk: true,
  base: '/contextio-next/',

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }],
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'ContextIO-Next' }],
    ['meta', { property: 'og:description', content: 'Single-port Docker proxy for LLM API traffic with redaction, logging, rate limiting, and OIDC auth' }],
    ['meta', { property: 'og:image', content: 'https://rpowell01.github.io/contextio-next/contextio-next-brand.png' }],
  ],

  themeConfig: {
    logo: '/contextio-next-brand.png',
    siteTitle: 'ContextIO-Next',

    nav: [
      { text: 'Home', link: '/' },
      { text: 'Quick Start', link: '/quick-start' },
      { text: 'Configuration', link: '/configuration/environment-variables' },
      { text: 'Features', link: '/features/overview' },
      { text: 'API', link: '/api/overview' },
      { text: 'GitHub', link: 'https://github.com/rpowell01/contextio-next' },
    ],

    sidebar: {
      '/quick-start': [
        {
          text: 'Quick Start',
          items: [
            { text: 'Docker Compose', link: '/quick-start' },
            { text: 'Client Configuration', link: '/quick-start/client-configuration' },
            { text: 'Coolify Deployment', link: '/quick-start/coolify' },
          ],
        },
      ],
      '/configuration/': [
        {
          text: 'Configuration',
          items: [
            { text: 'Environment Variables', link: '/configuration/environment-variables' },
            { text: 'Required Secrets', link: '/configuration/secrets' },
            { text: 'Rate Limiter', link: '/configuration/rate-limiter' },
            { text: 'Retry Plugin', link: '/configuration/retry-plugin' },
            { text: 'OIDC Authentication', link: '/configuration/oidc' },
            { text: 'Encryption at Rest', link: '/configuration/encryption' },
          ],
        },
      ],
      '/features/': [
        {
          text: 'Features',
          items: [
            { text: 'Overview', link: '/features/overview' },
            { text: 'Redaction', link: '/features/redaction' },
            { text: 'GLiNER LLM Detection', link: '/features/gliner' },
            { text: 'Reversible Redaction', link: '/features/reversible-redaction' },
            { text: 'Capture Logging', link: '/features/logging' },
            { text: 'Metrics & Monitoring', link: '/features/metrics' },
            { text: 'Rate Limiting', link: '/features/rate-limiting' },
            { text: 'Built-in Retry', link: '/features/retry' },
            { text: 'NVIDIA Worker Retry', link: '/features/nvidia-retry' },
            { text: 'OIDC Authentication', link: '/features/oidc' },
            { text: 'Encryption at Rest', link: '/features/encryption' },
          ],
        },
      ],
      '/api/': [
        {
          text: 'API Reference',
          items: [
            { text: 'Overview', link: '/api/overview' },
            { text: 'Proxy Endpoints', link: '/api/proxy-endpoints' },
            { text: 'Admin API', link: '/api/admin-api' },
            { text: 'Headers Reference', link: '/api/headers' },
            { text: 'Provider Configuration', link: '/api/providers' },
          ],
        },
      ],
      '/examples/': [
        {
          text: 'Examples',
          items: [
            { text: 'Redaction Policies', link: '/examples/redaction-policies' },
            { text: 'Docker Compose', link: '/examples/docker-compose' },
            { text: 'Custom Providers', link: '/examples/custom-providers' },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/rpowell01/contextio-next' },
      { icon: 'docker', link: 'https://github.com/rpowell01/contextio-next/pkgs/container/contextio-next' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Russell Powell. Forked from larsderidder/contextio.',
    },

    search: {
      provider: 'local',
    },

    editLink: {
      pattern: 'https://github.com/rpowell01/contextio-next/edit/main/website/docs/:path',
      text: 'Edit this page on GitHub',
    },

    outline: {
      level: [2, 3],
      label: 'On this page',
    },

    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },

    sidebarMenuLabel: 'Menu',
    returnToTopLabel: 'Return to top',
    darkModeSwitchLabel: 'Toggle dark mode',
    lastUpdatedText: 'Last updated',
  },

  markdown: {
    theme: 'github-dark',
    lineNumbers: true,
  },

  vite: {
    optimizeDeps: {
      include: ['vitepress'],
    },
  },
})