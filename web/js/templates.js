/**
 * DataPurge Templates — Client-side template selection & interpolation
 *
 * Replicates server/templates.py logic exactly.
 */

let data = null;

export const Templates = {
    async load() {
        const resp = await fetch('data/templates.json');
        if (!resp.ok) throw new Error(`Failed to load templates: ${resp.status}`);
        data = await resp.json();
    },

    isLoaded() {
        return data !== null;
    },

    selectBestTemplate(userState, userCountry, broker) {
        if (!data) return 'preemptive_blanket';
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
        if (data.state_law_priority && data.state_law_priority[stateLower]) {
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
        let result = text.replace(/\{(\w+)\}/g, (match, key) => {
            const val = fields[key];
            return (val !== undefined && val !== '') ? String(val) : '';
        });
        result = result.replace(/\n\s*\n\s*\n/g, '\n\n');
        return result;
    },

    fill(templateId, userFields, broker) {
        const tmpl = this.getTemplate(templateId);
        if (!tmpl) return null;
        const fields = {
            ...userFields,
            broker_name: broker.name || broker.domain || 'your organization',
            broker_domain: broker.domain || '',
        };
        return {
            templateId,
            subject: this.interpolate(tmpl.subject, fields),
            body: this.interpolate(tmpl.body, fields),
            legalBasis: tmpl.legal_basis,
        };
    },

    generateMailtoLink(sendTo, subject, body) {
        // Validate email format to prevent mailto injection
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sendTo)) return '#';
        return `mailto:${encodeURIComponent(sendTo)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    },
};
