// shell.jsx — Top navigation, workspace switcher, user menu, tier badge.
// Used on all auth-required pages.

const NAV_ITEMS = [
  { id: 'home', label: 'Home', path: '/home' },
  { id: 'banks', label: 'Banks', path: '/settings/banks' },
  { id: 'workspace', label: 'Workspace', path: '/settings/workspace' },
  { id: 'plan', label: 'Plan', path: '/settings/plan' },
  { id: 'billing', label: 'Billing', path: '/settings/billing' },
  { id: 'account', label: 'Account', path: '/settings/account' },
];

const TIER_META = {
  trial: { label: 'Pro trial', dot: true },
  pro:   { label: 'Pro', dot: true },
  lite:  { label: 'Lite', dot: true },
  free:  { label: 'Free', dot: true },
};

const Brand = ({ onClick }) => (
  <a className="fw-brand" onClick={onClick} role="button" tabIndex={0}>
    <span className="fw-brand-mark" aria-hidden="true"></span>
    <span className="fw-brand-word">Fina</span>
  </a>
);

// Tier badge — TRIAL is amber w/ days remaining
const TierBadge = ({ tier, trialDays, onClick }) => {
  const meta = TIER_META[tier] || TIER_META.free;
  const cls = `fw-tier-badge ${tier}`;
  return (
    <button className={cls} onClick={onClick} title={`${meta.label} plan`}>
      <span className="dot"></span>
      {tier === 'trial' ? `Trial · ${trialDays}d left` : meta.label}
    </button>
  );
};

// Workspace switcher — pill with chevron, opens dropdown.
const WorkspaceSwitcher = ({ workspace, allWorkspaces, onSwitch }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="fw-ws">
      <button className="fw-ws-btn" onClick={() => setOpen(o => !o)}>
        <span>{workspace.name}</span>
        <span className="role">{workspace.role}</span>
        <WebIcon name="chevDown" size={14} strokeWidth={2} color="var(--color-muted)" />
      </button>
      {open && (
        <>
          <div className="fw-scrim" onClick={() => setOpen(false)} />
          <div className="fw-menu" style={{ minWidth: 300 }}>
            <div className="fw-menu-head">
              <div className="fw-menu-head-name">Workspaces</div>
              <div className="fw-menu-head-mail">{allWorkspaces.length} {allWorkspaces.length === 1 ? 'workspace' : 'workspaces'}</div>
            </div>
            {allWorkspaces.map(w => (
              <button
                key={w.id}
                className={`fw-menu-item ${w.id === workspace.id ? 'active' : ''}`}
                onClick={() => { onSwitch(w.id); setOpen(false); }}
              >
                <div style={{
                  width: 28, height: 28, borderRadius: 8,
                  background: w.color || 'var(--color-surface-strong)',
                  color: '#fff',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  font: '13px var(--font-sans)', fontWeight: 600, letterSpacing: '-0.3px',
                  flexShrink: 0,
                }}>{w.name.charAt(0)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--color-ink)' }}>{w.name}</div>
                  <div style={{ font: '11px var(--font-sans)', color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600, marginTop: 1 }}>{w.role}</div>
                </div>
                {w.id === workspace.id && <WebIcon name="check" size={16} strokeWidth={2.2} color="var(--color-primary)" />}
              </button>
            ))}
            <div className="fw-menu-divider"></div>
            <button className="fw-menu-item" onClick={() => { setOpen(false); }}>
              <WebIcon name="plus" size={16} strokeWidth={2} color="var(--color-muted)" />
              <span>Create new workspace</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// User avatar menu
const UserMenu = ({ user, onNavigate, onSignOut }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="fw-ws">
      <button className="fw-avatar-btn" onClick={() => setOpen(o => !o)} title={user.name}>
        {user.initials}
      </button>
      {open && (
        <>
          <div className="fw-scrim" onClick={() => setOpen(false)} />
          <div className="fw-menu">
            <div className="fw-menu-head">
              <div className="fw-menu-head-name">{user.name}</div>
              <div className="fw-menu-head-mail">{user.email}</div>
            </div>
            <button className="fw-menu-item" onClick={() => { onNavigate('/settings/account'); setOpen(false); }}>
              <WebIcon name="user" size={16} color="var(--color-muted)" />
              <span>Account settings</span>
            </button>
            <button className="fw-menu-item" onClick={() => { onNavigate('/settings/plan'); setOpen(false); }}>
              <WebIcon name="card" size={16} color="var(--color-muted)" />
              <span>Plan & billing</span>
            </button>
            <button className="fw-menu-item" onClick={() => { onNavigate('/settings/billing'); setOpen(false); }}>
              <WebIcon name="receipt" size={16} color="var(--color-muted)" />
              <span>Invoices</span>
            </button>
            <button className="fw-menu-item" onClick={() => { onNavigate('/home'); setOpen(false); }}>
              <WebIcon name="smartphone" size={16} color="var(--color-muted)" />
              <span>Get the mobile app</span>
            </button>
            <div className="fw-menu-divider"></div>
            <button className="fw-menu-item danger" onClick={() => { onSignOut(); setOpen(false); }}>
              <WebIcon name="logOut" size={16} />
              <span>Sign out</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// ──────────────────────────────────────────────
// Full app shell. Renders nav + children.
// ──────────────────────────────────────────────
const AppShell = ({ state, dispatch, current, children }) => {
  const { user, workspace, allWorkspaces, tier, trialDays } = state;
  return (
    <div className="fw-shell">
      <nav className="fw-nav">
        <div className="fw-nav-inner">
          <Brand onClick={() => dispatch({ type: 'navigate', path: '/home' })} />
          <div className="fw-nav-links">
            {NAV_ITEMS.map(it => (
              <button
                key={it.id}
                className={`fw-nav-link ${current === it.id ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'navigate', path: it.path })}
              >
                {it.label}
              </button>
            ))}
          </div>
          <div className="fw-nav-right">
            <TierBadge
              tier={tier}
              trialDays={trialDays}
              onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
            />
            <WorkspaceSwitcher
              workspace={workspace}
              allWorkspaces={allWorkspaces}
              onSwitch={(id) => dispatch({ type: 'switchWorkspace', id })}
            />
            <UserMenu
              user={user}
              onNavigate={(path) => dispatch({ type: 'navigate', path })}
              onSignOut={() => dispatch({ type: 'signOut' })}
            />
          </div>
        </div>
      </nav>
      <main className="fw-page">{children}</main>
    </div>
  );
};

window.AppShell = AppShell;
