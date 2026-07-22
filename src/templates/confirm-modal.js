// Shared <head> snippet for the styled confirm/alert modal (window.confirmModal,
// public/js/confirm-modal.js). Any admin page rendering [data-confirm] forms or
// buttons appends this to its extraHead — the base admin shell stays untouched.
// Deferred script: the interceptors only matter once the user can interact.
export const CONFIRM_MODAL_HEAD = '<link rel="stylesheet" href="/css/confirm-modal.css"><script src="/js/confirm-modal.js" defer></script>';
