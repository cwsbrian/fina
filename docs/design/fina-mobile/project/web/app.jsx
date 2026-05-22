// app.jsx — Top-level router + shared state. Hash-based routing.
// All pages live in this single SPA; AppShell wraps auth-required ones.

const INITIAL_STATE = {
  // Session
  signedIn: true, // start signed-in to land on Home
  user: {
    name: 'Brian Hwang',
    email: 'brian@hwang.dev',
    initials: 'BH',
  },

  // Workspace
  workspace: {
    id: 'ws-personal',
    name: 'Brian\u2019s household',
    role: 'owner',
    personal: true,
  },
  allWorkspaces: [
    { id: 'ws-personal', name: 'Brian\u2019s household', role: 'owner', color: '#0a0b0d', personal: true },
    { id: 'ws-roommates', name: '120 Spadina · roommates', role: 'editor', color: '#b85c2e' },
  ],

  // Tier — Pro trial per the brief
  tier: 'trial',
  trialDays: 23,
  trialEndsAt: 'June 12, 2026',
  renewalDate: 'June 12, 2026',

  // Banks
  banks: [
    {
      id: 'b-rbc',
      name: 'RBC Royal Bank',
      logoClass: 'rbc',
      status: 'active',
      synced: '4 min ago',
      accounts: [
        { name: 'RBC Day to Day Banking', mask: '8421', balance: '$2,847.16' },
        { name: 'Visa Avion',              mask: '4023', balance: '\u2212$1,284.92' },
        { name: 'High Interest eSavings',  mask: '9920', balance: '$14,300.00' },
      ],
    },
  ],

  // Members
  members: [
    { id: 'm-brian', name: 'Brian Hwang',  email: 'brian@hwang.dev', role: 'owner',  initials: 'BH', isYou: true, color: '' },
    { id: 'm-jenna', name: 'Jenna Hwang',  email: 'jenna@hwang.dev', role: 'editor', initials: 'JH', color: 'alt2' },
    { id: 'm-mom',   name: 'Yumi Hwang',   email: 'yumi@hwang.dev',  role: 'viewer', initials: 'YH', color: 'alt3' },
  ],
  pendingInvites: [
    { id: 'i-1', email: 'dad@hwang.dev', role: 'viewer', sent: 'May 18', expires: 'May 25' },
  ],

  // UI state
  path: '/home',
  inviteContext: null,
  resetEmail: '',
  pendingUser: null,
  modal: null,
  toast: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'navigate': {
      const path = action.path;
      // Drop invite context when leaving the invite flow
      const inviteContext = (path === '/sign-in' && state.inviteContext) ? state.inviteContext : null;
      // Reset path-derived state
      const next = { ...state, path };
      if (path !== '/sign-in') next.inviteContext = null;
      else next.inviteContext = inviteContext;
      if (window.location.hash !== '#' + path) {
        window.location.hash = path;
      }
      return next;
    }
    case 'signIn':
      return { ...state, signedIn: true, user: { ...state.user, ...action.user, initials: initialsFrom(action.user.name || action.user.email) }, path: '/home', inviteContext: null };
    case 'signOut':
      return { ...state, signedIn: false, path: '/sign-in' };
    case 'switchWorkspace': {
      const ws = state.allWorkspaces.find(w => w.id === action.id);
      if (!ws) return state;
      // Different members + banks per workspace (demo)
      let members = state.members;
      let banks = state.banks;
      if (ws.id === 'ws-roommates') {
        members = [
          { id: 'm-brian',  name: 'Brian Hwang',     email: 'brian@hwang.dev',  role: 'editor', initials: 'BH', isYou: true, color: '' },
          { id: 'm-jay',    name: 'Jay Park',        email: 'jay@example.com',  role: 'owner',  initials: 'JP', color: 'alt2' },
          { id: 'm-elise',  name: 'Elise Tremblay',  email: 'elise@example.com', role: 'editor', initials: 'ET', color: 'alt3' },
          { id: 'm-marc',   name: 'Marc Bouchard',   email: 'marc@example.com', role: 'editor', initials: 'MB', color: 'alt4' },
        ];
        banks = [];
      }
      return { ...state, workspace: { id: ws.id, name: ws.name, role: ws.role, personal: !!ws.personal }, members, banks };
    }
    case 'addWorkspace':
      return { ...state, allWorkspaces: [...state.allWorkspaces, action.ws] };
    case 'renameWorkspace':
      return {
        ...state,
        workspace: { ...state.workspace, name: action.name },
        allWorkspaces: state.allWorkspaces.map(w => w.id === state.workspace.id ? { ...w, name: action.name } : w),
      };
    case 'addBank':
      return { ...state, banks: [...state.banks, action.bank] };
    case 'removeBank':
      return { ...state, banks: state.banks.filter(b => b.id !== action.id) };
    case 'changeRole':
      return { ...state, members: state.members.map(m => m.id === action.id ? { ...m, role: action.role } : m) };
    case 'removeMember':
      return { ...state, members: state.members.filter(m => m.id !== action.id) };
    case 'invite':
      return {
        ...state,
        pendingInvites: [
          ...state.pendingInvites,
          {
            id: 'i-' + Date.now(),
            email: action.email,
            role: action.role,
            sent: shortDate(new Date()),
            expires: shortDate(new Date(Date.now() + 7 * 86400000)),
          },
        ],
      };
    case 'revokeInvite':
      return { ...state, pendingInvites: state.pendingInvites.filter(i => i.id !== action.id) };
    case 'updateUser':
      return { ...state, user: { ...state.user, ...action.user, initials: initialsFrom(action.user.name || state.user.name) } };
    case 'setInviteContext':
      return { ...state, inviteContext: action.context };
    case 'setResetEmail':
      return { ...state, resetEmail: action.email };
    case 'setPendingUser':
      return { ...state, pendingUser: action.user };
    case 'clearPendingUser':
      return { ...state, pendingUser: null };
    case 'setTier':
      return { ...state, tier: action.tier };
    case 'modal':
      return { ...state, modal: action.modal };
    case 'closeModal':
      return { ...state, modal: null };
    case 'toast':
      return { ...state, toast: { id: Date.now(), message: action.message } };
    case 'clearToast':
      return { ...state, toast: null };
    default:
      return state;
  }
}

function initialsFrom(input) {
  if (!input) return '';
  const parts = input.split('@')[0].split(/\s+|[.\-_]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.slice(0, 2) || '').toUpperCase();
}
function shortDate(d) {
  return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
}

// ─────────────────────────────────────────────────────────
// Page-level routing
// ─────────────────────────────────────────────────────────
const PUBLIC_PATHS = ['/sign-in', '/verify-email', '/forgot-password', '/forgot-password/sent', '/reset-password', '/invites/abc123'];

const Router = ({ state, dispatch }) => {
  const { path, signedIn, modal } = state;
  const isPublic = PUBLIC_PATHS.some(p => path === p || path.startsWith(p + '/'));

  // Auth redirect: signed out + auth path → /sign-in. Signed in + /sign-in → /home (unless inviting).
  React.useEffect(() => {
    if (!signedIn && !isPublic) {
      dispatch({ type: 'navigate', path: '/sign-in' });
    }
  }, [signedIn, path]);

  let page;
  if (path === '/sign-in') page = <SignInPage state={state} dispatch={dispatch} />;
  else if (path === '/verify-email') page = <EmailVerifyPage state={state} dispatch={dispatch} />;
  else if (path === '/forgot-password') page = <ForgotPasswordPage state={state} dispatch={dispatch} />;
  else if (path === '/forgot-password/sent') page = <CheckEmailPage state={state} dispatch={dispatch} />;
  else if (path === '/reset-password') page = <ResetPasswordPage state={state} dispatch={dispatch} />;
  else if (path.startsWith('/invites/')) page = <InviteAcceptPage state={state} dispatch={dispatch} />;
  else if (!signedIn) page = <SignInPage state={state} dispatch={dispatch} />;
  else {
    let inner;
    let current;
    if (path === '/home') { inner = <HomePage state={state} dispatch={dispatch} />; current = 'home'; }
    else if (path === '/settings/banks')     { inner = <BanksPage state={state} dispatch={dispatch} />;     current = 'banks'; }
    else if (path === '/settings/workspace') { inner = <WorkspacePage state={state} dispatch={dispatch} />; current = 'workspace'; }
    else if (path === '/settings/plan')      { inner = <PlanPage state={state} dispatch={dispatch} />;      current = 'plan'; }
    else if (path === '/settings/billing')   { inner = <BillingPage state={state} dispatch={dispatch} />;   current = 'billing'; }
    else if (path === '/settings/account')   { inner = <AccountPage state={state} dispatch={dispatch} />;   current = 'account'; }
    else { inner = <HomePage state={state} dispatch={dispatch} />; current = 'home'; }
    page = <AppShell state={state} dispatch={dispatch} current={current}>{inner}</AppShell>;
  }

  return (
    <>
      {page}
      <ModalLayer state={state} dispatch={dispatch} />
      {state.toast && (
        <SuccessToast
          key={state.toast.id}
          message={state.toast.message}
          onClose={() => dispatch({ type: 'clearToast' })}
        />
      )}
      <DevSwitcher state={state} dispatch={dispatch} />
    </>
  );
};

// Modal layer — single home for all dialogs
const ModalLayer = ({ state, dispatch }) => {
  const m = state.modal;
  if (!m) return null;
  const close = () => dispatch({ type: 'closeModal' });

  if (m.kind === 'stripe') {
    return (
      <StripeCheckout
        plan={m.plan}
        onClose={close}
        onSuccess={() => {
          dispatch({ type: 'closeModal' });
          dispatch({ type: 'setTier', tier: m.plan.name.toLowerCase() === 'pro' ? 'pro' : (m.plan.name.toLowerCase() === 'lite' ? 'lite' : 'free') });
          dispatch({ type: 'toast', message: `Subscribed to ${m.plan.name} \u2014 you're all set` });
        }}
      />
    );
  }
  if (m.kind === 'disconnect-bank') {
    return (
      <DisconnectBankModal
        bankName={m.bank.name}
        onClose={close}
        onConfirm={() => {
          dispatch({ type: 'removeBank', id: m.bank.id });
          dispatch({ type: 'closeModal' });
          dispatch({ type: 'toast', message: `Disconnected ${m.bank.name}` });
        }}
      />
    );
  }
  if (m.kind === 'remove-member') {
    return (
      <RemoveMemberModal
        memberName={m.member.name}
        onClose={close}
        onConfirm={() => {
          dispatch({ type: 'removeMember', id: m.member.id });
          dispatch({ type: 'closeModal' });
          dispatch({ type: 'toast', message: `Removed ${m.member.name}` });
        }}
      />
    );
  }
  if (m.kind === 'revoke-invite') {
    return (
      <RevokeInviteModal
        email={m.invite.email}
        onClose={close}
        onConfirm={() => {
          dispatch({ type: 'revokeInvite', id: m.invite.id });
          dispatch({ type: 'closeModal' });
          dispatch({ type: 'toast', message: 'Invite revoked' });
        }}
      />
    );
  }
  if (m.kind === 'cancel-sub') {
    return (
      <CancelSubModal
        renewalDate={state.renewalDate}
        onClose={close}
        onConfirm={() => {
          dispatch({ type: 'setTier', tier: 'free' });
          dispatch({ type: 'closeModal' });
          dispatch({ type: 'toast', message: `Subscription canceled \u2014 access ends ${state.renewalDate}` });
        }}
      />
    );
  }
  if (m.kind === 'signout-device') {
    return (
      <SignOutDeviceModal
        device={m.device}
        onClose={close}
        onConfirm={() => {
          dispatch({ type: 'closeModal' });
          dispatch({ type: 'toast', message: `Signed out ${m.device}` });
        }}
      />
    );
  }
  if (m.kind === 'delete-account') {
    return (
      <DeleteAccountModal
        onClose={close}
        onConfirm={() => {
          dispatch({ type: 'closeModal' });
          dispatch({ type: 'signOut' });
          dispatch({ type: 'toast', message: 'Account deleted' });
        }}
      />
    );
  }
  return null;
};

// ─────────────────────────────────────────────────────────
// Dev page switcher — small fixed pill, bottom-right.
// Lets the reviewer jump between routes without typing.
// ─────────────────────────────────────────────────────────
const ROUTES = [
  { path: '/sign-in',                 label: 'Sign in / Sign up',  group: 'Public' },
  { path: '/verify-email',            label: 'Verify email · OTP', group: 'Public' },
  { path: '/forgot-password',         label: 'Forgot password',    group: 'Public' },
  { path: '/forgot-password/sent',    label: 'Check your email',   group: 'Public' },
  { path: '/reset-password',          label: 'Reset password',     group: 'Public' },
  { path: '/invites/abc123',      label: 'Invite accept',     group: 'Public' },
  { path: '/home',                label: 'Home',              group: 'App' },
  { path: '/settings/banks',      label: 'Banks',             group: 'App' },
  { path: '/settings/workspace',  label: 'Workspace',         group: 'App' },
  { path: '/settings/plan',       label: 'Plan',              group: 'App' },
  { path: '/settings/billing',    label: 'Billing',           group: 'App' },
  { path: '/settings/account',    label: 'Account',           group: 'App' },
];

const DevSwitcher = ({ state, dispatch }) => {
  const [open, setOpen] = React.useState(false);
  const grouped = ROUTES.reduce((a, r) => { (a[r.group] ||= []).push(r); return a; }, {});
  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          position: 'fixed',
          bottom: 24, right: 24,
          height: 40, padding: '0 16px',
          borderRadius: 999,
          background: 'var(--color-ink)',
          color: '#fff',
          border: 0,
          font: '12px var(--font-sans)',
          fontWeight: 600,
          letterSpacing: '0.4px',
          textTransform: 'uppercase',
          cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(10,11,13,0.20)',
          zIndex: 70,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <WebIcon name="layers" size={14} strokeWidth={2} />
        Pages
      </button>
      {open && (
        <>
          <div className="fw-scrim" onClick={() => setOpen(false)} style={{ zIndex: 69 }} />
          <div style={{
            position: 'fixed',
            bottom: 76, right: 24,
            width: 280,
            background: 'var(--color-canvas)',
            border: '1px solid var(--color-hairline)',
            borderRadius: 16,
            boxShadow: '0 16px 40px rgba(10,11,13,0.16)',
            padding: 8,
            zIndex: 70,
            maxHeight: '70vh',
            overflowY: 'auto',
          }}>
            {Object.entries(grouped).map(([group, items]) => (
              <div key={group}>
                <div style={{
                  padding: '12px 12px 6px',
                  font: '10px var(--font-sans)',
                  fontWeight: 700,
                  letterSpacing: '0.6px',
                  textTransform: 'uppercase',
                  color: 'var(--color-muted)',
                }}>{group}</div>
                {items.map(r => (
                  <button
                    key={r.path}
                    className={`fw-menu-item ${state.path === r.path ? 'active' : ''}`}
                    onClick={() => { dispatch({ type: 'navigate', path: r.path }); setOpen(false); }}
                  >
                    <span style={{ flex: 1 }}>{r.label}</span>
                    <span style={{ font: '11px var(--font-mono)', color: 'var(--color-muted)' }}>{r.path}</span>
                  </button>
                ))}
              </div>
            ))}
            <div className="fw-menu-divider"></div>
            <div style={{ padding: '6px 12px 10px', font: '10px var(--font-sans)', fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
              Tier
            </div>
            <div style={{ display: 'flex', gap: 4, padding: '0 8px 8px' }}>
              {['trial', 'pro', 'lite', 'free'].map(t => (
                <button
                  key={t}
                  onClick={() => { dispatch({ type: 'setTier', tier: t }); }}
                  style={{
                    flex: 1,
                    padding: '6px 4px',
                    borderRadius: 8,
                    border: 0,
                    background: state.tier === t ? 'var(--color-ink)' : 'var(--color-surface-soft)',
                    color: state.tier === t ? '#fff' : 'var(--color-body)',
                    font: '11px var(--font-sans)',
                    fontWeight: 600,
                    letterSpacing: '0.3px',
                    textTransform: 'capitalize',
                    cursor: 'pointer',
                  }}
                >{t}</button>
              ))}
            </div>
            <div className="fw-menu-divider"></div>
            <button
              className="fw-menu-item"
              onClick={() => { dispatch({ type: state.signedIn ? 'signOut' : 'signIn', user: state.user }); setOpen(false); }}
            >
              <WebIcon name={state.signedIn ? 'logOut' : 'arrowRight'} size={14} color="var(--color-muted)" />
              <span>{state.signedIn ? 'Sign out (demo)' : 'Sign in (demo)'}</span>
            </button>
          </div>
        </>
      )}
    </>
  );
};

// ─────────────────────────────────────────────────────────
// App root
// ─────────────────────────────────────────────────────────
const App = () => {
  const [state, dispatch] = React.useReducer(reducer, INITIAL_STATE);
  const [tw, setTweak] = useTweaks(window.WEB_TWEAK_DEFAULTS || { themeColor: '#7dd8b8', canvasColor: '#fbfcfb' });

  // Hydrate from hash on mount + listen to hash changes
  React.useEffect(() => {
    const fromHash = () => {
      const h = window.location.hash.replace(/^#/, '') || '/home';
      if (h !== state.path) dispatch({ type: 'navigate', path: h });
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply tweak overrides as CSS vars on a wrapper element.
  // We want them on <html> so the body bg picks them up too.
  React.useEffect(() => {
    document.documentElement.style.setProperty('--color-primary', tw.themeColor);
    document.documentElement.style.setProperty('--color-canvas', tw.canvasColor);
  }, [tw.themeColor, tw.canvasColor]);

  return (
    <>
      <Router state={state} dispatch={dispatch} />
      <TweaksPanel title="Theme">
        <TweakSection label="Colors" />
        <TweakColor
          label="Accent color"
          value={tw.themeColor}
          onChange={(v) => setTweak('themeColor', v)}
          options={['#3eb38b', '#7dd8b8', '#1c2f45', '#8fb8e8', '#e6b85c', '#15201e']}
        />
        <TweakColor
          label="Canvas / background"
          value={tw.canvasColor}
          onChange={(v) => setTweak('canvasColor', v)}
          options={['#fbfcfb', '#ffffff', '#f4f7f5', '#f8f4ec', '#f2f5f3', '#eef2ee']}
        />
      </TweaksPanel>
    </>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
