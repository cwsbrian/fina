// modals.jsx — Confirm modals + Stripe checkout stub.

const ConfirmModal = ({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onClose }) => (
  <div className="fw-modal-scrim" onClick={onClose}>
    <div className="fw-modal" onClick={(e) => e.stopPropagation()}>
      <h3 className="fw-modal-title">{title}</h3>
      <div className="fw-modal-body">{body}</div>
      <div className="fw-modal-actions">
        <button className="fw-btn ghost" onClick={onClose}>{cancelLabel}</button>
        <button className={`fw-btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  </div>
);

const SignOutDeviceModal = ({ device, onConfirm, onClose }) => (
  <ConfirmModal
    title="Sign out this device?"
    body={<>You'll need to sign in again on <strong>{device}</strong>. Other devices stay signed in.</>}
    confirmLabel="Sign out"
    danger
    onConfirm={onConfirm}
    onClose={onClose}
  />
);

const DisconnectBankModal = ({ bankName, onConfirm, onClose }) => (
  <ConfirmModal
    title={`Disconnect ${bankName}?`}
    body={<>Fina will stop receiving new transactions from this institution. Your existing transactions stay — they just won't update.</>}
    confirmLabel="Disconnect"
    danger
    onConfirm={onConfirm}
    onClose={onClose}
  />
);

const RemoveMemberModal = ({ memberName, onConfirm, onClose }) => (
  <ConfirmModal
    title={`Remove ${memberName}?`}
    body={<>They'll lose access to this workspace. Their personal workspace and Fina account are not affected.</>}
    confirmLabel="Remove member"
    danger
    onConfirm={onConfirm}
    onClose={onClose}
  />
);

const RevokeInviteModal = ({ email, onConfirm, onClose }) => (
  <ConfirmModal
    title="Revoke invite?"
    body={<>The invite link sent to <strong>{email}</strong> will stop working immediately.</>}
    confirmLabel="Revoke"
    danger
    onConfirm={onConfirm}
    onClose={onClose}
  />
);

const CancelSubModal = ({ renewalDate, onConfirm, onClose }) => (
  <ConfirmModal
    title="Cancel subscription?"
    body={<>You'll keep Pro access until <strong>{renewalDate}</strong>. After that, you'll move to the Free tier and your bank connections will be removed.</>}
    confirmLabel="Cancel subscription"
    danger
    onConfirm={onConfirm}
    onClose={onClose}
  />
);

const DeleteAccountModal = ({ onConfirm, onClose }) => {
  const [confirm, setConfirm] = React.useState('');
  const valid = confirm.trim().toLowerCase() === 'delete';
  return (
    <div className="fw-modal-scrim" onClick={onClose}>
      <div className="fw-modal wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="fw-modal-title" style={{ color: 'var(--color-down)' }}>Delete account</h3>
        <div className="fw-modal-body">
          <p style={{ margin: '0 0 14px' }}>This permanently deletes your Fina account. The following will be removed:</p>
          <ul style={{ margin: '0 0 18px', paddingLeft: 20, fontSize: 14, color: 'var(--color-body)', lineHeight: 1.7 }}>
            <li>Your transactions and categories</li>
            <li>Workspaces you own (and access for their members)</li>
            <li>Active subscription (Pro trial ends immediately)</li>
            <li>Connected bank tokens</li>
          </ul>
          <p style={{ margin: '0 0 14px', fontSize: 14, color: 'var(--color-body)' }}>
            Type <strong style={{ color: 'var(--color-ink)' }}>delete</strong> to confirm.
          </p>
          <input
            className="fw-input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="delete"
            autoFocus
          />
        </div>
        <div className="fw-modal-actions">
          <button className="fw-btn ghost" onClick={onClose}>Keep my account</button>
          <button className="fw-btn danger" disabled={!valid} onClick={onConfirm}>Delete account</button>
        </div>
      </div>
    </div>
  );
};

// Stripe checkout stub — a styled mock that looks like Stripe Checkout
const StripeCheckout = ({ plan, onSuccess, onClose }) => {
  const [card, setCard] = React.useState('');
  const [exp, setExp] = React.useState('');
  const [cvc, setCvc] = React.useState('');
  const [processing, setProcessing] = React.useState(false);
  const valid = card.replace(/\s/g, '').length >= 12 && exp.length >= 5 && cvc.length >= 3;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!valid) return;
    setProcessing(true);
    setTimeout(() => { onSuccess(); }, 1200);
  };

  const fmtCard = (v) => v.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim().slice(0, 19);
  const fmtExp = (v) => v.replace(/\D/g, '').slice(0, 4).replace(/(\d{2})(\d)/, '$1/$2');

  return (
    <div className="fw-modal-scrim" onClick={onClose}>
      <div className="fw-stripe" onClick={(e) => e.stopPropagation()}>
        <div className="fw-stripe-bar"></div>
        <div className="fw-stripe-head">
          <div className="fw-stripe-merchant">
            <span className="mark" style={{
              width: 36, height: 36, borderRadius: 10, padding: 4,
              background: 'var(--color-canvas)',
              border: '1px solid var(--color-hairline)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <img src="assets/fina-logo-mark.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            </span>
            <div>
              <div className="name">Fina</div>
              <div className="sub">{plan.name} subscription</div>
            </div>
          </div>
          <span className="fw-stripe-stripe-logo">Powered by <span style={{ color: '#635bff', fontWeight: 700 }}>stripe</span></span>
        </div>
        <div className="fw-stripe-body">
          <div className="fw-stripe-amount">${plan.price}.00</div>
          <div className="fw-stripe-amount-meta">CAD · per month, billed monthly</div>

          <form onSubmit={handleSubmit}>
            <div className="fw-field">
              <label className="fw-field-label">Email</label>
              <input className="fw-input" type="email" defaultValue="brian@hwang.dev" readOnly />
            </div>
            <div className="fw-field">
              <label className="fw-field-label">Card information</label>
              <input
                className="fw-input"
                placeholder="1234 1234 1234 1234"
                value={card}
                onChange={(e) => setCard(fmtCard(e.target.value))}
                style={{ marginBottom: 8, fontFamily: 'var(--font-mono)' }}
                autoFocus
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="fw-input"
                  placeholder="MM / YY"
                  value={exp}
                  onChange={(e) => setExp(fmtExp(e.target.value))}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
                <input
                  className="fw-input"
                  placeholder="CVC"
                  value={cvc}
                  onChange={(e) => setCvc(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>
            <div className="fw-field">
              <label className="fw-field-label">Cardholder name</label>
              <input className="fw-input" defaultValue="Brian Hwang" />
            </div>
          </form>
        </div>
        <div className="fw-stripe-foot">
          <button
            className="fw-btn primary block lg"
            onClick={handleSubmit}
            disabled={!valid || processing}
          >
            {processing ? 'Processing…' : `Subscribe — $${plan.price}.00 / mo`}
          </button>
          <div className="fw-stripe-secure">
            <WebIcon name="lock" size={12} strokeWidth={2} />
            Secured by Stripe · 256-bit SSL
          </div>
          <div style={{ textAlign: 'center', marginTop: 6 }}>
            <button className="fw-link muted" style={{ fontSize: 12 }} onClick={onClose}>Cancel and go back</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const SuccessToast = ({ message, onClose }) => {
  React.useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div style={{
      position: 'fixed',
      bottom: 32,
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'var(--color-ink)',
      color: '#fff',
      padding: '14px 22px',
      borderRadius: 999,
      font: 'var(--type-body-sm)',
      fontWeight: 500,
      boxShadow: '0 12px 32px rgba(10,11,13,0.20)',
      zIndex: 100,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      animation: 'fw-fade-in 0.2s',
    }}>
      <WebIcon name="check" size={16} strokeWidth={2.4} color="var(--color-up)" />
      {message}
    </div>
  );
};

Object.assign(window, { ConfirmModal, SignOutDeviceModal, DisconnectBankModal, RemoveMemberModal, RevokeInviteModal, CancelSubModal, DeleteAccountModal, StripeCheckout, SuccessToast });
