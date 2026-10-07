/**
 * Single source of truth for what the platform actually ships today.
 *
 * The public marketing page and the authenticated `/api/capabilities` endpoint
 * both read this list, so a feature can never be advertised on the site while
 * the API reports it as unavailable.
 */
export interface CapabilityDefinition {
  id: string;
  label: string;
  description: string;
  /** `mvp` ships, `v1`/`v2` are on the roadmap, `prototype-only` is experimental. */
  phase: 'mvp' | 'v1' | 'v2' | 'prototype-only';
  available: boolean;
}

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: 'web-chat',
    label: 'Web chat widget',
    description:
      'Embeddable widget that opens a real conversation against your knowledge base.',
    phase: 'mvp',
    available: true,
  },
  {
    id: 'paste-text',
    label: 'Paste text',
    description:
      'Turn pasted FAQ or policy text into an indexed source instantly.',
    phase: 'mvp',
    available: true,
  },
  {
    id: 'pdf-docx-markdown',
    label: 'PDF, DOCX & Markdown',
    description:
      'Upload documents; the server extracts text, chunks and embeds it.',
    phase: 'mvp',
    available: true,
  },
  {
    id: 'csv-xlsx-ingestion',
    label: 'CSV / XLSX ingestion',
    description: 'Spreadsheet import with column mapping.',
    phase: 'prototype-only',
    available: false,
  },
  {
    id: 'url-ingestion',
    label: 'URL ingestion',
    description: 'Crawl a documentation site into the knowledge base.',
    phase: 'v2',
    available: false,
  },
  {
    id: 'notion-sync',
    label: 'Notion sync',
    description: 'Two-way sync with a Notion workspace.',
    phase: 'v1',
    available: false,
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp Business',
    description: 'Native WhatsApp channel via the Business Cloud API.',
    phase: 'v1',
    available: false,
  },
  {
    id: 'email',
    label: 'Email channel',
    description: 'Shared inbox that turns email threads into conversations.',
    phase: 'v2',
    available: false,
  },
  {
    id: 'telegram',
    label: 'Telegram channel',
    description: 'Telegram bot channel.',
    phase: 'prototype-only',
    available: false,
  },
  {
    id: 'ai-coach',
    label: 'AI coach',
    description: 'Reply suggestions and tone coaching for human agents.',
    phase: 'v2',
    available: false,
  },
  {
    id: 'webhooks',
    label: 'Webhooks',
    description: 'Outbound webhooks for conversation lifecycle events.',
    phase: 'v2',
    available: false,
  },
  {
    id: 'export',
    label: 'Scheduled data export',
    description: 'Scheduled CSV/Parquet export to object storage.',
    phase: 'v1',
    available: false,
  },
  {
    id: 'data-erasure',
    label: 'GDPR erasure workflow',
    description: 'Verified right-to-erasure requests across all tenant data.',
    phase: 'v1',
    available: false,
  },
];

export const AVAILABLE_CAPABILITIES = CAPABILITIES.filter(
  (capability) => capability.available,
);
