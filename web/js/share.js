/**
 * DataPurge Share — Embed instructions & sharing options
 */

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function showToast(message) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2500);
}

const SITE_URL = 'https://datapurge.iamnottheproduct.com';
const REPO_URL = 'https://github.com/puurpl/datapurge';
const DONATE_URL = 'https://buymeacoffee.com/puurpl';

const IFRAME_SNIPPET = `<iframe
  src="${SITE_URL}/embed.html"
  style="width: 100%; height: 700px; border: 1px solid #e2e8f0; border-radius: 12px;"
  title="DataPurge — Data Broker Opt-Out Tool"
  allow="clipboard-write"
  loading="lazy">
</iframe>`;

const SHARE_TEXT = 'Remove your personal data from 200+ data brokers for free. DataPurge generates legally-backed opt-out emails.';
const SHARE_TITLE = 'DataPurge — Free Data Broker Opt-Out Tool';

export const Share = {
    render(container) {
        container.innerHTML = `
            <h2 class="mb-2">Share & Embed</h2>

            <p class="text-secondary mb-2">
                Help others take back their data. Share DataPurge or embed the tool on your website.
            </p>

            <!-- Quick share -->
            <div class="card mb-2">
                <div class="card-header">
                    <div class="card-title">Share DataPurge</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    Every person who sends opt-out requests increases the cost for data brokers to operate.
                </p>
                <div class="share-buttons">
                    <button class="btn btn-outline btn-sm" id="btn-share-copy" title="Copy link">
                        &#128279; Copy Link
                    </button>
                    <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SITE_URL)}"
                        class="btn btn-outline btn-sm" target="_blank" rel="noopener" title="Share on X/Twitter">
                        &#120143; Post on X
                    </a>
                    <a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(SITE_URL)}"
                        class="btn btn-outline btn-sm" target="_blank" rel="noopener" title="Share on Facebook">
                        &#102; Facebook
                    </a>
                    <a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SITE_URL)}"
                        class="btn btn-outline btn-sm" target="_blank" rel="noopener" title="Share on LinkedIn">
                        &#128100; LinkedIn
                    </a>
                    <a href="https://www.reddit.com/submit?url=${encodeURIComponent(SITE_URL)}&title=${encodeURIComponent(SHARE_TITLE)}"
                        class="btn btn-outline btn-sm" target="_blank" rel="noopener" title="Share on Reddit">
                        &#9650; Reddit
                    </a>
                    <a href="mailto:?subject=${encodeURIComponent(SHARE_TITLE)}&body=${encodeURIComponent(SHARE_TEXT + '\n\n' + SITE_URL)}"
                        class="btn btn-outline btn-sm" title="Share via email">
                        &#9993; Email
                    </a>
                </div>
                <div id="native-share-slot" class="mt-1"></div>
            </div>

            <!-- Embed -->
            <div class="card mb-2">
                <div class="card-header">
                    <div class="card-title">Embed on Your Website</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    Add the data broker opt-out tool to any website with a single line of HTML.
                    Works on WordPress, Squarespace, Wix, Webflow, Ghost, or any platform.
                </p>

                <h4 class="mt-2 mb-1">iframe Embed (Recommended)</h4>
                <p class="text-sm text-secondary mb-1">
                    Paste this into your HTML. Your visitors' data stays in their browser —
                    the iframe's same-origin policy prevents your site from accessing it.
                </p>
                <div class="embed-code-block">
                    <pre class="embed-code"><code>${esc(IFRAME_SNIPPET)}</code></pre>
                    <button class="btn btn-outline btn-sm" id="btn-copy-iframe">Copy Snippet</button>
                </div>

                <div class="embed-preview-wrapper mt-2">
                    <h4 class="mb-1">Preview</h4>
                    <div class="embed-preview">
                        <iframe
                            src="embed.html"
                            style="width: 100%; height: 400px; border: none; border-radius: 8px;"
                            title="Embed preview"
                            loading="lazy">
                        </iframe>
                    </div>
                </div>

                <details class="mt-2">
                    <summary class="text-sm text-secondary" style="cursor: pointer;">
                        Platform-specific instructions
                    </summary>
                    <div class="callout mt-1" style="text-align: left; padding: 1rem;">
                        <div class="platform-list">
                            <div class="platform-item">
                                <strong>WordPress</strong>
                                <span class="text-sm text-secondary">Custom HTML block, paste the iframe code.</span>
                            </div>
                            <div class="platform-item">
                                <strong>Squarespace</strong>
                                <span class="text-sm text-secondary">Add a Code Block, paste the iframe code.</span>
                            </div>
                            <div class="platform-item">
                                <strong>Webflow</strong>
                                <span class="text-sm text-secondary">Add an Embed element, paste the iframe code.</span>
                            </div>
                            <div class="platform-item">
                                <strong>Wix</strong>
                                <span class="text-sm text-secondary">Add an HTML iframe element, paste the src URL.</span>
                            </div>
                            <div class="platform-item">
                                <strong>Ghost</strong>
                                <span class="text-sm text-secondary">Use an HTML card, paste the iframe code.</span>
                            </div>
                            <div class="platform-item">
                                <strong>React / Next.js / Vue</strong>
                                <span class="text-sm text-secondary">Paste the iframe directly into a component. No wrapper needed.</span>
                            </div>
                        </div>
                    </div>
                </details>
            </div>

            <!-- Self-hosted -->
            <div class="card mb-2">
                <div class="card-header">
                    <div class="card-title">Self-Hosted Embed</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    Prefer to serve from your own domain? Download a single HTML file that
                    pulls assets from our CDN — always up to date, nothing to maintain.
                </p>
                <div class="btn-group">
                    <a href="${SITE_URL}/datapurge-embed.html" class="btn btn-outline btn-sm"
                        download="datapurge-embed.html">
                        Download datapurge-embed.html
                    </a>
                    <a href="${REPO_URL}" class="btn btn-outline btn-sm" target="_blank" rel="noopener">
                        Clone from GitHub
                    </a>
                </div>
            </div>

            <!-- Terms -->
            <div class="card mb-2">
                <div class="card-header">
                    <div class="card-title">Terms of Use</div>
                </div>
                <div class="text-sm text-secondary">
                    <ul class="tou-list">
                        <li><strong>Attribution required.</strong> Keep the "Powered by DataPurge" footer visible.</li>
                        <li><strong>Don't modify legal templates.</strong> The opt-out email text must remain intact.</li>
                        <li><strong>Don't misrepresent.</strong> Say "powered by DataPurge", not "our tool".</li>
                        <li><strong>Don't intercept data.</strong> The iframe protects user PII — don't circumvent it.</li>
                        <li><strong>Keep it free.</strong> Don't paywall access to the opt-out tool.</li>
                    </ul>
                    <p class="mt-1">
                        Full terms and technical details:
                        <a href="${REPO_URL}/blob/main/embed.md" target="_blank" rel="noopener">embed.md on GitHub</a>
                    </p>
                </div>
            </div>

            <!-- Support -->
            <div class="card">
                <div class="card-header">
                    <div class="card-title">Support the Project</div>
                </div>
                <p class="text-sm text-secondary mb-1">
                    DataPurge is free and open-source. If it helped you or your visitors,
                    consider supporting continued development.
                </p>
                <div class="btn-group">
                    <a href="${DONATE_URL}" class="btn btn-primary btn-sm" target="_blank" rel="noopener">
                        Support DataPurge
                    </a>
                    <a href="${REPO_URL}" class="btn btn-outline btn-sm" target="_blank" rel="noopener">
                        Star on GitHub
                    </a>
                </div>
            </div>
        `;

        // Copy link
        container.querySelector('#btn-share-copy').addEventListener('click', () => {
            navigator.clipboard.writeText(SITE_URL).then(() => showToast('Link copied'));
        });

        // Copy iframe snippet
        container.querySelector('#btn-copy-iframe').addEventListener('click', () => {
            navigator.clipboard.writeText(IFRAME_SNIPPET).then(() => showToast('Embed code copied'));
        });

        // Native Web Share API (mobile)
        const nativeSlot = container.querySelector('#native-share-slot');
        if (navigator.share) {
            nativeSlot.innerHTML = `
                <button class="btn btn-primary btn-sm" id="btn-native-share" style="width: 100%;">
                    Share via your device
                </button>
            `;
            nativeSlot.querySelector('#btn-native-share').addEventListener('click', () => {
                navigator.share({
                    title: SHARE_TITLE,
                    text: SHARE_TEXT,
                    url: SITE_URL,
                }).catch(() => {});
            });
        }
    },

    /** Compact share bar for use in other views */
    renderShareBar() {
        return `
            <div class="share-bar">
                <span class="text-sm text-secondary">Help others opt out:</span>
                <a href="https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SITE_URL)}"
                    class="btn btn-ghost btn-sm" target="_blank" rel="noopener" title="Share on X">&#120143;</a>
                <a href="https://www.reddit.com/submit?url=${encodeURIComponent(SITE_URL)}&title=${encodeURIComponent(SHARE_TITLE)}"
                    class="btn btn-ghost btn-sm" target="_blank" rel="noopener" title="Share on Reddit">&#9650;</a>
                <a href="mailto:?subject=${encodeURIComponent(SHARE_TITLE)}&body=${encodeURIComponent(SHARE_TEXT + '\n\n' + SITE_URL)}"
                    class="btn btn-ghost btn-sm" title="Share via email">&#9993;</a>
            </div>
        `;
    },
};
