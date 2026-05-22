// shell.jsx — Status bar, app header, tab bar, etc.

// Fina logo mark — official PNG logo.
const FinaMark = ({ size = 28, radius = 8 }) => (
  <img
    src="assets/fina-logo-mark.png"
    alt=""
    width={size}
    height={size}
    style={{ display: 'block', objectFit: 'contain' }}
  />
);

// Full lockup (mark + wordmark)
const FinaLogoFull = ({ height = 32, white = false }) => (
  <img
    src={white ? "assets/fina-logo-full-white.png" : "assets/fina-logo-full.png"}
    alt="Fina"
    height={height}
    style={{ display: 'block', height: `${height}px`, width: 'auto' }}
  />
);

const StatusBar = ({ dark = false, time = '9:41' }) => {
  const c = dark ? '#fff' : '#000';
  return (
    <div style={{
      height: 47, paddingTop: 17, paddingLeft: 28, paddingRight: 28,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{ font: '600 16px -apple-system, system-ui, sans-serif', color: c, letterSpacing: '-0.3px' }}>{time}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* signal */}
        <svg width="18" height="11" viewBox="0 0 18 11"><g fill={c}>
          <rect x="0" y="7" width="3" height="4" rx="0.5" />
          <rect x="5" y="5" width="3" height="6" rx="0.5" />
          <rect x="10" y="2" width="3" height="9" rx="0.5" />
          <rect x="15" y="0" width="3" height="11" rx="0.5" />
        </g></svg>
        {/* wifi */}
        <svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke={c} strokeWidth="1.5">
          <path d="M1.5 4c2-2 4.5-3 7-3s5 1 7 3" />
          <path d="M4 7c1.2-1.2 2.5-1.7 4-1.7s2.8.5 4 1.7" />
          <circle cx="8" cy="10" r="0.8" fill={c} stroke="none" />
        </svg>
        {/* battery */}
        <svg width="27" height="12" viewBox="0 0 27 12">
          <rect x="0.5" y="0.5" width="22" height="11" rx="3" stroke={c} fill="none" opacity="0.4" />
          <rect x="2" y="2" width="19" height="8" rx="1.5" fill={c} />
          <rect x="23.5" y="4" width="1.5" height="4" rx="0.5" fill={c} opacity="0.4" />
        </svg>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────
// Tab bar
// ──────────────────────────────────────────────
const TabBar = ({ active = 'home', badges = {} }) => {
  const tabs = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'tx', label: 'Activity', icon: 'list' },
    { id: 'chat', label: 'Chat', icon: 'chat', center: true },
    { id: 'goals', label: 'Goals', icon: 'target' },
    { id: 'more', label: 'More', icon: 'menu' },
  ];
  return (
    <div className="fm-tabbar">
      {tabs.map(t => (
        <button key={t.id} className={`fm-tab${active === t.id ? ' active' : ''}${t.center ? ' center' : ''}`}>
          {t.center ? (
            <div className={`fm-tab-fab${active === t.id ? ' active' : ''}`}>
              <Icon name={t.icon} size={22} strokeWidth={1.8} color="#fff" />
            </div>
          ) : (
            <Icon name={t.icon} size={24} strokeWidth={active === t.id ? 1.8 : 1.6} />
          )}
          {!t.center && <span>{t.label}</span>}
          {t.center && <span style={{ marginTop: 2 }}>{t.label}</span>}
          {badges[t.id] && typeof badges[t.id] === 'number' && (
            <span className="fm-tab-badge">{badges[t.id]}</span>
          )}
          {badges[t.id] === 'dot' && (
            <span className="fm-tab-dot" style={{ background: '#e6b85c' }} />
          )}
          {badges[t.id] === 'dot-red' && (
            <span className="fm-tab-dot" style={{ background: 'var(--color-down)' }} />
          )}
        </button>
      ))}
    </div>
  );
};

// ──────────────────────────────────────────────
// App header (custom — replaces IOSNavBar)
// ──────────────────────────────────────────────
const Header = ({ title, dark = false, actions = null, subtitle, back = false, workspace }) => (
  <div className="fm-header">
    {back && (
      <button className="fm-header-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
    )}
    <div>
      <h1>{title}</h1>
      {(workspace || subtitle) && (
        <div className="fm-header-sub" style={{
          color: dark ? 'var(--color-on-dark-soft)' : 'var(--color-body)',
        }}>
          {workspace && (
            <button className="fm-workspace-switch" aria-label="Switch workspace">
              {workspace}
              <Icon name="chevDown" size={11} strokeWidth={2.2} />
            </button>
          )}
          {workspace && subtitle && <span className="fm-header-sub-sep">·</span>}
          {subtitle}
        </div>
      )}
    </div>
    {actions && <div className="fm-header-actions">{actions}</div>}
  </div>
);

const IconBtn = ({ icon, dark, onClick, size = 18 }) => (
  <button className="fm-iconbtn" onClick={onClick}>
    <Icon name={icon} size={size} />
  </button>
);

// ──────────────────────────────────────────────
// ChatHeader — chat detail surface header.
// Left: chevLeft (back to previous screen)
// Center: title
// Right: clock (open chat history list) + edit (start a new chat)
// Chat is a full-screen surface — no TabBar underneath.
// ──────────────────────────────────────────────
const ChatHeader = ({ title = 'Chat', dark = false, rightAction = null, noBorder = false }) => (
  <div className={`fm-chathead${noBorder ? ' no-border' : ''}`}>
    <div className="fm-chathead-actions left">
      <button className="fm-chathead-btn" aria-label="Back">
        <Icon name="chevLeft" size={24} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-chathead-center">
      <div className="fm-chathead-title">{title}</div>
    </div>
    <div className="fm-chathead-actions right">
      {rightAction || (
        <>
          <button className="fm-chathead-btn" aria-label="Chat history">
            <Icon name="clock" size={22} strokeWidth={1.8} />
          </button>
          <button className="fm-chathead-btn" aria-label="New chat">
            <Icon name="edit" size={20} strokeWidth={1.8} />
          </button>
        </>
      )}
    </div>
  </div>
);
// Kept as alias for any existing references.
const ChatBar = ChatHeader;

// ──────────────────────────────────────────────
// ChatHistoryHeader — drill-in style header used on the chat history list.
// Left: chev-left (back to chat thread), Center: "Chats", Right: edit (new chat).
// ──────────────────────────────────────────────
const ChatHistoryHeader = ({ title = 'Chats', dark = false, noBorder = false }) => (
  <div className={`fm-chathead${noBorder ? ' no-border' : ''}`}>
    <div className="fm-chathead-actions left">
      <button className="fm-chathead-btn" aria-label="Back to chat">
        <Icon name="chevLeft" size={24} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-chathead-center">
      <div className="fm-chathead-title">{title}</div>
    </div>
    <div className="fm-chathead-actions right">
      <button className="fm-chathead-btn" aria-label="New chat">
        <Icon name="edit" size={20} strokeWidth={1.8} />
      </button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// Phone wrapper (IOSDevice without nav bar, status bar overlaid)
// ──────────────────────────────────────────────
const Phone = ({ children, dark = false }) => (
  <div style={{ position: 'relative', width: 402, height: 874 }}>
    <IOSDevice dark={dark}>
      <div className={`fm-screen${dark ? ' dark' : ''}`}>
        {children}
      </div>
    </IOSDevice>
  </div>
);

Object.assign(window, { FinaMark, FinaLogoFull, StatusBar, TabBar, Header, IconBtn, Phone, ChatBar, ChatHeader, ChatHistoryHeader });
