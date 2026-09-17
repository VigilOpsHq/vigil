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
      'VigilOps Cloud for up to 5 servers',
      '50 GB managed backup storage, kept 30 days',
      'Dashboard to see and download every backup',
      'Alerts when a server goes offline or a backup is missed',
      'Priority email support, reply within 1 business day',
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
      'VigilOps Cloud for up to 20 servers',
      '250 GB managed backup storage, kept 90 days',
      'Support reply within 4 business hours',
      'Onboarding call for your team',
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
      'More servers, storage and retention',
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
      { label: 'Connected servers', values: [false, 'Up to 5', 'Up to 20', 'Custom'] },
      { label: 'Managed backup storage', values: [false, '50 GB', '250 GB', 'Custom'] },
      { label: 'Backup retention', values: [false, '30 days', '90 days', 'Custom'] },
      { label: 'Dashboard: every backup, download from anywhere', values: [false, true, true, true] },
      { label: 'Server offline alerts', values: [false, true, true, true] },
      { label: 'Missed backup alerts', values: [false, true, true, true] },
      { label: 'Alerts from the official VigilOps bot', values: [false, true, true, true] },
      { label: 'AI included, no API key needed', soon: true, values: [false, true, true, true] },
    ],
  },
  {
    group: 'Support',
    rows: [
      { label: 'Channel', values: ['GitHub issues', 'Email', 'Email and shared chat', 'Dedicated contact'] },
      { label: 'Response time', values: ['Best effort', '1 business day', '4 business hours', 'Per contract'] },
      { label: 'Setup help', values: [false, 'Backups and storage', 'Onboarding call', 'Custom'] },
    ],
  },
];

export const faqs = [
  {
    q: 'Is VigilOps really free?',
    a: 'Yes. The self-hosted version is open source under the MIT license, with no server limits and no features held back. Paid plans add VigilOps Cloud and priority support.',
  },
  {
    q: 'What is VigilOps Cloud?',
    a: 'The hosted side of VigilOps for Pro and Team. Connect a server with one command and every backup is also stored by us, visible and downloadable from your dashboard. We watch your servers from outside and alert you on Telegram when one stops checking in or a scheduled backup does not arrive, which a server cannot do for itself when it is down.',
  },
  {
    q: 'What does "up to 5 servers" mean?',
    a: 'VigilOps itself runs on as many servers as you like on every plan. The number is how many servers you can connect to VigilOps Cloud, and cover with support.',
  },
  {
    q: 'How do I start after paying?',
    a: 'Sign in at vigilops.cloud/app with GitHub, using an account that has the email you paid with. Your plan unlocks automatically, and you can add your first server straight away. Payments are by card through our payment provider Bachs and renew until you cancel.',
  },
  {
    q: 'Can I cancel?',
    a: 'Yes, at any time. Your plan stays active until the end of the period you have paid for. See the refund policy for details.',
  },
  {
    q: 'Do you see my data?',
    a: 'Not with self-hosted VigilOps: it runs on your server and sends backups only where you configure. Backups you store in VigilOps Cloud are kept in Cloudflare R2, private to your account, and deleted when their retention period ends or you remove them.',
  },
];
