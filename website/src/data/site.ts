export const site = {
  name: 'VigilOps',
  url: 'https://vigilops.cloud',
  github: 'https://github.com/VigilOpsHq/vigil',
  releases: 'https://github.com/VigilOpsHq/vigil/releases',
  issues: 'https://github.com/VigilOpsHq/vigil/issues',
  install: 'curl -fsSL https://vigilops.cloud/install.sh | sudo sh',
};

// Shown on the legal and contact pages. Anything still in [brackets] makes
// those pages display a "draft" notice, so fill these in before going live.
export const company = {
  legalName: '[Registered business name]',
  address: '[Registered business address]',
  country: '[Country of registration]',
  contactEmail: 'hello@vigilops.cloud',
  supportEmail: 'support@vigilops.cloud',
  legalUpdated: '17 September 2026',
};

export const hasPlaceholders = Object.values(company).some((v) => /\[.+\]/.test(v));
