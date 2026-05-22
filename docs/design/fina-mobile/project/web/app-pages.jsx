// app-pages.jsx — Home / Banks / Workspace / Plan / Account
// All auth-required pages, wrapped by AppShell in app.jsx.

const formatDate = (d) =>
  d.toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' });

// ═══════════════════════════════════════════════════════════
// HOME / DASHBOARD
// ═══════════════════════════════════════════════════════════
const HomePage = ({ state, dispatch }) => {
  const { user, workspace, tier, trialDays, trialEndsAt, banks, members } = state;
  const isTrial = tier === 'trial';
  const isFree = tier === 'free';

  return (
    <div className="fw-container">
      <div className="fw-welcome">
        <h1 className="fw-welcome-greeting">
          Welcome back, <span className="em">{user.name.split(' ')[0]}</span>
        </h1>
        <div className="fw-welcome-date">{formatDate(new Date())}</div>
      </div>

      {/* Trial / tier banner — only shown when there's something to nudge */}
      {isTrial && (
        <div className="fw-banner trial" style={{ marginBottom: 32 }}>
          <span className="fw-banner-icon">
            <WebIcon name="sparkle" size={20} strokeWidth={1.8} />
          </span>
          <div className="fw-banner-body">
            <div className="fw-banner-title">You're on Pro trial — {trialDays} days left</div>
            <div className="fw-banner-sub">Trial ends {trialEndsAt}. Add a card to keep Pro at $15/mo.</div>
          </div>
          <button
            className="fw-btn primary"
            onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
          >
            Stay on Pro
          </button>
        </div>
      )}
      {isFree && (
        <div className="fw-banner expired" style={{ marginBottom: 32 }}>
          <span className="fw-banner-icon">
            <WebIcon name="alert" size={20} strokeWidth={1.8} />
          </span>
          <div className="fw-banner-body">
            <div className="fw-banner-title">Your trial ended</div>
            <div className="fw-banner-sub">Upgrade to keep Plaid bank connections and AI features.</div>
          </div>
          <button
            className="fw-btn primary"
            onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
          >
            Upgrade
          </button>
        </div>
      )}

      <div className="fw-grid-2" style={{ marginBottom: 32, gridTemplateColumns: '1fr 1.4fr' }}>
        {/* Workspace summary card */}
        <div className="fw-ws-card">
          <div className="fw-eyebrow">Workspace</div>
          <div className="fw-ws-card-name">{workspace.name}</div>
          <div className="fw-ws-card-meta">
            <span className={`fw-pill role-${workspace.role}`} style={{ marginRight: 8 }}>
              <span className="dot"></span>
              {workspace.role}
            </span>
            {members.length === 1 ? 'Just you' : `${members.length} members`}
          </div>
          <div className="fw-ws-card-foot">
            <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-body)' }}>
              {banks.length === 0 ? (
                <span><strong style={{ color: 'var(--color-ink)' }}>0</strong> banks connected</span>
              ) : (
                <span><strong style={{ color: 'var(--color-ink)' }}>{banks.length}</strong> {banks.length === 1 ? 'bank' : 'banks'} · last synced 4 min ago</span>
              )}
            </div>
            <button
              className="fw-link"
              onClick={() => dispatch({ type: 'navigate', path: '/settings/workspace' })}
            >
              Manage →
            </button>
          </div>
        </div>

        {/* Mobile app CTA */}
        <div className="fw-mobile-cta">
          <div className="fw-mobile-cta-body">
            <div className="fw-mobile-cta-eyebrow">Where Fina really lives</div>
            <h2 className="fw-mobile-cta-title">Open the app every morning for your brief.</h2>
            <p className="fw-mobile-cta-sub">Chat, daily ritual, and one-tap categorize live on your phone. Web is for setup and billing.</p>
            <div className="fw-mobile-cta-badges">
              <a className="fw-mobile-cta-badge" href="#">
                <WebIcon name="apple" size={22} strokeWidth={1.6} />
                <div>
                  <div className="fw-mobile-cta-badge-line1">Download on the</div>
                  <div className="fw-mobile-cta-badge-line2">App Store</div>
                </div>
              </a>
              <a className="fw-mobile-cta-badge" href="#">
                <svg width="20" height="22" viewBox="0 0 22 24" fill="none">
                  <path d="M3 1.5v21l11-10.5L3 1.5z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                  <path d="M3 1.5l17 10.5L3 22.5" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                </svg>
                <div>
                  <div className="fw-mobile-cta-badge-line1">Get it on</div>
                  <div className="fw-mobile-cta-badge-line2">Google Play</div>
                </div>
              </a>
            </div>
          </div>
          <div className="fw-mobile-cta-phone">
            <div style={{ font: '10px var(--font-sans)', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.4px', textTransform: 'uppercase', fontWeight: 600 }}>This morning</div>
            <div style={{ font: '22px var(--font-sans)', fontWeight: 500, color: '#fff', marginTop: 4, letterSpacing: '-0.6px' }}>
              $214<span style={{ color: 'rgba(255,255,255,0.45)', fontWeight: 400 }}>.83</span>
            </div>
            <div style={{ font: '11px var(--font-mono)', color: 'rgba(255,255,255,0.5)', marginTop: 4 }}>5 txns · 2 to categorize</div>
            <div style={{
              marginTop: 18, padding: 14,
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 14,
            }}>
              <div style={{ font: '10px var(--font-sans)', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.6px', fontWeight: 600 }}>Fina · 8:00 AM</div>
              <div style={{ font: '13px/1.45 var(--font-sans)', color: 'rgba(255,255,255,0.82)', marginTop: 8 }}>
                Morning Brian — Netflix bills tomorrow. Two transactions need a category.
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="fw-mobile-cta-phone-bar"></div>
              <div className="fw-mobile-cta-phone-bar short"></div>
            </div>
          </div>
        </div>
      </div>

      {/* Quick links */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div>
            <div className="fw-section-title">Set up your account</div>
            <div className="fw-section-sub">Three things to do before you open the mobile app.</div>
          </div>
        </div>
        <div className="fw-grid-3">
          <button
            className="fw-quick-link"
            onClick={() => dispatch({ type: 'navigate', path: '/settings/banks' })}
          >
            <span className="fw-quick-link-glyph">
              <WebIcon name="bank" size={20} />
            </span>
            <div className="fw-quick-link-title">
              {banks.length === 0 ? 'Connect your first bank' : 'Manage bank connections'}
            </div>
            <div className="fw-quick-link-sub">
              {banks.length === 0
                ? 'Transactions start syncing the moment you connect.'
                : `${banks.length} ${banks.length === 1 ? 'institution' : 'institutions'} connected.`}
            </div>
            <span className="fw-quick-link-arrow">
              Open <WebIcon name="arrowRight" size={14} strokeWidth={2} />
            </span>
          </button>

          <button
            className="fw-quick-link"
            onClick={() => dispatch({ type: 'navigate', path: '/settings/workspace' })}
          >
            <span className="fw-quick-link-glyph">
              <WebIcon name="users" size={20} />
            </span>
            <div className="fw-quick-link-title">Invite a household member</div>
            <div className="fw-quick-link-sub">Share categories and budgets with the people you live with.</div>
            <span className="fw-quick-link-arrow">
              Open <WebIcon name="arrowRight" size={14} strokeWidth={2} />
            </span>
          </button>

          <button
            className="fw-quick-link"
            onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
          >
            <span className="fw-quick-link-glyph">
              <WebIcon name="card" size={20} />
            </span>
            <div className="fw-quick-link-title">Choose your plan</div>
            <div className="fw-quick-link-sub">Free, Lite, or Pro. Add a card before your trial ends to stay on Pro.</div>
            <span className="fw-quick-link-arrow">
              Open <WebIcon name="arrowRight" size={14} strokeWidth={2} />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// BANKS
// ═══════════════════════════════════════════════════════════
const BanksPage = ({ state, dispatch }) => {
  const { tier, banks, workspace } = state;
  const isOwner = workspace.role === 'owner';
  const canConnect = tier !== 'free' && (tier === 'pro' || tier === 'trial' || banks.length < 1);
  const atLimit = tier === 'lite' && banks.length >= 1;

  const connectAction = () => {
    if (tier === 'free') {
      dispatch({ type: 'navigate', path: '/settings/plan' });
      return;
    }
    if (atLimit) {
      dispatch({ type: 'navigate', path: '/settings/plan' });
      return;
    }
    // Mock Plaid Link — add a bank
    dispatch({
      type: 'addBank',
      bank: {
        id: 'b-' + Date.now(),
        name: 'BMO',
        logoClass: 'bmo',
        accounts: [
          { name: 'Smart Account', mask: '4421', balance: '$3,184.20' },
          { name: 'CashBack Mastercard', mask: '0088', balance: '−$842.16' },
        ],
        status: 'active',
        synced: 'just now',
      },
    });
    dispatch({ type: 'toast', message: 'Connected BMO · syncing transactions' });
  };

  return (
    <div className="fw-container">
      <div className="fw-page-head">
        <h1 className="fw-page-title">Banks</h1>
        <p className="fw-page-sub">Connect your bank so Fina can import transactions automatically. Owner-only — only the workspace owner can connect, refresh, or disconnect.</p>
      </div>

      {!isOwner && (
        <div className="fw-banner" style={{ marginBottom: 24 }}>
          <span className="fw-banner-icon">
            <WebIcon name="info" size={18} />
          </span>
          <div className="fw-banner-body">
            <div className="fw-banner-title">View only</div>
            <div className="fw-banner-sub">You're an {workspace.role} in this workspace. Ask an owner to connect or change banks.</div>
          </div>
        </div>
      )}

      {banks.length === 0 ? (
        <div className="fw-empty">
          <div className="fw-empty-glyph">
            <WebIcon name="bank" size={28} strokeWidth={1.5} />
          </div>
          <h3 className="fw-empty-title">No banks connected yet</h3>
          <p className="fw-empty-sub">
            {tier === 'free'
              ? 'Bank connections need a Lite or Pro plan. Start your trial or upgrade.'
              : 'Connect your first bank and your last 24 months of transactions will start importing.'}
          </p>
          <button
            className="fw-btn primary lg"
            onClick={connectAction}
            disabled={!isOwner}
          >
            {tier === 'free' ? 'Upgrade to connect' : 'Connect your first bank'}
            <WebIcon name="arrowRight" size={16} strokeWidth={2} />
          </button>
          <div style={{ marginTop: 14, font: 'var(--type-caption)', color: 'var(--color-muted)' }}>
            Powered by Plaid · we never see your bank password.
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {banks.map(bank => (
            <BankCard key={bank.id} bank={bank} canEdit={isOwner} dispatch={dispatch} />
          ))}

          {/* Connect another bank */}
          {!atLimit && (
            <button
              className="fw-quick-link"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 16, padding: '22px 24px', minHeight: 0 }}
              onClick={connectAction}
              disabled={!isOwner}
            >
              <span className="fw-quick-link-glyph"><WebIcon name="plus" size={20} strokeWidth={2} /></span>
              <div style={{ flex: 1, textAlign: 'left' }}>
                <div className="fw-quick-link-title" style={{ marginBottom: 2 }}>Connect another bank</div>
                <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-body)' }}>
                  {tier === 'pro' ? 'Pro plan — unlimited banks.' : tier === 'trial' ? 'Pro trial — unlimited banks.' : 'Lite plan — up to 1 bank.'}
                </div>
              </div>
              <WebIcon name="chevRight" size={20} color="var(--color-muted)" />
            </button>
          )}

          {atLimit && (
            <div className="fw-banner trial">
              <span className="fw-banner-icon">
                <WebIcon name="zap" size={20} strokeWidth={1.8} />
              </span>
              <div className="fw-banner-body">
                <div className="fw-banner-title">Lite plan limit reached</div>
                <div className="fw-banner-sub">Lite supports 1 bank. Upgrade to Pro for unlimited connections.</div>
              </div>
              <button
                className="fw-btn primary"
                onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
              >
                Upgrade to Pro
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const BankCard = ({ bank, canEdit, dispatch }) => {
  const [expanded, setExpanded] = React.useState(true);
  return (
    <div className="fw-card fw-bank-card">
      <div className="fw-bank-head">
        <div className={`fw-bank-logo ${bank.logoClass || ''}`}>
          {bank.name.slice(0, 3).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fw-bank-name">{bank.name}</div>
          <div className="fw-bank-sync">
            {bank.status === 'active' && (
              <>
                <span className="fw-pill status-active"><span className="dot"></span>Active</span>
                <span>·</span>
                <span>Last synced {bank.synced}</span>
              </>
            )}
            {bank.status === 'reconnect' && (
              <>
                <span className="fw-pill status-warn"><span className="dot"></span>Reconnect needed</span>
                <span>·</span>
                <span>Last synced {bank.synced}</span>
              </>
            )}
          </div>
        </div>
        <button
          className="fw-btn outline sm"
          onClick={() => setExpanded(e => !e)}
        >
          {bank.accounts.length} {bank.accounts.length === 1 ? 'account' : 'accounts'}
          <WebIcon name={expanded ? 'chevUp' : 'chevDown'} size={14} strokeWidth={2} />
        </button>
      </div>

      {expanded && (
        <>
          <div className="fw-bank-accounts">
            {bank.accounts.map((a, i) => (
              <div className="fw-bank-account" key={i}>
                <div>
                  <span className="fw-bank-account-name">{a.name}</span>
                  <span className="fw-bank-account-mask"> · ⋯{a.mask}</span>
                </div>
                <span className="fw-bank-account-bal">{a.balance}</span>
              </div>
            ))}
          </div>
          <div className="fw-bank-actions">
            <button className="fw-btn outline" disabled={!canEdit}>
              <WebIcon name="refresh" size={16} />
              Refresh now
            </button>
            <button
              className="fw-btn danger"
              disabled={!canEdit}
              onClick={() => dispatch({ type: 'modal', modal: { kind: 'disconnect-bank', bank } })}
              style={{ marginLeft: 'auto' }}
            >
              <WebIcon name="unlink" size={16} />
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// WORKSPACE
// ═══════════════════════════════════════════════════════════
const WorkspacePage = ({ state, dispatch }) => {
  const { workspace, members, pendingInvites } = state;
  const isOwner = workspace.role === 'owner';
  const [editingName, setEditingName] = React.useState(false);
  const [name, setName] = React.useState(workspace.name);
  const [inviteEmail, setInviteEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState('editor');
  const [inviteErr, setInviteErr] = React.useState('');

  const saveName = () => {
    if (name.trim()) {
      dispatch({ type: 'renameWorkspace', name: name.trim() });
      dispatch({ type: 'toast', message: 'Workspace renamed' });
    }
    setEditingName(false);
  };

  const sendInvite = (e) => {
    e.preventDefault();
    if (!inviteEmail.includes('@')) { setInviteErr('Enter a valid email address.'); return; }
    if (members.some(m => m.email.toLowerCase() === inviteEmail.toLowerCase())) {
      setInviteErr(`${inviteEmail} is already a member.`); return;
    }
    setInviteErr('');
    dispatch({ type: 'invite', email: inviteEmail, role: inviteRole });
    dispatch({ type: 'toast', message: `Invite sent to ${inviteEmail}` });
    setInviteEmail('');
  };

  return (
    <div className="fw-container">
      <div className="fw-page-head">
        <h1 className="fw-page-title">Workspace</h1>
        <p className="fw-page-sub">Manage members, invites, and how this workspace is shared. Workspaces hold your bank connections, transactions, and categories.</p>
      </div>

      {/* Workspace name + currency */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div className="fw-section-title">General</div>
        </div>
        <div className="fw-card">
          <div className="fw-card-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fw-eyebrow" style={{ marginBottom: 6 }}>Workspace name</div>
              {editingName ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="fw-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') { setName(workspace.name); setEditingName(false); } }}
                    autoFocus
                    style={{ maxWidth: 320 }}
                  />
                  <button className="fw-btn primary" onClick={saveName}>Save</button>
                  <button className="fw-btn ghost" onClick={() => { setName(workspace.name); setEditingName(false); }}>Cancel</button>
                </div>
              ) : (
                <div style={{ font: 'var(--type-title-md)', fontWeight: 600, color: 'var(--color-ink)' }}>
                  {workspace.name}
                </div>
              )}
            </div>
            {!editingName && isOwner && (
              <button className="fw-btn outline sm" onClick={() => setEditingName(true)}>
                <WebIcon name="edit" size={14} />
                Rename
              </button>
            )}
          </div>
          <div className="fw-card-divider"></div>
          <div className="fw-card-row">
            <div style={{ flex: 1 }}>
              <div className="fw-eyebrow" style={{ marginBottom: 6 }}>Default currency</div>
              <div style={{ font: 'var(--type-body-md)', color: 'var(--color-body)' }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--color-ink)' }}>CAD</span>
                <span style={{ marginLeft: 8 }}>· Canadian dollar</span>
              </div>
            </div>
            <span style={{ font: 'var(--type-caption)', color: 'var(--color-muted)' }}>Multi-currency coming v2</span>
          </div>
        </div>
      </div>

      {/* Members */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div>
            <div className="fw-section-title">Members</div>
            <div className="fw-section-sub">{members.length} {members.length === 1 ? 'person has' : 'people have'} access to this workspace.</div>
          </div>
        </div>
        <div className="fw-group">
          {members.map(m => (
            <div className="fw-member" key={m.id}>
              <div className={`fw-member-avatar ${m.color || ''}`}>{m.initials}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  <span className="fw-member-name">{m.name}</span>
                  {m.isYou && <span className="fw-member-you">You</span>}
                </div>
                <div className="fw-member-mail">{m.email}</div>
              </div>
              <div className="fw-member-actions">
                {isOwner && !m.isYou ? (
                  <>
                    <select
                      className="fw-select"
                      value={m.role}
                      onChange={(e) => dispatch({ type: 'changeRole', id: m.id, role: e.target.value })}
                      style={{ height: 36, width: 'auto', padding: '0 32px 0 12px', fontSize: 13, fontWeight: 600 }}
                    >
                      <option value="owner">Owner</option>
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      className="fw-btn ghost sm"
                      onClick={() => dispatch({ type: 'modal', modal: { kind: 'remove-member', member: m } })}
                      title="Remove member"
                    >
                      <WebIcon name="trash" size={16} />
                    </button>
                  </>
                ) : (
                  <span className={`fw-pill role-${m.role}`}>
                    <span className="dot"></span>
                    {m.role}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Invite */}
      {isOwner && (
        <div className="fw-section">
          <div className="fw-section-head">
            <div>
              <div className="fw-section-title">Invite a member</div>
              <div className="fw-section-sub">They'll get an email with a link to join this workspace.</div>
            </div>
          </div>
          <form className="fw-card" onSubmit={sendInvite}>
            <div style={{ display: 'flex', gap: 10 }}>
              <input
                className="fw-input"
                type="email"
                placeholder="email@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                style={{ flex: 1 }}
              />
              <select
                className="fw-select"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                style={{ width: 140, fontWeight: 600 }}
              >
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
              <button className="fw-btn primary" type="submit" disabled={!inviteEmail.includes('@')}>
                Send invite
              </button>
            </div>
            {inviteErr && <div className="fw-field-helper error" style={{ marginTop: 10 }}>{inviteErr}</div>}
            <div style={{ marginTop: 14, font: 'var(--type-caption)', color: 'var(--color-muted)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--color-body)' }}>Editors</strong> can edit transactions and categories.
              <strong style={{ color: 'var(--color-body)', marginLeft: 14 }}>Viewers</strong> can see them but not change anything.
            </div>
          </form>
        </div>
      )}

      {/* Pending invites */}
      {isOwner && pendingInvites.length > 0 && (
        <div className="fw-section">
          <div className="fw-section-head">
            <div>
              <div className="fw-section-title">Pending invites</div>
              <div className="fw-section-sub">{pendingInvites.length} unaccepted invite{pendingInvites.length !== 1 && 's'}.</div>
            </div>
          </div>
          <div className="fw-group">
            {pendingInvites.map(inv => (
              <div className="fw-invite-row" key={inv.id}>
                <span style={{
                  width: 40, height: 40, borderRadius: 999,
                  background: 'var(--color-surface-soft)', color: 'var(--color-muted)',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <WebIcon name="mail" size={18} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fw-invite-mail">{inv.email}</div>
                  <div className="fw-invite-meta">
                    Invited as {inv.role} · sent {inv.sent} · expires {inv.expires}
                  </div>
                </div>
                <button
                  className="fw-btn outline sm"
                  onClick={() => dispatch({ type: 'toast', message: `Invite resent to ${inv.email}` })}
                >
                  <WebIcon name="refresh" size={14} />
                  Resend
                </button>
                <button
                  className="fw-btn ghost sm"
                  onClick={() => dispatch({ type: 'modal', modal: { kind: 'revoke-invite', invite: inv } })}
                  title="Revoke invite"
                >
                  <WebIcon name="x" size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Danger zone */}
      <div className="fw-danger-zone">
        <div className="fw-danger-zone-title">Danger zone</div>
        {!isOwner && (
          <div className="fw-danger-card">
            <div className="fw-danger-card-body">
              <div className="fw-danger-card-title">Leave workspace</div>
              <div className="fw-danger-card-sub">You'll lose access to {workspace.name}. The owner can re-invite you anytime.</div>
            </div>
            <button className="fw-btn danger">Leave workspace</button>
          </div>
        )}
        {isOwner && members.length > 1 && (
          <div className="fw-danger-card">
            <div className="fw-danger-card-body">
              <div className="fw-danger-card-title">Transfer ownership</div>
              <div className="fw-danger-card-sub">Make another member the owner. You'll become an editor.</div>
            </div>
            <button className="fw-btn danger">Transfer ownership</button>
          </div>
        )}
        {isOwner && members.length === 1 && !workspace.personal && (
          <div className="fw-danger-card">
            <div className="fw-danger-card-body">
              <div className="fw-danger-card-title">Delete workspace</div>
              <div className="fw-danger-card-sub">This deletes all transactions, categories, and budgets in this workspace.</div>
            </div>
            <button className="fw-btn danger">Delete workspace</button>
          </div>
        )}
        {isOwner && workspace.personal && (
          <div className="fw-danger-card" style={{ opacity: 0.6 }}>
            <div className="fw-danger-card-body">
              <div className="fw-danger-card-title">This is your personal workspace</div>
              <div className="fw-danger-card-sub">Personal workspaces can't be deleted. To delete everything, delete your Fina account from the Account page.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

Object.assign(window, { HomePage, BanksPage, WorkspacePage });
