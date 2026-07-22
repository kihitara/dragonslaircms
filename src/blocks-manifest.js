// Block editing schema — drives the admin page editor's forms. This is the
// parallel of the runtime render registry (src/templates/blocks.js): adding a
// block = a renderer there + an entry here. Field types:
//   text | textarea | richtext | number | boolean | select | media | date | list (repeatable)
// 'media' is an image/file URL (rendered as a text input in the editor).
//
// Structured blocks (grids, tables, steps, columns) support an optional
// `intro` (rich text above the content) and `outro` (rich text below) — each
// renders nothing when blank.

// Background surfaces every block can pick (generated .surface-* classes from
// Admin > Palette). '' = the block's own natural default.
export const SURFACES = [
  { value: '', label: 'Auto (block default)' },
  { value: 'default', label: 'Default (page)' },
  { value: 'muted', label: 'Muted grey' },
  { value: 'soft', label: 'Soft purple' },
  { value: 'green', label: 'Soft green' },
  { value: 'brand', label: 'Brand purple' },
  { value: 'dark', label: 'Slate dark' },
];

// Per-card background options for the feature grid. '' = the default panel card;
// any other value renders the card as a big surface-coloured block.
const CARD_SURFACES = [
  { value: '', label: 'Default card (panel)' },
  { value: 'none', label: 'None (no background)' },
  { value: 'default', label: 'Default (page)' },
  { value: 'muted', label: 'Muted grey' },
  { value: 'soft', label: 'Soft purple' },
  { value: 'green', label: 'Soft green' },
  { value: 'brand', label: 'Brand purple' },
  { value: 'dark', label: 'Slate dark' },
];

// Named inline-SVG icons cards can use (themeable — they take the card colour).
// MUST stay in sync with the ICONS registry in src/templates/blocks.js.
export const ICON_NAMES = ['heart', 'shield-check', 'lightbulb', 'rocket', 'chart-up', 'users', 'star', 'globe'];
const ICON_OPTIONS = [{ value: '', label: '— None —' }].concat(ICON_NAMES.map((n) => ({ value: n, label: n })));

const OVERLAY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'palette', label: 'Palette colour' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const CTA_FIELDS = [
  { key: 'label', label: 'Label', type: 'text' },
  { key: 'href', label: 'Link', type: 'text' },
  { key: 'style', label: 'Style', type: 'select', options: ['primary', 'secondary'] },
];

export const BLOCK_MANIFEST = {
  hero: {
    label: 'Hero',
    fields: [
      { key: 'eyebrow', label: 'Eyebrow', type: 'text' },
      { key: 'heading', label: 'Heading', type: 'text' },
      { key: 'subheading', label: 'Subheading', type: 'richtext' },
      { key: 'ctas', label: 'Buttons', type: 'list', itemFields: CTA_FIELDS },
      { key: 'bgImage', label: 'Background image (optional)', type: 'media' },
      { key: 'overlay', label: 'Background overlay (only applies with a background image)', type: 'select', options: OVERLAY_OPTIONS },
    ],
  },
  featureGrid: {
    label: 'Feature grid',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'columns', label: 'Columns (1–4)', type: 'number', default: 3 },
      { key: 'textSize', label: 'Text size', type: 'select', options: [{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large (hero)' }] },
      { key: 'iconSize', label: 'Icon size', type: 'select', options: [{ value: 'sm', label: 'Small' }, { value: 'lg', label: 'Medium' }, { value: 'xl', label: 'Large' }] },
      { key: 'iconBadge', label: 'Icon badge', type: 'select', options: [{ value: 'none', label: 'None' }, { value: 'circle', label: 'Soft circle' }, { value: 'solid', label: 'Solid circle' }] },
      { key: 'iconPosition', label: 'Icon position', type: 'select', options: [{ value: 'top', label: 'Top' }, { value: 'left', label: 'Left (beside content)' }] },
      { key: 'align', label: 'Card alignment (horizontal)', type: 'select', options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centred' }] },
      { key: 'valign', label: 'Text alignment (vertical, when cards differ in height)', type: 'select', options: [{ value: 'top', label: 'Top' }, { value: 'middle', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }] },
      { key: 'items', label: 'Cards', type: 'list', itemFields: [
        { key: 'body', label: 'Content (rich text — add a heading here if you want one)', type: 'richtext' },
        { key: 'surface', label: 'Card background', type: 'select', options: CARD_SURFACES },
        { key: 'image', label: 'Media image (fills card; also the video poster)', type: 'media' },
        { key: 'alt', label: 'Image alt text (describe the image for SEO/accessibility)', type: 'text' },
        { key: 'video', label: 'Video (mp4/webm — plays with the image as its cover)', type: 'media' },
        { key: 'iconName', label: 'Icon (named, themeable)', type: 'select', options: ICON_OPTIONS },
        { key: 'icon', label: 'Or icon image', type: 'media' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  richText: {
    label: 'Rich text',
    fields: [
      { key: 'html', label: 'Content (HTML)', type: 'richtext' },
    ],
  },
  ctaBanner: {
    label: 'CTA banner',
    fields: [
      { key: 'body', label: 'Content (rich text — add a heading if you want one)', type: 'richtext' },
      { key: 'ctas', label: 'Buttons', type: 'list', itemFields: CTA_FIELDS },
      { key: 'bgImage', label: 'Background image (optional)', type: 'media' },
      { key: 'overlay', label: 'Background overlay (only applies with a background image)', type: 'select', options: OVERLAY_OPTIONS },
    ],
  },
  teamGrid: {
    label: 'Team grid',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'members', label: 'People (by slug; leave empty for everyone)', type: 'list', itemFields: [
        { key: 'slug', label: 'Person slug', type: 'text' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  statGrid: {
    label: 'Stat grid',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'items', label: 'Stats', type: 'list', itemFields: [
        { key: 'value', label: 'Value (e.g. $935b)', type: 'text' },
        { key: 'label', label: 'Label', type: 'text' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  logoStrip: {
    label: 'Logo strip',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'logoSize', label: 'Logo height', type: 'select', options: [
        { value: 'small', label: 'Small (~64px)' },
        { value: 'medium', label: 'Medium (~96px)' },
        { value: 'large', label: 'Large (~144px)' },
      ] },
      { key: 'logos', label: 'Logos', type: 'list', itemFields: [
        { key: 'src', label: 'Image', type: 'media' },
        { key: 'alt', label: 'Alt text', type: 'text' },
        { key: 'href', label: 'Link (optional)', type: 'text' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  numberedSteps: {
    label: 'Numbered steps',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'columns', label: 'Columns (1–4)', type: 'number', default: 3 },
      { key: 'numberStyle', label: 'Markers', type: 'select', options: [
        { value: 'numeric', label: 'Numbers (01, 02)' },
        { value: 'alpha', label: 'Letters (A, B)' },
        { value: 'none', label: 'No markers' },
      ] },
      { key: 'steps', label: 'Steps', type: 'list', itemFields: [
        { key: 'body', label: 'Content (rich text — add a heading if you want one)', type: 'richtext' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  twoColumn: {
    label: 'Two columns',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'leftBody', label: 'Left column (rich text)', type: 'richtext' },
      { key: 'rightBody', label: 'Right column (rich text)', type: 'richtext' },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  comparisonTable: {
    label: 'Comparison table',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'columns', label: 'Columns', type: 'select', options: [
        { value: '2', label: '2 columns' }, { value: '3', label: '3 columns' }, { value: '4', label: '4 columns' },
      ] },
      { key: 'rowLabels', label: 'Use row labels (a header column down the left)', type: 'boolean' },
      { key: 'col1Label', label: 'Column 1 label (e.g. Before)', type: 'text' },
      { key: 'col2Label', label: 'Column 2 label (e.g. After)', type: 'text' },
      { key: 'col3Label', label: 'Column 3 label', type: 'text', showIf: { prop: 'columns', gte: 3 } },
      { key: 'col4Label', label: 'Column 4 label', type: 'text', showIf: { prop: 'columns', gte: 4 } },
      { key: 'rows', label: 'Rows', type: 'list', itemFields: [
        { key: 'label', label: 'Row label', type: 'text', showIf: { prop: 'rowLabels', truthy: true } },
        { key: 'col1', label: 'Column 1 cell', type: 'richtext' },
        { key: 'col2', label: 'Column 2 cell', type: 'richtext' },
        { key: 'col3', label: 'Column 3 cell', type: 'richtext', showIf: { prop: 'columns', gte: 3 } },
        { key: 'col4', label: 'Column 4 cell', type: 'richtext', showIf: { prop: 'columns', gte: 4 } },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  faq: {
    label: 'FAQ',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'items', label: 'Questions', type: 'list', itemFields: [
        { key: 'question', label: 'Question', type: 'text' },
        { key: 'answer', label: 'Answer', type: 'richtext' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  pullQuote: {
    label: 'Pull quote',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'quote', label: 'Quote', type: 'richtext' },
      { key: 'attribution', label: 'Attribution (optional)', type: 'text' },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  media: {
    label: 'Image',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'src', label: 'Image', type: 'media' },
      { key: 'alt', label: 'Alt text (describe the image for SEO/accessibility)', type: 'text' },
      { key: 'caption', label: 'Caption (optional)', type: 'text' },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  capabilityList: {
    label: 'Capability list',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'columns', label: 'Columns (1–2)', type: 'number', default: 1 },
      { key: 'items', label: 'Capabilities', type: 'list', itemFields: [
        { key: 'text', label: 'Capability', type: 'text' },
        { key: 'description', label: 'Detail (optional)', type: 'richtext' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  timeline: {
    label: 'Timeline',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'aside', label: 'Side panel (optional rich text — shown beside the timeline; leave blank for full width)', type: 'richtext' },
      { key: 'asidePosition', label: 'Side panel position', type: 'select', options: [{ value: 'left', label: 'Left of timeline' }, { value: 'right', label: 'Right of timeline' }] },
      { key: 'items', label: 'Milestones', type: 'list', itemFields: [
        { key: 'date', label: 'Date (e.g. Jan 2026)', type: 'text' },
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'body', label: 'Body', type: 'richtext' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  relatedContent: {
    label: 'Related links',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'columns', label: 'Columns (2–3)', type: 'number', default: 3 },
      { key: 'items', label: 'Links', type: 'list', itemFields: [
        { key: 'title', label: 'Title', type: 'text' },
        { key: 'blurb', label: 'Blurb (optional)', type: 'richtext' },
        { key: 'href', label: 'Link URL', type: 'text' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  vacancies: {
    label: 'Vacancies',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'items', label: 'Roles', type: 'list', itemFields: [
        { key: 'title', label: 'Job title', type: 'text' },
        { key: 'department', label: 'Department (e.g. Engineering)', type: 'text' },
        { key: 'location', label: 'Location (e.g. Wellington, NZ — or Remote)', type: 'text' },
        { key: 'employmentType', label: 'Employment type', type: 'select', options: [
          { value: '', label: '— Select —' },
          { value: 'FULL_TIME', label: 'Full-time' },
          { value: 'PART_TIME', label: 'Part-time' },
          { value: 'CONTRACTOR', label: 'Contract' },
          { value: 'TEMPORARY', label: 'Temporary' },
          { value: 'INTERN', label: 'Internship' },
          { value: 'VOLUNTEER', label: 'Volunteer' },
          { value: 'OTHER', label: 'Other' },
        ] },
        { key: 'date', label: 'Date posted (YYYY-MM-DD)', type: 'text' },
        { key: 'closing_date', label: 'Closing date', type: 'date' },
        { key: 'description', label: 'Description (feeds Google job-search data — not shown on the card)', type: 'textarea' },
        { key: 'image', label: 'Thumbnail image (optional)', type: 'media' },
        { key: 'href', label: 'Apply link (external URL)', type: 'text' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  gallery: {
    label: 'Gallery',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'items', label: 'Media', type: 'list', itemFields: [
        { key: 'file', label: 'Image or video file', type: 'media' },
        { key: 'cover', label: 'Cover image (used only when the file is a video — also the poster)', type: 'media' },
        { key: 'alt', label: 'Alt text (required — describe the media for SEO/accessibility)', type: 'text' },
        { key: 'caption', label: 'Caption (rich text, optional)', type: 'richtext' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },

  tabs: {
    label: 'Tabbed content',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'grouped', label: 'Grouped tabs (collapsible groups, like an accordion)', type: 'boolean' },
      { key: 'tabPosition', label: 'Tab position', type: 'select', options: [{ value: 'top', label: 'Top' }, { value: 'left', label: 'Left' }], showIf: { prop: 'grouped', falsy: true } },
      { key: 'tabs', label: 'Tabs', type: 'list', itemFields: [
        { key: 'title', label: 'Tab title (label only — not a heading)', type: 'text' },
        { key: 'group', label: 'Group (tabs sharing a group name collapse under it)', type: 'text', showIf: { prop: 'grouped', truthy: true } },
        { key: 'body', label: 'Tab content (rich text — add headings here)', type: 'richtext' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  embed: {
    label: 'Embed / Code',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'embedCode', label: 'Embed code — paste an iframe / form / script (leave blank if using a file URL)', type: 'textarea' },
      { key: 'fileUrl', label: 'Or a file (HTML or PDF) to show inline — paste a URL', type: 'media' },
      { key: 'title', label: 'Accessible title (for screen readers)', type: 'text' },
      { key: 'height', label: 'Height (always full width)', type: 'select', options: [
        { value: 'auto', label: 'Auto (follow the content / PDF page)' },
        { value: 'small', label: 'Small (~400px)' },
        { value: 'medium', label: 'Medium (~640px)' },
        { value: 'large', label: 'Large (~900px)' },
        { value: 'full', label: 'Tall (80% of screen)' },
      ] },
      { key: 'aside', label: 'Side panel (optional rich text — shown beside the embed; leave blank for full width)', type: 'richtext' },
      { key: 'asidePosition', label: 'Side panel position', type: 'select', options: [{ value: 'left', label: 'Left of embed' }, { value: 'right', label: 'Right of embed' }] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
  articles: {
    label: 'Articles',
    fields: [
      { key: 'intro', label: 'Intro (optional)', type: 'richtext' },
      { key: 'category', label: 'Category', type: 'select', options: [
        { value: 'all', label: 'All categories' },
        { value: 'blog', label: 'Blog' },
        { value: 'news', label: 'News' },
      ] },
      // Featured options are replaced with the live published-article list by the
      // page editor (admin-pages.js); the default below is the offline fallback.
      { key: 'featured', label: 'Featured article (large lead tile)', type: 'select', options: [
        { value: '', label: 'Most recent (auto)' },
      ] },
      { key: 'count', label: 'Number of articles', type: 'select', options: [
        { value: '3', label: '3 (featured + 2)' },
        { value: '7', label: '7 (featured + 2, plus 4 in a row below)' },
      ] },
      { key: 'outro', label: 'Closing text (optional)', type: 'richtext' },
    ],
  },
};
