// settings-pages.jsx — Plan / Billing + Account pages.

// ═══════════════════════════════════════════════════════════
// PLAN & BILLING
// ═══════════════════════════════════════════════════════════
const PLANS = {
  free: { name: 'Free',  price: 0,  banks: 'Manual / CSV only', ai: 'No AI', ritual: '—',     sharing: 'Workspace sharing', csv: 'CSV import' },
  lite: { name: 'Lite',  price: 7,  banks: '1 bank',            ai: 'Daily ritual only', ritual: 'Morning brief', sharing: 'Workspace sharing', csv: 'CSV import' },
  pro:  { name: 'Pro',   price: 15, banks: 'Unlimited banks',   ai: 'Full chat + ritual', ritual: 'Morning brief', sharing: 'Workspace sharing', csv: 'CSV import' },
};

const COMPARE_ROWS = [
  { label: 'Bank connections',  free: 'None',           lite: '1 bank',          pro: 'Unlimited',          highlight: true },
  { label: 'AI chat',            free: 'No',             lite: 'Daily ritual only', pro: 'Full two-way chat', highlight: true },
  { label: 'Daily morning brief', free: false,           lite: true,              pro: true },
  { label: 'Workspace sharing',  free: true,             lite: true,              pro: true },
  { label: 'Manual entry',       free: true,             lite: true,              pro: true },
  { label: 'CSV import',         free: true,             lite: true,              pro: true },
  { label: 'Support',            free: 'Email',          lite: 'Email',           pro: 'Priority email' },
];

const PlanPage = ({ state, dispatch }) => {
  const { tier, trialDays, trialEndsAt, renewalDate } = state;
  const isTrial = tier === 'trial';

  // The "current" tier shown in comparison highlight
  const currentForCompare = isTrial ? 'pro' : tier;

  const openCheckout = (planKey) => {
    dispatch({ type: 'modal', modal: { kind: 'stripe', plan: PLANS[planKey] } });
  };

  return (
    <div className="fw-container">
      <div className="fw-page-head">
        <h1 className="fw-page-title">Plan & billing</h1>
        <p className="fw-page-sub">Subscriptions are per-user. Members can be on different tiers in the same workspace.</p>
      </div>

      {/* Current plan card */}
      <div className="fw-section">
        <div className="fw-plan-current">
          <div className="fw-plan-current-body">
            <div className="fw-plan-current-label">Your plan</div>
            <div className="fw-plan-current-name">
              {isTrial ? 'Pro' : PLANS[tier]?.name || 'Free'}
              <span className={`fw-pill ${isTrial ? 'status-warn' : (tier === 'free' ? 'status-neutral' : 'status-active')}`}>
                <span className="dot"></span>
                {isTrial ? 'Trial' : tier === 'free' ? 'Free tier' : 'Active'}
              </span>
            </div>
            <div className="fw-plan-current-status">
              {isTrial && (
                <>Trial ends <strong>{trialEndsAt}</strong>. After trial, you'll move to Free unless you add a payment method.</>
              )}
              {tier === 'pro' && (
                <>${PLANS.pro.price}/mo · renews <strong>{renewalDate}</strong></>
              )}
              {tier === 'lite' && (
                <>${PLANS.lite.price}/mo · renews <strong>{renewalDate}</strong></>
              )}
              {tier === 'free' && (
                <>No active subscription. Bank connections and AI features are locked.</>
              )}
            </div>
            <div className="fw-plan-current-actions">
              {isTrial && (
                <button className="fw-btn primary" onClick={() => openCheckout('pro')}>
                  Add payment method
                </button>
              )}
              {(tier === 'pro' || tier === 'lite') && (
                <>
                  <button className="fw-btn outline" onClick={() => dispatch({ type: 'navigate', path: '/settings/billing' })}>
                    <WebIcon name="receipt" size={16} />
                    View invoices
                  </button>
                  <button
                    className="fw-btn ghost"
                    onClick={() => dispatch({ type: 'modal', modal: { kind: 'cancel-sub' } })}
                  >
                    Cancel subscription
                  </button>
                </>
              )}
              {tier === 'free' && (
                <button className="fw-btn primary" onClick={() => openCheckout('pro')}>
                  Start a plan
                </button>
              )}
            </div>
          </div>

          {isTrial && (
            <div className="fw-plan-trial-aside">
              <div className="fw-plan-trial-aside-days">{trialDays}</div>
              <div className="fw-plan-trial-aside-label">Days left on trial</div>
              <div className="fw-plan-trial-aside-date">Ends {trialEndsAt}</div>
            </div>
          )}
        </div>
      </div>

      {/* Plan comparison */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div>
            <div className="fw-section-title">Compare plans</div>
            <div className="fw-section-sub">Headline prices in CAD. Subscriptions purchased in the iOS or Android app are managed in the App Store or Google Play.</div>
          </div>
        </div>

        <div className="fw-plan-compare">
          {/* Header row */}
          <div className="fw-plan-compare-cell header" style={{ background: 'var(--color-canvas)', borderRight: '1px solid var(--color-hairline-soft)' }}>
            <div style={{ fontWeight: 600, color: 'var(--color-muted)', font: 'var(--type-caption-strong)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              For one user
            </div>
            <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-muted)', marginTop: 4 }}>
              Monthly billing
            </div>
          </div>
          {['free', 'lite', 'pro'].map(k => {
            const isCurrent = k === currentForCompare;
            return (
              <div key={k} className={`fw-plan-compare-cell header ${isCurrent ? 'current' : ''}`}>
                <div className="fw-plan-compare-tier">{PLANS[k].name}</div>
                <div className="fw-plan-compare-price">
                  ${PLANS[k].price}<small>/mo</small>
                </div>
                {isCurrent && (
                  <span className="fw-plan-compare-current-pill">
                    {isTrial ? 'Current · trial' : 'Current plan'}
                  </span>
                )}
              </div>
            );
          })}

          {/* Feature rows */}
          {COMPARE_ROWS.map((row, ri) => (
            <React.Fragment key={ri}>
              <div className="fw-plan-compare-cell label">{row.label}</div>
              {['free', 'lite', 'pro'].map(k => (
                <div key={k} className="fw-plan-compare-cell">
                  {row[k] === true ? (
                    <WebIcon name="check" size={18} strokeWidth={2.2} color="var(--color-up)" />
                  ) : row[k] === false ? (
                    <span className="no"><WebIcon name="x" size={16} strokeWidth={2} /></span>
                  ) : (
                    <span className={row.highlight ? 'yes' : ''} style={row.highlight ? { fontWeight: 500 } : { color: 'var(--color-body)' }}>
                      {row[k]}
                    </span>
                  )}
                </div>
              ))}
            </React.Fragment>
          ))}

          {/* Foot row — CTAs */}
          <div className="fw-plan-compare-cell foot" style={{ borderRight: '1px solid var(--color-hairline-soft)', alignItems: 'center', color: 'var(--color-muted)', font: 'var(--type-caption)' }}>
            Choose a plan
          </div>
          {['free', 'lite', 'pro'].map(k => {
            const isCurrent = k === currentForCompare;
            const lower = (k === 'free' && (currentForCompare === 'lite' || currentForCompare === 'pro')) ||
                          (k === 'lite' && currentForCompare === 'pro');
            const higher = !isCurrent && !lower;
            return (
              <div key={k} className="fw-plan-compare-cell foot">
                {isCurrent ? (
                  <button className="fw-btn outline" disabled>Current plan</button>
                ) : lower ? (
                  <button className="fw-btn outline" onClick={() => dispatch({ type: 'toast', message: `Opening Stripe portal to downgrade to ${PLANS[k].name}…` })}>
                    Downgrade
                  </button>
                ) : (
                  <button className="fw-btn primary" onClick={() => openCheckout(k)}>
                    {higher && tier === 'free' ? `Start ${PLANS[k].name}` : `Upgrade to ${PLANS[k].name}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="fw-billing-footnote">
          <strong style={{ color: 'var(--color-ink)' }}>Subscribed via mobile?</strong> Subscriptions purchased through the iOS or Android app are billed by Apple or Google and managed in those stores — not here.
        </div>
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════
// ACCOUNT
// ═══════════════════════════════════════════════════════════
const SESSIONS = [
  { id: 's1', device: 'Chrome · macOS', meta: 'Toronto, ON · Right now', icon: 'laptop', current: true },
  { id: 's2', device: 'Fina iOS · iPhone 15 Pro', meta: 'Toronto, ON · 12 hours ago', icon: 'smartphone', current: false },
  { id: 's3', device: 'Safari · iPad', meta: 'Toronto, ON · 4 days ago', icon: 'monitor', current: false },
];

const AccountPage = ({ state, dispatch }) => {
  const { user } = state;
  const [name, setName] = React.useState(user.name);
  const [email, setEmail] = React.useState(user.email);
  const [tz, setTz] = React.useState('America/Toronto');
  const [locale, setLocale] = React.useState('en');
  const [changingPw, setChangingPw] = React.useState(false);
  const [emailPending, setEmailPending] = React.useState(false);

  const dirty = name !== user.name || email !== user.email;

  const save = () => {
    if (email !== user.email) {
      setEmailPending(true);
      dispatch({ type: 'toast', message: `Verification sent to ${email}` });
    }
    dispatch({ type: 'updateUser', user: { ...user, name } });
    dispatch({ type: 'toast', message: 'Profile saved' });
  };

  return (
    <div className="fw-container">
      <div className="fw-page-head">
        <h1 className="fw-page-title">Account</h1>
        <p className="fw-page-sub">Your personal profile, password, and sessions. Settings here apply across all your workspaces.</p>
      </div>

      {/* Profile */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div className="fw-section-title">Profile</div>
        </div>
        <div className="fw-card">
          <div className="fw-profile-row">
            <div className="fw-profile-avatar-lg">{user.initials}</div>
            <div style={{ flex: 1 }}>
              <div style={{ font: 'var(--type-title-md)', fontWeight: 600, color: 'var(--color-ink)' }}>{user.name}</div>
              <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-body)', marginTop: 4 }}>{user.email}</div>
            </div>
            <button className="fw-btn outline sm" disabled>Upload photo</button>
          </div>

          <div className="fw-field">
            <label className="fw-field-label">Name</label>
            <input className="fw-input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="fw-field">
            <label className="fw-field-label">Email</label>
            <input
              className="fw-input"
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setEmailPending(false); }}
            />
            {emailPending && (
              <div className="fw-field-helper">
                <WebIcon name="mail" size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                Verification email sent to <strong style={{ color: 'var(--color-ink)' }}>{email}</strong>. Click the link to confirm.
              </div>
            )}
            {!emailPending && email !== user.email && (
              <div className="fw-field-helper">Changing your email requires re-verification via a link sent to the new address.</div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div className="fw-field" style={{ flex: 1, marginBottom: 0 }}>
              <label className="fw-field-label">Timezone</label>
              <select className="fw-select" value={tz} onChange={(e) => setTz(e.target.value)}>
                <option value="America/Toronto">Toronto (UTC−5)</option>
                <option value="America/Vancouver">Vancouver (UTC−8)</option>
                <option value="America/Edmonton">Edmonton (UTC−7)</option>
                <option value="America/Halifax">Halifax (UTC−4)</option>
              </select>
            </div>
            <div className="fw-field" style={{ flex: 1, marginBottom: 0 }}>
              <label className="fw-field-label">Language</label>
              <select className="fw-select" value={locale} onChange={(e) => setLocale(e.target.value)}>
                <option value="en">English</option>
                <option value="ko" disabled>한국어 (coming soon)</option>
              </select>
            </div>
          </div>

          {dirty && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--color-hairline-soft)' }}>
              <button className="fw-btn ghost" onClick={() => { setName(user.name); setEmail(user.email); setEmailPending(false); }}>Discard</button>
              <button className="fw-btn primary" onClick={save}>Save changes</button>
            </div>
          )}
        </div>
      </div>

      {/* Password */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div className="fw-section-title">Password</div>
        </div>
        {!changingPw ? (
          <div className="fw-card">
            <div className="fw-card-row">
              <div style={{ flex: 1 }}>
                <div style={{ font: 'var(--type-body-md)', fontWeight: 600, color: 'var(--color-ink)' }}>Change password</div>
                <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-body)', marginTop: 4 }}>Last changed 47 days ago.</div>
              </div>
              <button className="fw-btn outline" onClick={() => setChangingPw(true)}>Change password</button>
            </div>
          </div>
        ) : (
          <div className="fw-card">
            <div className="fw-field">
              <label className="fw-field-label">Current password</label>
              <input className="fw-input" type="password" autoFocus />
            </div>
            <div className="fw-field">
              <label className="fw-field-label">New password</label>
              <input className="fw-input" type="password" placeholder="At least 8 characters" />
            </div>
            <div className="fw-field" style={{ marginBottom: 0 }}>
              <label className="fw-field-label">Confirm new password</label>
              <input className="fw-input" type="password" />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--color-hairline-soft)' }}>
              <button className="fw-btn ghost" onClick={() => setChangingPw(false)}>Cancel</button>
              <button className="fw-btn primary" onClick={() => { setChangingPw(false); dispatch({ type: 'toast', message: 'Password updated' }); }}>Update password</button>
            </div>
          </div>
        )}
      </div>

      {/* Sessions */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div>
            <div className="fw-section-title">Active sessions</div>
            <div className="fw-section-sub">Devices currently signed in to your Fina account.</div>
          </div>
          <button className="fw-btn outline sm">
            <WebIcon name="logOut" size={14} />
            Sign out everywhere
          </button>
        </div>
        <div className="fw-group">
          {SESSIONS.map(s => (
            <div className="fw-session" key={s.id}>
              <span className="fw-session-glyph">
                <WebIcon name={s.icon} size={20} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fw-session-title">
                  {s.device}
                  {s.current && <span className="fw-session-current">This device</span>}
                </div>
                <div className="fw-session-meta">{s.meta}</div>
              </div>
              {!s.current && (
                <button
                  className="fw-btn ghost sm"
                  onClick={() => dispatch({ type: 'modal', modal: { kind: 'signout-device', device: s.device } })}
                >
                  Sign out
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Connected accounts */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div className="fw-section-title">Connected accounts</div>
        </div>
        <div className="fw-group">
          <div className="fw-session">
            <span className="fw-session-glyph" style={{ background: '#fff', border: '1px solid var(--color-hairline-soft)' }}>
              <svg width="20" height="20" viewBox="0 0 18 18">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.71v2.25h2.9c1.7-1.56 2.69-3.87 2.69-6.6z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.25c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>
                <path fill="#FBBC05" d="M3.95 10.71c-.18-.54-.28-1.12-.28-1.71 0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l2.99-2.33z"/>
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96L3.95 7.29C4.66 5.16 6.65 3.58 9 3.58z"/>
              </svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fw-session-title">Google</div>
              <div className="fw-session-meta">Not linked</div>
            </div>
            <button className="fw-btn outline sm">Connect</button>
          </div>
        </div>
      </div>

      {/* Danger zone */}
      <div className="fw-danger-zone">
        <div className="fw-danger-zone-title">Danger zone</div>
        <div className="fw-danger-card">
          <div className="fw-danger-card-body">
            <div className="fw-danger-card-title">Delete account</div>
            <div className="fw-danger-card-sub">Permanently delete your Fina account, all workspaces you own, and all your transactions. There's no undo.</div>
          </div>
          <button
            className="fw-btn danger"
            onClick={() => dispatch({ type: 'modal', modal: { kind: 'delete-account' } })}
          >
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { PlanPage, AccountPage });
