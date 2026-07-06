/*
 * DataPurge - affiliate & outbound click tracking via Plausible custom events.
 * CSP-safe: same-origin script (script-src 'self'), no inline handlers.
 * Cookieless and no PII - only the destination host/path and the source page.
 *
 * Fires:
 *   "Affiliate Click"  - links marked rel="sponsored" (our affiliate links)
 *   "Outbound Link"    - any other click that leaves the site
 * Internal navigation is left to normal Plausible pageviews.
 */
(function () {
  // Stub so any event triggered before the Plausible script finishes loading is queued.
  window.plausible = window.plausible || function () {
    (window.plausible.q = window.plausible.q || []).push(arguments);
  };

  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href]');
    if (!link) return;

    var url;
    try { url = new URL(link.href, window.location.href); } catch (err) { return; }

    // Only track links that leave this site over http(s).
    if (!/^https?:$/.test(url.protocol)) return;
    if (url.hostname === window.location.hostname) return;

    var isAffiliate = /(^|\s)sponsored(\s|$)/i.test(link.getAttribute('rel') || '');
    var host = url.hostname.replace(/^www\./, '');

    window.plausible(isAffiliate ? 'Affiliate Click' : 'Outbound Link', {
      props: {
        service: host,
        destination: host + url.pathname,
        from: window.location.pathname
      }
    });
  }, true);
})();
