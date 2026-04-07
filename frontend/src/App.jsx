import { useEffect, useMemo, useState } from 'react';

function inferHost() {
  if (typeof window === 'undefined') {
    return '192.0.2.50';
  }

  const { hostname } = window.location;
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    return '192.0.2.50';
  }

  return hostname;
}

function buildApiUrl(path, params) {
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  return `${path}${query}`;
}

function normalizeDomain(domain) {
  return domain.trim().toLowerCase();
}

function buildDefaults(domain) {
  return {
    domain,
    mailHost: 'mail',
    ip: inferHost(),
    selector: 'mail',
    adminEmail: `admin@${domain || 'example.com'}`
  };
}

function getStatusTone(status) {
  if (status === 'connected') return 'tone-success';
  if (status === 'mismatch') return 'tone-warning';
  if (status === 'missing') return 'tone-danger';
  return 'tone-neutral';
}

function getProvisionTone(provision) {
  if (provision?.applied) return 'tone-success';
  if (provision?.mode?.startsWith('pending')) return 'tone-warning';
  return 'tone-neutral';
}

function getProvisionLabel(provision) {
  if (provision?.applied) return 'Applied to mailserver';
  if (provision?.mode === 'pending-docker-missing') return 'Pending: Docker not installed';
  if (provision?.mode === 'pending-mailserver-unavailable') return 'Pending: Mail container unavailable';
  return 'Stored in admin panel';
}

function formatStructuredRecord(record) {
  const lines = [`Type: ${record.type}`, `Host: ${record.host}`, `Value: ${record.answer}`];
  if (record.priority) lines.push(`Priority: ${record.priority}`);
  return lines.join('\n');
}

const initialUserForm = {
  localPart: '',
  password: '',
  quotaMb: '1024'
};

export default function App() {
  const [activePage, setActivePage] = useState('overview');
  const [domainInput, setDomainInput] = useState('driftspike.space');
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [userForm, setUserForm] = useState(initialUserForm);
  const [userError, setUserError] = useState('');
  const [savingUser, setSavingUser] = useState(false);

  const normalizedDomain = useMemo(() => normalizeDomain(domainInput), [domainInput]);
  const defaults = useMemo(() => buildDefaults(normalizedDomain), [normalizedDomain]);
  const setup = overview?.setup ?? null;
  const verification = overview?.verification ?? null;
  const checks = verification?.checks ?? [];
  const ready = verification?.ready ?? false;
  const dkimRecord = setup?.dnsRecords?.find((record) => record.host === 'mail._domainkey');
  const automaticAliases = useMemo(() => {
    const localPart = userForm.localPart.trim().toLowerCase();
    const suggestions = {
      admin: [`postmaster@${normalizedDomain}`, `hostmaster@${normalizedDomain}`, `webmaster@${normalizedDomain}`],
      support: [`help@${normalizedDomain}`],
      info: [`hello@${normalizedDomain}`],
      hello: [`hi@${normalizedDomain}`],
      sales: [`billing@${normalizedDomain}`]
    };

    return suggestions[localPart] ?? [];
  }, [normalizedDomain, userForm.localPart]);

  async function loadOverview() {
    if (!normalizedDomain || !normalizedDomain.includes('.')) {
      setOverview(null);
      return;
    }

    setLoadingOverview(true);
    setError('');

    try {
      const response = await fetch(buildApiUrl('/api/domain-overview', defaults));
      if (!response.ok) {
        throw new Error(`Domain overview failed with ${response.status}`);
      }

      const body = await response.json();
      setOverview(body);
    } catch (requestError) {
      setOverview(null);
      setError(requestError.message || 'Domain overview failed');
    } finally {
      setLoadingOverview(false);
    }
  }

  async function loadUsers() {
    if (!normalizedDomain || !normalizedDomain.includes('.')) {
      setUsers([]);
      return;
    }

    setLoadingUsers(true);
    setUserError('');

    try {
      const response = await fetch(buildApiUrl('/api/admin/users', { domain: normalizedDomain }));
      if (!response.ok) throw new Error('Failed to load users');
      const body = await response.json();
      setUsers(body.users);
    } catch (requestError) {
      setUserError(requestError.message || 'Failed to load mailboxes');
    } finally {
      setLoadingUsers(false);
    }
  }

  useEffect(() => {
    if (!normalizedDomain || !normalizedDomain.includes('.')) {
      setOverview(null);
      setUsers([]);
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      loadOverview();
      loadUsers();
    }, 120);

    return () => window.clearTimeout(timeout);
  }, [normalizedDomain]);

  async function copyText(label, value) {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      setCopied('');
    }
  }

  async function createUser(event) {
    event.preventDefault();
    setSavingUser(true);
    setUserError('');

    try {
      const response = await fetch(buildApiUrl('/api/admin/users'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: normalizedDomain,
          localPart: userForm.localPart,
          password: userForm.password,
          quotaMb: Number(userForm.quotaMb || 1024)
        })
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || 'Failed to create mailbox');
      }

      setUserForm(initialUserForm);
      await loadUsers();
    } catch (requestError) {
      setUserError(requestError.message || 'Failed to create mailbox');
    } finally {
      setSavingUser(false);
    }
  }

  async function removeUser(email) {
    setUserError('');

    try {
      const response = await fetch(buildApiUrl(`/api/admin/users/${encodeURIComponent(email)}`), {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete mailbox');
      }

      await loadUsers();
    } catch (requestError) {
      setUserError(requestError.message || 'Failed to delete mailbox');
    }
  }

  return (
    <div className="page-shell">
      <div className="page-background" />
      <main className="app-shell">
        <section className="hero-card">
          <div className="hero-copy">
            <span className="eyebrow">Mail stack builder</span>
            <h1>Domain connected. Mailboxes next.</h1>
            <p>
              The domain flow now uses a single overview request, and the admin panel is split into overview, DNS,
              mailbox, and server pages. Browser requests now go through same-origin `/api` routes on port `5173`.
            </p>
          </div>

          <div className="hero-status">
            <div className={`status-badge ${ready ? 'status-success' : 'status-idle'}`}>
              {loadingOverview ? 'Refreshing domain' : ready ? 'Domain connected' : 'Domain setup in progress'}
            </div>
            <dl className="status-grid">
              <div>
                <dt>Domain</dt>
                <dd>{normalizedDomain || 'Not set'}</dd>
              </div>
              <div>
                <dt>Mail host</dt>
                <dd>{setup ? `${setup.mailHost}.${setup.domain}` : 'Generated automatically'}</dd>
              </div>
              <div>
                <dt>Verification</dt>
                <dd>{checks.length ? `${checks.filter((item) => item.status === 'connected').length}/${checks.length} connected` : 'Waiting'}</dd>
              </div>
              <div>
                <dt>Mailboxes</dt>
                <dd>{loadingUsers ? 'Loading' : `${users.length} configured`}</dd>
              </div>
            </dl>
            {error ? <p className="error-copy">{error}</p> : null}
          </div>
        </section>

        <section className="layout-grid">
          <aside className="control-card">
            <div className="section-heading">
              <span className="section-label">Start</span>
              <h2>Domain only</h2>
              <p>Mail host, admin inbox, selector, and IP are filled automatically.</p>
            </div>

            <div className="field-stack">
              <label>
                Domain
                <input value={domainInput} onChange={(event) => setDomainInput(event.target.value)} placeholder="driftspike.space" />
              </label>
            </div>

            <div className="auto-summary">
              <div>
                <span className="mini-label">Mail host</span>
                <strong>{defaults.mailHost}.{normalizedDomain || 'your-domain.com'}</strong>
              </div>
              <div>
                <span className="mini-label">Admin inbox</span>
                <strong>{defaults.adminEmail}</strong>
              </div>
              <div>
                <span className="mini-label">Selector</span>
                <strong>{defaults.selector}</strong>
              </div>
            </div>

            <div className="action-row">
              <button className="primary-button" type="button" onClick={loadOverview}>
                {loadingOverview ? 'Refreshing…' : 'Refresh domain'}
              </button>
              {copied ? <span className="copied-state">Copied {copied}</span> : null}
            </div>

            <div className="nav-stack">
              {[
                ['overview', 'Overview'],
                ['dns', 'DNS'],
                ['users', 'Mailboxes'],
                ['server', 'Server']
              ].map(([id, label]) => (
                <button
                  key={id}
                  className={`nav-button ${activePage === id ? 'nav-button-active' : ''}`}
                  type="button"
                  onClick={() => setActivePage(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </aside>

          <section className="results-column">
            {activePage === 'overview' ? (
              <>
                <section className="content-card">
                  <div className="content-head">
                    <div>
                      <span className="section-label">Status</span>
                      <h2>Domain overview</h2>
                    </div>
                    <button className="secondary-button" type="button" onClick={loadOverview}>
                      Refresh
                    </button>
                  </div>
                  <div className="overview-grid">
                    <article className="mini-card">
                      <span className="mini-label">SMTP</span>
                      <strong>{verification?.connectionDetails?.smtp.host}:{verification?.connectionDetails?.smtp.port}</strong>
                      <p className="client-copy">{verification?.connectionDetails?.smtp.security}</p>
                    </article>
                    <article className="mini-card">
                      <span className="mini-label">IMAP</span>
                      <strong>{verification?.connectionDetails?.imap.host}:{verification?.connectionDetails?.imap.port}</strong>
                      <p className="client-copy">{verification?.connectionDetails?.imap.security}</p>
                    </article>
                    <article className="mini-card">
                      <span className="mini-label">Mailbox count</span>
                      <strong>{users.length}</strong>
                      <p className="client-copy">Configured in local admin store</p>
                    </article>
                  </div>
                </section>

                <section className="content-card">
                  <div className="content-head">
                    <div>
                      <span className="section-label">Checks</span>
                      <h2>Connected records</h2>
                    </div>
                  </div>
                  <div className="verify-grid">
                    {checks.map((check) => (
                      <article key={`${check.type}-${check.name}`} className="verify-card">
                        <div className="verify-topline">
                          <span className="pill">{check.type}</span>
                          <span className={`status-chip ${getStatusTone(check.status)}`}>{check.status}</span>
                        </div>
                        <h3>{check.name}</h3>
                        <div className="verify-block">
                          <span>Expected</span>
                          <code>{formatStructuredRecord(check)}</code>
                        </div>
                        <div className="verify-block">
                          <span>Actual</span>
                          <code>{check.actual}</code>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {activePage === 'dns' ? (
              <section className="content-card">
                <div className="content-head">
                  <div>
                    <span className="section-label">Generated values</span>
                    <h2>Exact DNS rows to enter</h2>
                  </div>
                </div>
                <div className="provider-warning">
                  <strong>Important:</strong> the `MX` row uses mail server `mail.{normalizedDomain}` with priority `10`.
                  The `TXT` rows are separate. Do not paste `v=spf1...` into the `MX` field.
                </div>
                <div className="record-grid">
                  {(setup?.dnsRecords ?? []).map((record) => (
                    <article key={`${record.type}-${record.name}`} className="record-card">
                      <div className="record-topline">
                        <span className="pill">{record.type}</span>
                        <div className="button-cluster">
                          <button className="secondary-button" type="button" onClick={() => copyText(`${record.name} row`, formatStructuredRecord(record))}>
                            Copy row
                          </button>
                          <button className="secondary-button" type="button" onClick={() => copyText(`${record.name} value`, record.answer)}>
                            Copy value
                          </button>
                        </div>
                      </div>
                      <h3>{record.name}</h3>
                      <div className="record-meta">
                        <div>
                          <div className="meta-topline">
                            <span>Host</span>
                            <button className="inline-copy" type="button" onClick={() => copyText(`${record.name} host`, record.host)}>
                              Copy
                            </button>
                          </div>
                          <code>{record.host}</code>
                        </div>
                        <div>
                          <div className="meta-topline">
                            <span>Value</span>
                            <button className="inline-copy" type="button" onClick={() => copyText(`${record.name} value`, record.answer)}>
                              Copy
                            </button>
                          </div>
                          <code>{record.answer}</code>
                        </div>
                        {record.priority ? (
                          <div>
                            <div className="meta-topline">
                              <span>Priority</span>
                              <button className="inline-copy" type="button" onClick={() => copyText(`${record.name} priority`, String(record.priority))}>
                                Copy
                              </button>
                            </div>
                            <code>{record.priority}</code>
                          </div>
                        ) : null}
                      </div>
                      <p>{record.note}</p>
                      {record.providerHint ? <p className="hint-copy">{record.providerHint}</p> : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {activePage === 'users' ? (
              <section className="content-card">
                <div className="content-head">
                  <div>
                    <span className="section-label">Mail admin</span>
                    <h2>Create and manage mailboxes</h2>
                  </div>
                </div>

                <form className="admin-form" onSubmit={createUser}>
                  <label>
                    Local part
                    <input
                      value={userForm.localPart}
                      onChange={(event) => setUserForm((current) => ({ ...current, localPart: event.target.value }))}
                      placeholder="admin"
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="text"
                      value={userForm.password}
                      onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
                      placeholder="strong-password"
                    />
                  </label>
                  <label>
                    Quota MB
                    <input
                      value={userForm.quotaMb}
                      onChange={(event) => setUserForm((current) => ({ ...current, quotaMb: event.target.value }))}
                      placeholder="1024"
                    />
                  </label>
                  <div className="admin-form-wide auto-alias-card">
                    <span className="mini-label">Automatic aliases</span>
                    <strong>{automaticAliases.length ? automaticAliases.join(', ') : 'No extra aliases for this mailbox name'}</strong>
                    <p className="hint-copy">Aliases are generated automatically for common mailbox names like `admin`, `support`, and `info`.</p>
                  </div>
                  <button className="primary-button" type="submit" disabled={savingUser || !ready}>
                    {savingUser ? 'Creating…' : 'Create mailbox'}
                  </button>
                </form>

                {!ready ? <p className="hint-copy">Mailbox creation is enabled after the domain passes DNS checks.</p> : null}
                {userError ? <p className="error-copy">{userError}</p> : null}

                <div className="mailbox-grid">
                  {users.map((user) => (
                    <article key={user.email} className="mailbox-card">
                      <div className="record-topline">
                        <div>
                          <h3>{user.email}</h3>
                          <p className="hint-copy">Quota {user.quotaMb} MB</p>
                        </div>
                        <div className="button-cluster">
                          <button className="secondary-button danger-button" type="button" onClick={() => removeUser(user.email)}>
                            Delete
                          </button>
                        </div>
                      </div>
                      <div className="verify-topline">
                        <span className={`status-chip ${getProvisionTone(user.provision)}`}>{getProvisionLabel(user.provision)}</span>
                      </div>
                      {user.provision?.output ? (
                        <div className="verify-block">
                          <span>Provision result</span>
                          <code>{user.provision.output}</code>
                        </div>
                      ) : null}
                      <div className="verify-block">
                        <span>Backend action</span>
                        <code>{user.commands.create}</code>
                      </div>
                      <div className="verify-block">
                        <span>Password reset action</span>
                        <code>{user.commands.updatePassword}</code>
                      </div>
                      {user.aliases?.length ? (
                        <div className="verify-block">
                          <span>Aliases</span>
                          <code>{user.aliases.join(', ')}</code>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {activePage === 'server' ? (
              <section className="content-card">
                <div className="content-head">
                  <div>
                    <span className="section-label">Server</span>
                    <h2>Deploy and operate</h2>
                  </div>
                </div>

                <div className="overview-grid">
                  <article className="mini-card">
                    <span className="mini-label">SMTP</span>
                    <strong>{verification?.connectionDetails?.smtp.host}:{verification?.connectionDetails?.smtp.port}</strong>
                    <p className="client-copy">{verification?.connectionDetails?.smtp.security}</p>
                  </article>
                  <article className="mini-card">
                    <span className="mini-label">IMAP</span>
                    <strong>{verification?.connectionDetails?.imap.host}:{verification?.connectionDetails?.imap.port}</strong>
                    <p className="client-copy">{verification?.connectionDetails?.imap.security}</p>
                  </article>
                  <article className="mini-card">
                    <span className="mini-label">Username</span>
                    <strong>{verification?.connectionDetails?.smtp.usernameHint}</strong>
                    <p className="client-copy">Use a mailbox email from the mailboxes page</p>
                  </article>
                </div>

                <div className="split-card top-gap">
                  <div>
                    <div className="content-head compact">
                      <div>
                        <span className="section-label">Compose</span>
                        <h2>Docker mail stack</h2>
                      </div>
                      <button className="secondary-button" type="button" onClick={() => copyText('compose', setup?.dockerCompose)}>
                        Copy
                      </button>
                    </div>
                    <pre className="code-block">{setup?.dockerCompose ?? 'Waiting for setup response...'}</pre>
                  </div>
                  <div>
                    <div className="content-head compact">
                      <div>
                        <span className="section-label">DKIM</span>
                        <h2>Current TXT value</h2>
                      </div>
                      <button className="secondary-button" type="button" onClick={() => copyText('DKIM TXT value', dkimRecord?.answer)}>
                        Copy
                      </button>
                    </div>
                    <pre className="code-block">{dkimRecord?.answer ?? 'Waiting for DKIM value...'}</pre>
                  </div>
                </div>
              </section>
            ) : null}
          </section>
        </section>
      </main>
    </div>
  );
}
