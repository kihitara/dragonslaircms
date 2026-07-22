// Schemas that drive the recursive config editor (public/js/config-editor.js).
// Field types: text | textarea | boolean | select | group (nested object) |
// list (repeatable; itemFields can themselves be lists → nesting).
//
// The admin page injects a schema + the current site_config JSON as
// window.__SCHEMA / window.__CONFIG; the editor round-trips the value through
// the hidden #config-json input, so these shapes ARE the stored JSON shapes
// (they must agree with what src/templates/base.js renders).

export const NAV_SCHEMA = {
  fields: [
    { key: 'items', label: 'Menu items', itemLabel: 'menu item', type: 'list', collapsible: true, summaryKey: 'label', itemFields: [
      { key: 'label', label: 'Label', type: 'text' },
      { key: 'href', label: 'URL (e.g. /about)', type: 'text' },
      // One level of children only — the site header renders a single dropdown.
      { key: 'children', label: 'Dropdown links (optional, one level)', itemLabel: 'link', type: 'list', itemFields: [
        { key: 'label', label: 'Label', type: 'text' },
        { key: 'href', label: 'URL', type: 'text' },
      ] },
    ] },
  ],
};

export const NAV_DEFAULT = { items: [] };

export const FOOTER_SCHEMA = {
  fields: [
    { key: 'columns', label: 'Footer columns', itemLabel: 'column', type: 'list', collapsible: true, summaryKey: 'title', itemFields: [
      { key: 'title', label: 'Column title', type: 'text' },
      { key: 'links', label: 'Links', itemLabel: 'link', type: 'list', itemFields: [
        { key: 'label', label: 'Label', type: 'text' },
        { key: 'href', label: 'URL', type: 'text' },
      ] },
    ] },
    { key: 'note', label: 'Footer note (bottom bar; falls back to the org tagline)', type: 'text' },
  ],
};

export const FOOTER_DEFAULT = { columns: [], note: '' };

export const FONTS_SCHEMA = {
  fields: [
    { key: 'faces', label: 'Font faces (@font-face rules in /theme.css)', itemLabel: 'font face', type: 'list', itemFields: [
      { key: 'family', label: 'Family name — must match the family used in Branding fonts (e.g. MyDisplayFont)', type: 'text' },
      { key: 'file', label: 'Font file URL (/media/fonts/… from an upload, or any URL; .woff2 recommended, .woff/.ttf/.otf also work)', type: 'text' },
      { key: 'weight', label: 'Weight (400 = normal, 700 = bold; or a range like "100 900" for a variable font)', type: 'text' },
      { key: 'style', label: 'Style', type: 'select', options: [
        { value: 'normal', label: 'Normal' },
        { value: 'italic', label: 'Italic' },
      ] },
    ] },
  ],
};

export const FONTS_DEFAULT = { faces: [] };
