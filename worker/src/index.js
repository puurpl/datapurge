/**
 * DataPurge Drip Service — Cloudflare Worker
 *
 * Handles email drip signup, daily batch sending via Resend,
 * and 45-day compliance reminder rotation.
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

function generateId() {
    return crypto.randomUUID();
}

// --- Route handlers ---

async function handleSignup(request, env) {
    const { email, brokers_per_email = 100, queue } = await request.json();

    if (!email || !Array.isArray(queue) || queue.length === 0) {
        return jsonResponse({ error: 'Email and queue are required' }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return jsonResponse({ error: 'Invalid email address' }, 400);
    }

    const brokersPerEmail = Math.min(Math.max(parseInt(brokers_per_email) || 100, 10), 200);

    // Check for existing subscriber
    const existing = await env.DB.prepare(
        'SELECT id, status FROM subscribers WHERE email = ?'
    ).bind(email).first();

    let subscriberId;

    if (existing) {
        // Reactivate and replace queue
        subscriberId = existing.id;
        await env.DB.prepare(
            'UPDATE subscribers SET status = ?, brokers_per_email = ?, queue_position = 0, total_items = ?, rotation_count = 0, created_at = ? WHERE id = ?'
        ).bind('active', brokersPerEmail, queue.length, new Date().toISOString(), subscriberId).run();

        // Clear old queue and sent log
        await env.DB.prepare('DELETE FROM queue_items WHERE subscriber_id = ?').bind(subscriberId).run();
        await env.DB.prepare('DELETE FROM sent_log WHERE subscriber_id = ?').bind(subscriberId).run();
    } else {
        subscriberId = generateId();
        await env.DB.prepare(
            'INSERT INTO subscribers (id, email, brokers_per_email, queue_position, total_items, created_at, status) VALUES (?, ?, ?, 0, ?, ?, ?)'
        ).bind(subscriberId, email, brokersPerEmail, queue.length, new Date().toISOString(), 'active').run();
    }

    // Insert queue items in batches of 50
    for (let i = 0; i < queue.length; i += 50) {
        const batch = queue.slice(i, i + 50);
        const stmts = batch.map((item, j) =>
            env.DB.prepare(
                'INSERT INTO queue_items (subscriber_id, position, broker_id, broker_name, email_to, subject, body, nc_subject, nc_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            ).bind(
                subscriberId, i + j,
                item.broker_id, item.broker_name, item.email_to,
                item.subject, item.body,
                item.nc_subject || '', item.nc_body || ''
            )
        );
        await env.DB.batch(stmts);
    }

    // Send first batch immediately
    await sendBatchToSubscriber(env, subscriberId);

    return jsonResponse({ ok: true, subscriber_id: subscriberId, total_items: queue.length });
}

async function handleUnsubscribe(request, env) {
    const { email } = await request.json();
    if (!email) return jsonResponse({ error: 'Email is required' }, 400);

    await env.DB.prepare(
        'UPDATE subscribers SET status = ? WHERE email = ?'
    ).bind('inactive', email).run();

    return jsonResponse({ ok: true });
}

async function handleStatus(request, env) {
    const url = new URL(request.url);
    const email = url.searchParams.get('email');
    if (!email) return jsonResponse({ error: 'Email parameter required' }, 400);

    const sub = await env.DB.prepare(
        'SELECT id, email, brokers_per_email, queue_position, total_items, status, rotation_count, last_sent_at FROM subscribers WHERE email = ?'
    ).bind(email).first();

    if (!sub) return jsonResponse({ error: 'Not found' }, 404);

    return jsonResponse({
        email: sub.email,
        status: sub.status,
        queue_position: sub.queue_position,
        total_items: sub.total_items,
        brokers_per_email: sub.brokers_per_email,
        rotation_count: sub.rotation_count,
        last_sent_at: sub.last_sent_at,
    });
}

// --- Daily cron: send next batch to each active subscriber ---

async function handleCron(env) {
    const subscribers = await env.DB.prepare(
        "SELECT * FROM subscribers WHERE status = 'active'"
    ).all();

    for (const sub of subscribers.results) {
        try {
            await sendBatchToSubscriber(env, sub.id);
        } catch (err) {
            console.error(`Failed to send batch to ${sub.email}:`, err);
        }
    }
}

async function sendBatchToSubscriber(env, subscriberId) {
    const sub = await env.DB.prepare(
        'SELECT * FROM subscribers WHERE id = ?'
    ).bind(subscriberId).first();

    if (!sub || sub.status !== 'active') return;

    const brokersPerEmail = sub.brokers_per_email;
    const queuePos = sub.queue_position;
    const totalItems = sub.total_items;

    // Check if we've completed the queue
    if (queuePos >= totalItems) {
        await handleQueueCompletion(env, sub);
        return;
    }

    // Get next batch of queue items
    const items = await env.DB.prepare(
        'SELECT * FROM queue_items WHERE subscriber_id = ? AND position >= ? AND position < ? ORDER BY position'
    ).bind(subscriberId, queuePos, queuePos + brokersPerEmail).all();

    if (items.results.length === 0) return;

    const batchNumber = Math.floor(queuePos / brokersPerEmail) + 1;
    const totalBatches = Math.ceil(totalItems / brokersPerEmail);
    const now = new Date().toISOString();

    // Get compliance items (brokers past 45-day deadline in current rotation)
    const complianceItems = await getComplianceItems(env, subscriberId, sub.rotation_count);

    // Build email HTML
    const emailHtml = buildDripEmail(items.results, {
        batchNumber,
        totalBatches,
        queuePos,
        totalItems,
        brokersPerEmail,
        complianceItems,
        unsubscribeUrl: `${getBaseUrl(env)}/api/unsubscribe`,
        subscriberEmail: sub.email,
    });

    const subject = `DataPurge — Day ${batchNumber} of ${totalBatches}`;

    // Send via Resend
    await sendEmail(env, sub.email, subject, emailHtml);

    // Log sent items and update first_sent_at
    const logStmts = items.results.map(item =>
        env.DB.prepare(
            'INSERT INTO sent_log (subscriber_id, queue_item_id, sent_at, rotation) VALUES (?, ?, ?, ?)'
        ).bind(subscriberId, item.id, now, sub.rotation_count)
    );

    const updateStmts = items.results
        .filter(item => !item.first_sent_at)
        .map(item =>
            env.DB.prepare(
                'UPDATE queue_items SET first_sent_at = ? WHERE id = ?'
            ).bind(now, item.id)
        );

    // Advance queue position
    const advanceStmt = env.DB.prepare(
        'UPDATE subscribers SET queue_position = ?, last_sent_at = ? WHERE id = ?'
    ).bind(queuePos + items.results.length, now, subscriberId);

    await env.DB.batch([...logStmts, ...updateStmts, advanceStmt]);
}

async function handleQueueCompletion(env, sub) {
    // Check if 45+ days since the first item was sent in this rotation
    const firstSent = await env.DB.prepare(
        'SELECT sent_at FROM sent_log WHERE subscriber_id = ? AND rotation = ? ORDER BY sent_at ASC LIMIT 1'
    ).bind(sub.id, sub.rotation_count).first();

    if (!firstSent) return;

    const daysSinceFirst = daysBetween(new Date(firstSent.sent_at), new Date());

    if (daysSinceFirst >= 45) {
        // Start new rotation
        await env.DB.prepare(
            'UPDATE subscribers SET queue_position = 0, rotation_count = ? WHERE id = ?'
        ).bind(sub.rotation_count + 1, sub.id).run();

        // Send the first batch of the new rotation
        await sendBatchToSubscriber(env, sub.id);
    } else {
        // Between completion and 45 days: send compliance-only email if there are overdue items
        const complianceItems = await getComplianceItems(env, sub.id, sub.rotation_count);

        if (complianceItems.length > 0) {
            const emailHtml = buildComplianceOnlyEmail(complianceItems, {
                daysSinceFirst,
                unsubscribeUrl: `${getBaseUrl(env)}/api/unsubscribe`,
                subscriberEmail: sub.email,
            });

            await sendEmail(env, sub.email, 'DataPurge — Compliance Reminder', emailHtml);
            await env.DB.prepare(
                'UPDATE subscribers SET last_sent_at = ? WHERE id = ?'
            ).bind(new Date().toISOString(), sub.id).run();
        }
    }
}

// --- Phase 4: Compliance reminders ---

async function getComplianceItems(env, subscriberId, rotation) {
    const results = await env.DB.prepare(`
        SELECT qi.broker_name, qi.email_to, qi.nc_subject, qi.nc_body, sl.sent_at
        FROM sent_log sl
        JOIN queue_items qi ON sl.queue_item_id = qi.id
        WHERE sl.subscriber_id = ? AND sl.rotation = ?
          AND sl.sent_at < datetime('now', '-45 days')
        ORDER BY sl.sent_at ASC
    `).bind(subscriberId, rotation).all();

    return results.results;
}

function fillCompliancePlaceholders(text, sentAt) {
    const sentDate = new Date(sentAt);
    const now = new Date();
    const daysElapsed = daysBetween(sentDate, now);
    const formattedDate = sentDate.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
    });

    return text
        .replace(/\{original_request_date\}/g, formattedDate)
        .replace(/\{days_elapsed\}/g, String(daysElapsed));
}

// --- Email building ---

function buildDripEmail(items, opts) {
    const {
        batchNumber, totalBatches, queuePos, totalItems,
        brokersPerEmail, complianceItems, unsubscribeUrl, subscriberEmail,
    } = opts;

    const sentSoFar = queuePos + items.length;
    const progressPct = Math.round((sentSoFar / totalItems) * 100);
    const progressBarFilled = Math.round(progressPct / 5);
    const progressBar = '\u2588'.repeat(progressBarFilled) + '\u2591'.repeat(20 - progressBarFilled);

    let html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #0f172a; background: #ffffff;">

<div style="margin-bottom: 24px;">
    <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 4px;">DataPurge — Day ${batchNumber} of ${totalBatches}</h1>
    <p style="color: #64748b; font-size: 14px; margin: 0;">
        <span style="font-family: monospace;">${progressBar}</span> ${sentSoFar} of ${totalItems} brokers
    </p>
</div>

<div style="margin-bottom: 24px;">
    <h2 style="font-size: 16px; font-weight: 600; margin: 0 0 12px;">Today's batch (${items.length} brokers)</h2>
    <p style="font-size: 13px; color: #64748b; margin: 0 0 12px;">Click each button to open a pre-filled opt-out email in your email client.</p>
`;

    for (const item of items) {
        const mailtoLink = buildMailtoLink(item.email_to, item.subject, item.body);
        html += `
    <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 8px;">
        <div style="font-weight: 500; margin-bottom: 6px;">${escHtml(item.broker_name)}</div>
        <a href="${mailtoLink}" style="display: inline-block; padding: 8px 20px; background: #2563eb; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">Send Opt-Out Email</a>
    </div>`;
    }

    html += '</div>';

    // Compliance section
    if (complianceItems && complianceItems.length > 0) {
        html += buildComplianceSection(complianceItems);
    }

    // Footer
    html += `
<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
    <p>You're receiving this because you signed up for DataPurge daily opt-out emails.</p>
    <p><a href="${unsubscribeUrl}?email=${encodeURIComponent(subscriberEmail)}" style="color: #64748b;">Unsubscribe</a></p>
</div>

</body>
</html>`;

    return html;
}

function buildComplianceSection(complianceItems) {
    let html = `
<div style="border: 2px solid #dc2626; border-radius: 8px; padding: 16px; margin-bottom: 24px; background: #fef2f2;">
    <h2 style="font-size: 16px; font-weight: 600; color: #dc2626; margin: 0 0 8px;">
        Compliance Check (${complianceItems.length} broker${complianceItems.length > 1 ? 's' : ''} past 45-day deadline)
    </h2>
    <p style="font-size: 13px; color: #64748b; margin: 0 0 12px;">
        These brokers haven't responded within the legal deadline. Send a noncompliance notice:
    </p>
    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
            <tr style="border-bottom: 1px solid #e2e8f0; text-align: left;">
                <th style="padding: 6px 8px;">Broker</th>
                <th style="padding: 6px 8px;">Sent</th>
                <th style="padding: 6px 8px;">Days</th>
                <th style="padding: 6px 8px;">Action</th>
            </tr>
        </thead>
        <tbody>`;

    for (const item of complianceItems) {
        const sentDate = new Date(item.sent_at);
        const daysElapsed = daysBetween(sentDate, new Date());
        const formattedDate = sentDate.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric',
        });

        let mailtoLink = '#';
        if (item.nc_subject && item.nc_body) {
            const filledSubject = fillCompliancePlaceholders(item.nc_subject, item.sent_at);
            const filledBody = fillCompliancePlaceholders(item.nc_body, item.sent_at);
            mailtoLink = buildMailtoLink(item.email_to, filledSubject, filledBody);
        }

        html += `
        <tr style="border-bottom: 1px solid #e2e8f0;">
            <td style="padding: 6px 8px; font-weight: 500;">${escHtml(item.broker_name)}</td>
            <td style="padding: 6px 8px; color: #64748b;">${formattedDate}</td>
            <td style="padding: 6px 8px; color: #dc2626; font-weight: 600;">${daysElapsed}d</td>
            <td style="padding: 6px 8px;">
                <a href="${mailtoLink}" style="display: inline-block; padding: 4px 12px; background: #dc2626; color: #fff; text-decoration: none; border-radius: 4px; font-size: 12px;">Send Notice</a>
            </td>
        </tr>`;
    }

    html += `
        </tbody>
    </table>
    <div style="margin-top: 12px; font-size: 12px; color: #64748b;">
        <strong>Next steps:</strong> Check your inbox for responses. Verify removal on the broker's search page.
        Send noncompliance notice if no action taken. File an AG complaint if persistent.
    </div>
</div>`;

    return html;
}

function buildComplianceOnlyEmail(complianceItems, opts) {
    const { daysSinceFirst, unsubscribeUrl, subscriberEmail } = opts;
    const daysUntilReset = 45 - daysSinceFirst;

    let html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; color: #0f172a; background: #ffffff;">

<div style="margin-bottom: 24px;">
    <h1 style="font-size: 20px; font-weight: 600; margin: 0 0 4px;">DataPurge — Compliance Reminder</h1>
    <p style="color: #64748b; font-size: 14px; margin: 0;">
        All initial opt-out emails sent. ${daysUntilReset > 0 ? `Next full cycle in ${daysUntilReset} day${daysUntilReset > 1 ? 's' : ''}.` : 'Starting new cycle soon.'}
    </p>
</div>
`;

    html += buildComplianceSection(complianceItems);

    html += `
<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
    <p>You're receiving this because you signed up for DataPurge daily opt-out emails.</p>
    <p><a href="${unsubscribeUrl}?email=${encodeURIComponent(subscriberEmail)}" style="color: #64748b;">Unsubscribe</a></p>
</div>

</body>
</html>`;

    return html;
}

// --- Resend integration ---

async function sendEmail(env, to, subject, html) {
    const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: env.FROM_EMAIL,
            to: [to],
            subject,
            html,
        }),
    });

    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Resend API error (${resp.status}): ${err}`);
    }

    return resp.json();
}

// --- Utilities ---

function buildMailtoLink(emailTo, subject, body) {
    return `mailto:${encodeURIComponent(emailTo)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function daysBetween(d1, d2) {
    return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

function getBaseUrl(env) {
    return env.BASE_URL || 'https://drip.datapurge.iamnottheproduct.com';
}

// --- Worker entry ---

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            if (path === '/api/signup' && request.method === 'POST') {
                return await handleSignup(request, env);
            }
            if (path === '/api/unsubscribe' && request.method === 'POST') {
                return await handleUnsubscribe(request, env);
            }
            if (path === '/api/unsubscribe' && request.method === 'GET') {
                // Handle unsubscribe from email link (GET with ?email=)
                const email = url.searchParams.get('email');
                if (email) {
                    await env.DB.prepare(
                        'UPDATE subscribers SET status = ? WHERE email = ?'
                    ).bind('inactive', email).run();
                    return new Response(
                        '<html><body style="font-family:sans-serif;text-align:center;padding:4rem;"><h2>Unsubscribed</h2><p>You will no longer receive DataPurge emails.</p></body></html>',
                        { status: 200, headers: { 'Content-Type': 'text/html' } }
                    );
                }
                return jsonResponse({ error: 'Email parameter required' }, 400);
            }
            if (path === '/api/status' && request.method === 'GET') {
                return await handleStatus(request, env);
            }

            return jsonResponse({ error: 'Not found' }, 404);
        } catch (err) {
            console.error('Worker error:', err);
            return jsonResponse({ error: 'Internal server error' }, 500);
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(handleCron(env));
    },
};
