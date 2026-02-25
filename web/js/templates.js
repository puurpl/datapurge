/**
 * DataPurge Templates — Client-side template selection & interpolation
 *
 * Replicates server/templates.py logic exactly.
 */

let data = null;

export const Templates = {
    async load() {
        const resp = await fetch('data/templates.json');
        data = await resp.json();
    },

    selectBestTemplate(userState, userCountry, broker) {
        const euCountries = new Set(data.eu_countries);

        // GDPR for EU/UK residents
        if (userCountry && userCountry !== 'US') {
            if (userCountry === 'UK' || userCountry === 'GB' || euCountries.has(userCountry)) {
                return 'gdpr_maximum';
            }
        }

        // California → CCPA maximum
        const stateLower = (userState || '').toLowerCase();
        if (stateLower === 'california' && broker.legal && broker.legal.ccpa) {
            return 'ccpa_maximum';
        }

        // State law priority map
        if (data.state_law_priority[stateLower]) {
            return data.state_law_priority[stateLower];
        }

        // Default: omnibus
        return 'us_omnibus';
    },

    getTemplate(templateId) {
        return data ? data.templates[templateId] || null : null;
    },

    listTemplates() {
        return data ? Object.keys(data.templates) : [];
    },

    interpolate(text, fields) {
        // First pass: replace placeholders
        let result = text.replace(/\{(\w+)\}/g, (match, key) => {
            const val = fields[key];
            return (val !== undefined && val !== '') ? String(val) : '';
        });
        // Clean up blank lines left by empty optional fields
        result = result.replace(/\n\s*\n\s*\n/g, '\n\n');
        return result;
    },

    fill(templateId, userFields, broker) {
        const tmpl = this.getTemplate(templateId);
        if (!tmpl) return null;
        const fields = {
            ...userFields,
            broker_name: broker.name,
            broker_domain: broker.domain,
        };
        return {
            templateId,
            subject: this.interpolate(tmpl.subject, fields),
            body: this.interpolate(tmpl.body, fields),
            legalBasis: tmpl.legal_basis,
        };
    },

    generateMailtoLink(sendTo, subject, body) {
        const params = new URLSearchParams();
        params.set('subject', subject);
        params.set('body', body);
        return `mailto:${sendTo}?${params.toString()}`;
    },
};
