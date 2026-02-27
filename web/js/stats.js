fetch('data/registry.json')
    .then(r => r.ok ? r.json() : null)
    .then(d => {
        if (d) document.getElementById('stat-brokers').textContent = d.broker_count;
    })
    .catch(() => {});
