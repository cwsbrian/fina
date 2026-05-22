// auth-pages.jsx — Sign in / Sign up, Forgot password, Reset password, Invite accept.

// Shared minimal top bar for public pages (logo only, no nav).
const AuthTopBar = ({ onHome }) => (
  <div className="fw-auth-top">
    <img
      className="fw-brand-full"
      src="assets/fina-logo-full.png"
      alt="Fina"
      onClick={onHome}
      style={{ cursor: 'pointer' }}
    />
    <div style={{ font: '12px var(--font-sans)', color: 'var(--color-muted)', letterSpacing: '0.4px' }}>
      Made in Canada · CAD
    </div>
  </div>
);

// ───────────────────────────────────────────
// SIGN IN / SIGN UP — combined page
// ───────────────────────────────────────────
const SignInPage = ({ state, dispatch }) => {
  const inviteContext = state.inviteContext;
  const [mode, setMode] = React.useState(inviteContext ? 'signUp' : 'signUp');
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState(inviteContext ? inviteContext.email : '');
  const [password, setPassword] = React.useState('');
  const [showPw, setShowPw] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  const submit = (e) => {
    e.preventDefault();
    if (!email.includes('@')) { setErr('Please enter a valid email address.'); return; }
    if (password.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    setErr('');
    setBusy(true);
    setTimeout(() => {
      if (mode === 'signUp') {
        // Sign-up requires email verification first.
        dispatch({ type: 'setPendingUser', user: { name: name || email.split('@')[0], email, inviteContext } });
        dispatch({ type: 'navigate', path: '/verify-email' });
      } else {
        dispatch({ type: 'signIn', user: { name: name || email.split('@')[0], email } });
        if (inviteContext) {
          dispatch({ type: 'navigate', path: inviteContext.from || '/home' });
        }
      }
    }, 700);
  };

  return (
    <div className="fw-auth">
      <AuthTopBar onHome={() => dispatch({ type: 'navigate', path: '/home' })} />
      <div className="fw-auth-body">
        <div className="fw-auth-card">
          <h1 className="fw-auth-title">
            {mode === 'signUp' ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="fw-auth-sub">
            {mode === 'signUp'
              ? 'Sign up and start your 30-day Pro trial. No card required.'
              : 'Sign in to manage your workspace, banks, and plan.'}
          </p>

          {inviteContext && (
            <div className="fw-banner" style={{ marginBottom: 22 }}>
              <span className="fw-banner-icon" style={{ background: 'rgba(125, 216, 184,0.10)', color: 'var(--color-primary)' }}>
                <WebIcon name="users" size={18} />
              </span>
              <div className="fw-banner-body">
                <div className="fw-banner-title">Joining {inviteContext.workspace}</div>
                <div className="fw-banner-sub">Invited as {inviteContext.role} · sign up with {inviteContext.email}</div>
              </div>
            </div>
          )}

          <form onSubmit={submit}>
            {mode === 'signUp' && (
              <div className="fw-field">
                <label className="fw-field-label">Name (optional)</label>
                <input
                  className="fw-input"
                  placeholder="Brian Hwang"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            <div className="fw-field">
              <label className="fw-field-label">Email</label>
              <div className="fw-field-trail">
                <input
                  className={`fw-input ${inviteContext ? 'locked' : ''}`}
                  type="email"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly={!!inviteContext}
                  autoFocus={mode === 'signIn' && !inviteContext}
                />
                {inviteContext && (
                  <span className="fw-field-trail-icon" style={{ pointerEvents: 'none' }}>
                    <WebIcon name="lock" size={16} color="var(--color-muted-soft)" />
                  </span>
                )}
              </div>
              {inviteContext && (
                <div className="fw-field-helper">Email locked to the invited address. Use a different email by opening /sign-in directly.</div>
              )}
            </div>
            <div className="fw-field">
              <label className="fw-field-label">Password</label>
              <div className="fw-field-trail">
                <input
                  className="fw-input"
                  type={showPw ? 'text' : 'password'}
                  placeholder={mode === 'signUp' ? 'At least 8 characters' : 'Your password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="fw-field-trail-icon"
                  onClick={() => setShowPw(s => !s)}
                  aria-label={showPw ? 'Hide password' : 'Show password'}
                >
                  <WebIcon name={showPw ? 'eyeOff' : 'eye'} size={16} />
                </button>
              </div>
              {mode === 'signIn' && (
                <div style={{ textAlign: 'right', marginTop: 8 }}>
                  <button
                    type="button"
                    className="fw-link muted"
                    style={{ font: 'var(--type-body-sm)' }}
                    onClick={() => dispatch({ type: 'navigate', path: '/forgot-password' })}
                  >
                    Forgot password?
                  </button>
                </div>
              )}
            </div>

            {err && (
              <div className="fw-field-helper error" style={{ marginBottom: 14 }}>{err}</div>
            )}

            <button
              type="submit"
              className="fw-btn primary block lg"
              disabled={busy || !email || !password}
            >
              {busy ? '…' : (mode === 'signUp' ? 'Create account' : 'Sign in')}
            </button>
          </form>

          <div className="fw-auth-divider">or</div>

          <button
            className="fw-auth-social"
            onClick={() => { setBusy(true); setTimeout(() => dispatch({ type: 'signIn', user: { name: 'Brian Hwang', email: 'brian@hwang.dev' } }), 600); }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18">
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.71v2.25h2.9c1.7-1.56 2.69-3.87 2.69-6.6z"/>
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.25c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"/>
              <path fill="#FBBC05" d="M3.95 10.71c-.18-.54-.28-1.12-.28-1.71 0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l2.99-2.33z"/>
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96L3.95 7.29C4.66 5.16 6.65 3.58 9 3.58z"/>
            </svg>
            Continue with Google
          </button>

          {mode === 'signUp' && (
            <p className="fw-auth-legal">
              By creating an account, you agree to our <a href="#">Terms</a> and <a href="#">Privacy policy</a>.
            </p>
          )}

          <div className="fw-auth-foot">
            {mode === 'signUp' ? (
              <>Already have an account? <button className="fw-link" onClick={() => { setMode('signIn'); setErr(''); }}>Sign in</button></>
            ) : (
              <>New to Fina? <button className="fw-link" onClick={() => { setMode('signUp'); setErr(''); }}>Create an account</button></>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────
// FORGOT PASSWORD
// ───────────────────────────────────────────
const ForgotPasswordPage = ({ state, dispatch }) => {
  const [email, setEmail] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = (e) => {
    e.preventDefault();
    if (!email.includes('@')) return;
    setBusy(true);
    setTimeout(() => {
      dispatch({ type: 'setResetEmail', email });
      dispatch({ type: 'navigate', path: '/forgot-password/sent' });
    }, 600);
  };

  return (
    <div className="fw-auth">
      <AuthTopBar onHome={() => dispatch({ type: 'navigate', path: '/sign-in' })} />
      <div className="fw-auth-body">
        <div className="fw-auth-card">
          <h1 className="fw-auth-title">Reset your password</h1>
          <p className="fw-auth-sub">Enter the email you signed up with and we'll send a link to reset it.</p>
          <form onSubmit={submit}>
            <div className="fw-field">
              <label className="fw-field-label">Email</label>
              <input
                className="fw-input"
                type="email"
                placeholder="you@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            </div>
            <button type="submit" className="fw-btn primary block lg" disabled={busy || !email.includes('@')}>
              {busy ? '…' : 'Send reset link'}
            </button>
          </form>
          <div className="fw-auth-foot">
            <button className="fw-link" onClick={() => dispatch({ type: 'navigate', path: '/sign-in' })}>
              Back to sign in
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────
// EMAIL SENT (reset password link)
// ───────────────────────────────────────────
const CheckEmailPage = ({ state, dispatch }) => {
  const email = state.resetEmail || 'you@email.com';
  const [cooldown, setCooldown] = React.useState(45);
  const [resent, setResent] = React.useState(false);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const resend = () => {
    setCooldown(45);
    setResent(true);
    dispatch({ type: 'toast', message: `Reset link re-sent to ${email}` });
  };

  return (
    <div className="fw-auth">
      <AuthTopBar onHome={() => dispatch({ type: 'navigate', path: '/sign-in' })} />
      <div className="fw-auth-body">
        <div className="fw-auth-card wide" style={{ maxWidth: 460 }}>
          {/* Stylised "letter" visual — quiet but distinctive */}
          <div style={{
            position: 'relative',
            margin: '0 auto 28px',
            width: 140,
            height: 96,
          }}>
            <div style={{
              position: 'absolute', inset: 0,
              borderRadius: 14,
              background: 'var(--color-surface-soft)',
              border: '1px solid var(--color-hairline)',
              transform: 'rotate(-4deg)',
            }}/>
            <div style={{
              position: 'absolute', inset: 0,
              borderRadius: 14,
              background: 'var(--color-canvas)',
              border: '1px solid var(--color-hairline)',
              boxShadow: '0 8px 20px rgba(10,11,13,0.04)',
              padding: 18,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}>
              <div style={{
                height: 5, width: '40%', borderRadius: 999,
                background: 'var(--color-surface-strong)',
              }}/>
              <div style={{
                height: 5, width: '70%', borderRadius: 999,
                background: 'var(--color-surface-strong)',
              }}/>
              <div style={{
                height: 5, width: '55%', borderRadius: 999,
                background: 'var(--color-surface-strong)',
              }}/>
              <div style={{
                marginTop: 'auto',
                display: 'inline-block',
                font: '10px var(--font-sans)',
                fontWeight: 700,
                letterSpacing: '0.5px',
                textTransform: 'uppercase',
                color: 'var(--color-primary)',
                padding: '4px 8px',
                borderRadius: 999,
                background: 'rgba(125, 216, 184,0.10)',
                alignSelf: 'flex-start',
              }}>
                Reset password →
              </div>
            </div>
            {/* small Fina mark on letter */}
            <div style={{
              position: 'absolute',
              top: -8, right: -8,
              width: 32, height: 32,
              borderRadius: 10,
              background: 'var(--color-primary)',
              color: '#fff',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              font: '15px var(--font-sans)', fontWeight: 600, letterSpacing: '-0.4px',
              boxShadow: '0 4px 12px rgba(125, 216, 184,0.3)',
              border: '2px solid var(--color-canvas)',
            }}>F</div>
          </div>

          <h1 className="fw-auth-title" style={{ textAlign: 'center' }}>Check your email</h1>
          <p className="fw-auth-sub" style={{ textAlign: 'center' }}>
            We sent a password reset link to<br/>
            <strong style={{ color: 'var(--color-ink)', fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 15 }}>{email}</strong>
          </p>

          <div style={{
            padding: '14px 18px',
            background: 'var(--color-surface-soft)',
            borderRadius: 14,
            font: 'var(--type-body-sm)',
            color: 'var(--color-body)',
            lineHeight: 1.6,
            marginBottom: 24,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, color: 'var(--color-ink)', fontWeight: 600 }}>
              <WebIcon name="clock" size={14} strokeWidth={2} color="var(--color-muted)" />
              Link expires in 30 minutes
            </div>
            Click the link in the email to set a new password. If you don't see it, check your spam folder.
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              className="fw-btn outline"
              style={{ flex: 1 }}
              onClick={() => dispatch({ type: 'navigate', path: '/forgot-password' })}
            >
              Wrong email?
            </button>
            <button
              className="fw-btn primary"
              style={{ flex: 1 }}
              disabled={cooldown > 0}
              onClick={resend}
            >
              {cooldown > 0
                ? `Resend in ${cooldown}s`
                : (resent ? 'Resend link' : 'Resend link')}
            </button>
          </div>

          <div className="fw-auth-foot">
            <button className="fw-link" onClick={() => dispatch({ type: 'navigate', path: '/sign-in' })}>
              Back to sign in
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────
// RESET PASSWORD
// ───────────────────────────────────────────
const ResetPasswordPage = ({ state, dispatch }) => {
  const [pw, setPw] = React.useState('');
  const [pw2, setPw2] = React.useState('');
  const [show, setShow] = React.useState(false);
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');

  const strength = pwStrength(pw);

  const submit = (e) => {
    e.preventDefault();
    if (pw.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (pw !== pw2) { setErr("Passwords don't match."); return; }
    setErr('');
    setBusy(true);
    setTimeout(() => { setDone(true); setBusy(false); }, 600);
  };

  return (
    <div className="fw-auth">
      <AuthTopBar onHome={() => dispatch({ type: 'navigate', path: '/sign-in' })} />
      <div className="fw-auth-body">
        <div className="fw-auth-card">
          {!done ? (
            <>
              <h1 className="fw-auth-title">Set a new password</h1>
              <p className="fw-auth-sub">Choose something at least 8 characters long. You'll stay signed in on this device.</p>
              <form onSubmit={submit}>
                <div className="fw-field">
                  <label className="fw-field-label">New password</label>
                  <div className="fw-field-trail">
                    <input
                      className="fw-input"
                      type={show ? 'text' : 'password'}
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder="At least 8 characters"
                      autoFocus
                    />
                    <button type="button" className="fw-field-trail-icon" onClick={() => setShow(s => !s)}>
                      <WebIcon name={show ? 'eyeOff' : 'eye'} size={16} />
                    </button>
                  </div>
                  {pw && (
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        flex: 1, height: 4, borderRadius: 999, background: 'var(--color-surface-strong)', overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${strength.pct}%`, height: '100%', background: strength.color,
                          borderRadius: 'inherit', transition: 'width 0.15s, background 0.15s',
                        }} />
                      </div>
                      <span style={{ font: '11px var(--font-sans)', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase', color: strength.color }}>
                        {strength.label}
                      </span>
                    </div>
                  )}
                </div>
                <div className="fw-field">
                  <label className="fw-field-label">Confirm new password</label>
                  <input
                    className="fw-input"
                    type={show ? 'text' : 'password'}
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    placeholder="Type it again"
                  />
                </div>
                {err && <div className="fw-field-helper error" style={{ marginBottom: 14 }}>{err}</div>}
                <button type="submit" className="fw-btn primary block lg" disabled={busy || !pw || !pw2}>
                  {busy ? '…' : 'Update password'}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="fw-auth-success-glyph">
                <WebIcon name="check" size={28} strokeWidth={2.2} />
              </div>
              <h1 className="fw-auth-title">Password updated</h1>
              <p className="fw-auth-sub">Sign in with your new password to get back to Fina.</p>
              <button
                className="fw-btn primary block lg"
                onClick={() => dispatch({ type: 'navigate', path: '/sign-in' })}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const pwStrength = (pw) => {
  if (!pw) return { pct: 0, label: '', color: 'var(--color-muted)' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const buckets = [
    { pct: 20, label: 'Weak', color: 'var(--color-down)' },
    { pct: 40, label: 'Weak', color: 'var(--color-down)' },
    { pct: 60, label: 'Fair', color: '#e6b85c' },
    { pct: 80, label: 'Good', color: 'var(--color-primary)' },
    { pct: 100, label: 'Strong', color: 'var(--color-up)' },
  ];
  return buckets[Math.min(score, 4)];
};

// ───────────────────────────────────────────
// EMAIL VERIFY (OTP — 6 digits)
// ───────────────────────────────────────────
const EmailVerifyPage = ({ state, dispatch }) => {
  const pending = state.pendingUser || { email: 'you@email.com', name: 'You' };
  const [digits, setDigits] = React.useState(['', '', '', '', '', '']);
  const [active, setActive] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(24);
  const inputs = React.useRef([]);

  // Resend countdown
  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // Focus the active input
  React.useEffect(() => {
    inputs.current[active]?.focus();
  }, [active]);

  // Auto-verify when all 6 are filled
  React.useEffect(() => {
    if (digits.every(d => d !== '') && !busy) {
      verify(digits.join(''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  const setDigit = (i, val) => {
    setErr(false);
    const next = [...digits];
    next[i] = val.slice(-1).replace(/\D/, ''); // single digit only
    setDigits(next);
    if (next[i] && i < 5) setActive(i + 1);
  };

  const onKey = (i, e) => {
    if (e.key === 'Backspace') {
      if (digits[i]) {
        setDigit(i, '');
      } else if (i > 0) {
        setActive(i - 1);
        const next = [...digits];
        next[i - 1] = '';
        setDigits(next);
      }
    } else if (e.key === 'ArrowLeft' && i > 0) {
      setActive(i - 1);
    } else if (e.key === 'ArrowRight' && i < 5) {
      setActive(i + 1);
    }
  };

  const onPaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
    if (!text) return;
    const next = ['', '', '', '', '', ''];
    for (let i = 0; i < text.length; i++) next[i] = text[i];
    setDigits(next);
    setActive(Math.min(text.length, 5));
  };

  const verify = (code) => {
    setBusy(true);
    setTimeout(() => {
      // Demo: "111111" fails, anything else succeeds
      if (code === '111111') {
        setErr(true);
        setBusy(false);
        setDigits(['', '', '', '', '', '']);
        setActive(0);
        setTimeout(() => setErr(false), 600);
      } else {
        dispatch({ type: 'signIn', user: { name: pending.name, email: pending.email } });
        dispatch({ type: 'clearPendingUser' });
        if (pending.inviteContext) {
          dispatch({ type: 'navigate', path: pending.inviteContext.from || '/home' });
        }
        dispatch({ type: 'toast', message: `Welcome to Fina, ${pending.name.split(' ')[0]}!` });
      }
    }, 700);
  };

  const resend = () => {
    setCooldown(24);
    setDigits(['', '', '', '', '', '']);
    setActive(0);
    dispatch({ type: 'toast', message: `New code sent to ${pending.email}` });
  };

  const changeEmail = () => {
    dispatch({ type: 'clearPendingUser' });
    dispatch({ type: 'navigate', path: '/sign-in' });
  };

  return (
    <div className="fw-auth">
      <AuthTopBar onHome={() => dispatch({ type: 'navigate', path: '/sign-in' })} />
      <div className="fw-auth-body">
        <div className="fw-auth-card">
          <div className="fw-otp-illo">
            <WebIcon name="mail" size={28} strokeWidth={1.6} />
          </div>
          <h1 className="fw-auth-title">Check your email</h1>
          <p className="fw-auth-sub">
            We sent a 6-digit code to{' '}
            <strong style={{ color: 'var(--color-ink)', fontWeight: 600, fontFamily: 'var(--font-mono)', fontSize: 15 }}>
              {pending.email}
            </strong>. It expires in 10 minutes.
          </p>

          <div className={`fw-otp-row ${err ? 'shake' : ''}`} onPaste={onPaste}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={el => (inputs.current[i] = el)}
                className={`fw-otp-box ${d ? 'filled' : ''} ${err ? 'error' : ''}`}
                value={d}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => onKey(i, e)}
                onFocus={() => setActive(i)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={1}
                aria-label={`Digit ${i + 1}`}
                disabled={busy}
              />
            ))}
          </div>

          {err && (
            <div className="fw-field-helper error" style={{ textAlign: 'center', marginTop: 12 }}>
              That code didn't work. Try again or resend.
            </div>
          )}
          {busy && !err && (
            <div className="fw-field-helper" style={{ textAlign: 'center', marginTop: 12, color: 'var(--color-primary)', fontWeight: 600 }}>
              Verifying…
            </div>
          )}

          <div className="fw-auth-resend">
            {cooldown > 0 ? (
              <>Resend code in <strong>0:{String(cooldown).padStart(2, '0')}</strong></>
            ) : (
              <>Didn't get it? <button className="resend-link" onClick={resend}>Resend code</button></>
            )}
          </div>

          <div style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid var(--color-hairline-soft)', textAlign: 'center' }}>
            <button className="fw-link muted" onClick={changeEmail}>
              Wrong address? <span style={{ color: 'var(--color-primary)', fontWeight: 600, marginLeft: 4 }}>Change email</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────
// INVITE ACCEPT
// ───────────────────────────────────────────
const INVITE_DEMO = {
  workspace: 'The Hwang household',
  email: 'jenna@hwang.dev',
  role: 'editor',
  from: 'brian@hwang.dev',
};

const InviteAcceptPage = ({ state, dispatch }) => {
  // Variants user can preview from menu: pending-signed-out, pending-signed-in, expired, wrong-email
  const [variant, setVariant] = React.useState('pending-signed-out');
  const inv = INVITE_DEMO;

  const goSignUp = () => {
    dispatch({ type: 'setInviteContext', context: { workspace: inv.workspace, role: inv.role, email: inv.email, from: '/invites/abc123' } });
    dispatch({ type: 'navigate', path: '/sign-in' });
  };
  const accept = () => {
    dispatch({ type: 'addWorkspace', ws: { id: 'inv-' + Date.now(), name: inv.workspace, role: inv.role, color: '#2e6b5b' } });
    dispatch({ type: 'navigate', path: '/home' });
    dispatch({ type: 'toast', message: `You joined ${inv.workspace}` });
  };

  return (
    <div className="fw-auth">
      <AuthTopBar onHome={() => dispatch({ type: 'navigate', path: '/home' })} />

      {/* State previewer (dev affordance) */}
      <div style={{ position: 'absolute', top: 22, right: 32, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ font: '11px var(--font-sans)', fontWeight: 600, letterSpacing: '0.4px', textTransform: 'uppercase', color: 'var(--color-muted)' }}>
          Preview state
        </span>
        <select
          className="fw-select"
          value={variant}
          onChange={(e) => setVariant(e.target.value)}
          style={{ height: 32, fontSize: 13, padding: '0 12px', width: 'auto' }}
        >
          <option value="pending-signed-out">Pending · signed out</option>
          <option value="pending-signed-in">Pending · signed in</option>
          <option value="wrong-email">Pending · wrong email</option>
          <option value="expired">Expired</option>
          <option value="invalid">Invalid token</option>
        </select>
      </div>

      <div className="fw-auth-body">
        <div className="fw-auth-card wide">
          {variant === 'invalid' ? (
            <div className="fw-invite-card">
              <div className="fw-invite-icon" style={{ background: 'rgba(207,32,47,0.10)', color: 'var(--color-down)' }}>
                <WebIcon name="alert" size={28} />
              </div>
              <h1 className="fw-auth-title" style={{ marginBottom: 10 }}>Invite not found</h1>
              <p className="fw-auth-sub" style={{ marginBottom: 0 }}>This invite link is invalid or has been deleted. Ask whoever invited you to send a new one.</p>
            </div>
          ) : variant === 'expired' ? (
            <div className="fw-invite-card">
              <div className="fw-invite-icon" style={{ background: 'rgba(230, 184, 92,0.14)', color: '#7a5500' }}>
                <WebIcon name="clock" size={28} />
              </div>
              <h1 className="fw-auth-title" style={{ marginBottom: 10 }}>This invite has expired</h1>
              <p className="fw-auth-sub" style={{ marginBottom: 0 }}>
                Invites are valid for 7 days. Ask <strong style={{ color: 'var(--color-ink)' }}>{inv.from}</strong> to send a fresh one.
              </p>
            </div>
          ) : (
            <div className="fw-invite-card">
              <div className="fw-invite-icon">
                <WebIcon name="users" size={28} />
              </div>
              <div className="fw-invite-from">
                Invite from <strong>{inv.from}</strong>
              </div>
              <h2 className="fw-invite-ws-name">{inv.workspace}</h2>
              <div className="fw-invite-role">
                You'd join as
                <span className={`fw-pill role-${inv.role}`}>
                  <span className="dot"></span>
                  {inv.role}
                </span>
              </div>

              {variant === 'pending-signed-out' && (
                <button className="fw-btn primary lg" onClick={goSignUp}>
                  Sign in to accept · {inv.email}
                  <WebIcon name="arrowRight" size={16} strokeWidth={2} />
                </button>
              )}
              {variant === 'pending-signed-in' && (
                <button className="fw-btn primary lg" onClick={accept}>
                  Accept invite
                  <WebIcon name="check" size={16} strokeWidth={2.2} />
                </button>
              )}
              {variant === 'wrong-email' && (
                <>
                  <div className="fw-banner expired" style={{ marginBottom: 18, textAlign: 'left' }}>
                    <span className="fw-banner-icon">
                      <WebIcon name="alert" size={18} />
                    </span>
                    <div className="fw-banner-body">
                      <div className="fw-banner-title">Email mismatch</div>
                      <div className="fw-banner-sub">This invite is for <strong>{inv.email}</strong>. You're signed in as <strong>{state.user.email}</strong>.</div>
                    </div>
                  </div>
                  <button className="fw-btn outline lg" onClick={() => dispatch({ type: 'signOut' })}>
                    Sign out and try again
                  </button>
                </>
              )}

              <div className="fw-invite-foot">
                By accepting, you'll get {inv.role} access to {inv.workspace}'s transactions, categories, and budgets.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

Object.assign(window, { SignInPage, EmailVerifyPage, ForgotPasswordPage, CheckEmailPage, ResetPasswordPage, InviteAcceptPage });
