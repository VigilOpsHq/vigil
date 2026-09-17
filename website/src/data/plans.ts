// Prices are in USD: Bachs subscriptions bill USD cards.
// Each paid plan needs one Bachs product per billing interval. The checkout
// function looks them up as BACHS_PRODUCT_<PLAN>_<INTERVAL>, e.g. BACHS_PRODUCT_PRO_YEARLY.

export type Interval = 'monthly' | 'yearly';

export interface Plan {
  id: 'community' | 'pro' | 'team' | 'enterprise';
  name: string;
  tagline: string;
  price: { monthly: number; yearly: number } | null;
  priceNote?: string;
  cta: { label: string; kind: 'install' | 'checkout' | 'contact' };
  highlight?: boolean;
  features: string[];
}

export const plans: Plan[] = [
  {
    id: 'community',
    name: 'Community',
    tagline: 'Everything VigilOps does, on your own servers.',
    price: { monthly: 0, yearly: 0 },
    priceNote: 'Free forever',
    cta: { label: 'Install', kind: 'install' },
    features: [
      'Unlimited servers',
      'Monitoring and automatic fixes',
      'Database backups, schedules and restores',
      'Backups to your own S3-compatible storage',
      'Telegram bot and CLI',
      'Deploys with rollback',
      'Community support on GitHub',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    tagline: 'For a business that runs on a few servers.',
    price: { monthly: 19, yearly: 190 },
    cta: { label: 'Start Pro', kind: 'checkout' },
    highlight: true,
    features: [
      'Everything in Community',
      'Priority email support, reply within 1 business day',
      'Supported on up to 5 servers',
      'Help setting up backups and off-server storage',
      'Early access to VigilOps Cloud features',
      'Founding price, locked while you stay subscribed',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    tagline: 'For teams with more servers and less time.',
    price: { monthly: 49, yearly: 490 },
    cta: { label: 'Start Team', kind: 'checkout' },
    features: [
      'Everything in Pro',
      'Supported on up to 20 servers',
      'Reply within 4 business hours',
      'Onboarding call for your team',
      'Shared support chat',
      'Founding price, locked while you stay subscribed',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Custom terms, more servers, or special requirements.',
    price: null,
    priceNote: 'Custom',
    cta: { label: 'Contact us', kind: 'contact' },
    features: [
      'Everything in Team',
      'Unlimited supported servers',
      'Response-time commitment in your contract',
      'Help with custom rules and integrations',
      'Invoicing and custom payment terms',
    ],
  },
];

export interface ComparisonRow {
  label: string;
  soon?: boolean;
  values: [string | boolean, string | boolean, string | boolean, string | boolean];
}

export const comparison: { group: string; rows: ComparisonRow[] }[] = [
  {
    group: 'Product',
    rows: [
      { label: 'Monitoring and automatic fixes', values: [true, true, true, true] },
      { label: 'Database backups and restores', values: [true, true, true, true] },
      { label: 'Telegram bot and CLI', values: [true, true, true, true] },
      { label: 'Deploys with rollback', values: [true, true, true, true] },
      { label: 'Servers', values: ['Unlimited', 'Unlimited', 'Unlimited', 'Unlimited'] },
    ],
  },
  {
    group: 'VigilOps Cloud',
    rows: [
      { label: 'Managed backup storage', soon: true, values: [false, 'Early access', 'Early access', 'Early access'] },
      { label: 'Web dashboard for backups', soon: true, values: [false, 'Early access', 'Early access', 'Early access'] },
      { label: 'Official Telegram bot, no setup', soon: true, values: [false, 'Early access', 'Early access', 'Early access'] },
      { label: 'AI included, no API key needed', soon: true, values: [false, 'Early access', 'Early access', 'Early access'] },
    ],
  },
  {
    group: 'Support',
    rows: [
      { label: 'Channel', values: ['GitHub issues', 'Email', 'Email and shared chat', 'Dedicated contact'] },
      { label: 'Response time', values: ['Best effort', '1 business day', '4 business hours', 'Per contract'] },
      { label: 'Servers covered', values: ['—', 'Up to 5', 'Up to 20', 'Unlimited'] },
      { label: 'Setup help', values: [false, 'Backups and storage', 'Onboarding call', 'Custom'] },
    ],
  },
];

export const faqs = [
  {
    q: 'Is VigilOps really free?',
    a: 'Yes. The self-hosted version is open source under the MIT license, with no server limits and no features held back. Paid plans add support and early access to VigilOps Cloud.',
  },
  {
    q: 'What is VigilOps Cloud?',
    a: 'A hosted service we are building on top of VigilOps: backup storage run by us, a web dashboard to see and download every backup, and an official Telegram bot and AI, so there are no tokens or keys to set up. Pro and Team subscribers get each feature as it launches.',
  },
  {
    q: 'What does "supported on up to 5 servers" mean?',
    a: 'VigilOps runs on as many servers as you like on every plan. The number is how many servers we help you with under your support plan.',
  },
  {
    q: 'How do I pay?',
    a: 'By card, through our payment provider Bachs. Plans renew automatically every month or year until you cancel.',
  },
  {
    q: 'Can I cancel?',
    a: 'Yes, at any time. Your plan stays active until the end of the period you have paid for. See the refund policy for details.',
  },
  {
    q: 'Do you see my data?',
    a: 'Not with self-hosted VigilOps: it runs on your server and sends backups only where you configure. We will publish exactly how VigilOps Cloud stores and protects backups before it launches.',
  },
];
