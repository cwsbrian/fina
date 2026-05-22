// billing-page.jsx — Standalone Billing page: payment method, invoice history, billing info.

const INVOICES = [
  { id: 'in_2026_05', date: 'May 12, 2026', desc: 'Pro plan',  period: 'May 12 \u2013 Jun 11, 2026', amount: 15.00, status: 'paid',     receipt: 'fina-INV-2026-05.pdf' },
  { id: 'in_2026_04', date: 'Apr 12, 2026', desc: 'Pro plan',  period: 'Apr 12 \u2013 May 11, 2026', amount: 15.00, status: 'paid',     receipt: 'fina-INV-2026-04.pdf' },
  { id: 'in_2026_03', date: 'Mar 12, 2026', desc: 'Pro plan',  period: 'Mar 12 \u2013 Apr 11, 2026', amount: 15.00, status: 'paid',     receipt: 'fina-INV-2026-03.pdf' },
  { id: 'in_2026_02', date: 'Feb 14, 2026', desc: 'Pro plan',  period: 'Feb 12 \u2013 Mar 11, 2026', amount: 15.00, status: 'failed',   receipt: null },
  { id: 'in_2026_02b',date: 'Feb 12, 2026', desc: 'Pro plan',  period: 'Feb 12 \u2013 Mar 11, 2026', amount: 15.00, status: 'paid',     receipt: 'fina-INV-2026-02.pdf' },
  { id: 'in_2026_01', date: 'Jan 12, 2026', desc: 'Pro plan',  period: 'Jan 12 \u2013 Feb 11, 2026', amount: 15.00, status: 'paid',     receipt: 'fina-INV-2026-01.pdf' },
  { id: 'in_2025_12', date: 'Dec 12, 2025', desc: 'Lite plan', period: 'Dec 12 \u2013 Jan 11, 2026', amount: 7.00,  status: 'paid',     receipt: 'fina-INV-2025-12.pdf' },
  { id: 'in_2025_11', date: 'Nov 28, 2025', desc: 'Refund \u2014 Lite plan',  period: 'Original: Nov 12 \u2013 Dec 11', amount: -7.00, status: 'refunded', receipt: 'fina-INV-2025-11R.pdf' },
  { id: 'in_2025_11b',date: 'Nov 12, 2025', desc: 'Lite plan', period: 'Nov 12 \u2013 Dec 11, 2025', amount: 7.00,  status: 'paid',     receipt: 'fina-INV-2025-11.pdf' },
  { id: 'in_2025_10', date: 'Oct 12, 2025', desc: 'Lite plan', period: 'Oct 12 \u2013 Nov 11, 2025', amount: 7.00,  status: 'paid',     receipt: 'fina-INV-2025-10.pdf' },
];

const STATUS_META = {
  paid:     { label: 'Paid',     cls: 'status-active' },
  failed:   { label: 'Failed',   cls: 'status-error' },
  refunded: { label: 'Refunded', cls: 'status-neutral' },
  pending:  { label: 'Pending',  cls: 'status-warn' },
};

const fmtAmt = (n) => {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
};

const BillingPage = ({ state, dispatch }) => {
  const { tier, renewalDate, user } = state;
  const isFree = tier === 'free';
  const isTrial = tier === 'trial';
  const onPaid = tier === 'pro' || tier === 'lite';

  const [filter, setFilter] = React.useState('all'); // all | paid | failed | refunded
  const filtered = filter === 'all' ? INVOICES : INVOICES.filter(i => i.status === filter);
  const totalPaid = INVOICES.filter(i => i.status === 'paid').reduce((s, i) => s + i.amount, 0)
                  + INVOICES.filter(i => i.status === 'refunded').reduce((s, i) => s + i.amount, 0);

  return (
    <div className="fw-container">
      <div className="fw-page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 className="fw-page-title">Billing</h1>
          <p className="fw-page-sub" style={{ marginTop: 8 }}>
            Invoices, payment method, and billing details for your Fina subscription.
          </p>
        </div>
        <button
          className="fw-link"
          onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <WebIcon name="arrowLeft" size={14} strokeWidth={2} />
          Back to Plan
        </button>
      </div>

      {(isTrial || isFree) && (
        <div className={`fw-banner ${isTrial ? 'trial' : 'expired'}`} style={{ marginBottom: 32 }}>
          <span className="fw-banner-icon">
            <WebIcon name={isTrial ? 'sparkle' : 'alert'} size={20} strokeWidth={1.8} />
          </span>
          <div className="fw-banner-body">
            <div className="fw-banner-title">
              {isTrial ? "You haven't been charged yet" : 'No active subscription'}
            </div>
            <div className="fw-banner-sub">
              {isTrial
                ? `Trial ends ${state.trialEndsAt}. Add a card to keep Pro after.`
                : 'Start a plan to get billing receipts.'}
            </div>
          </div>
          <button
            className="fw-btn primary"
            onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
          >
            {isTrial ? 'Add payment method' : 'Choose a plan'}
          </button>
        </div>
      )}

      {/* Summary row — payment method · next charge · lifetime */}
      <div className="fw-bill-summary">
        {/* Payment method */}
        <div className="fw-bill-card">
          <div className="fw-bill-card-label">Payment method</div>
          {onPaid ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                <span className="fw-card-brand visa">VISA</span>
                <div>
                  <div style={{ font: 'var(--type-body-md)', fontWeight: 600, color: 'var(--color-ink)', fontFamily: 'var(--font-mono)' }}>
                    \u2022\u2022\u2022\u2022 \u00b7 4242
                  </div>
                  <div className="fw-bill-card-meta mono" style={{ marginTop: 1 }}>Expires 08 / 28</div>
                </div>
              </div>
              <div className="fw-bill-card-foot">
                <span>Billed to {user.email}</span>
                <button
                  className="fw-link"
                  onClick={() => dispatch({ type: 'toast', message: 'Opening Stripe customer portal\u2026' })}
                >
                  Update
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="fw-bill-card-value" style={{ color: 'var(--color-muted)' }}>None on file</div>
              <div className="fw-bill-card-meta">
                {isTrial ? 'Add one before your trial ends.' : 'Subscribe to add a payment method.'}
              </div>
              <div className="fw-bill-card-foot">
                <button
                  className="fw-link"
                  onClick={() => dispatch({ type: 'navigate', path: '/settings/plan' })}
                >
                  Add card
                </button>
              </div>
            </>
          )}
        </div>

        {/* Next charge */}
        <div className="fw-bill-card">
          <div className="fw-bill-card-label">Next charge</div>
          {onPaid ? (
            <>
              <div className="fw-bill-card-value">$15.00</div>
              <div className="fw-bill-card-meta mono">{renewalDate} \u00b7 CAD</div>
              <div className="fw-bill-card-foot">
                <span>Pro plan \u00b7 monthly</span>
              </div>
            </>
          ) : (
            <>
              <div className="fw-bill-card-value" style={{ color: 'var(--color-muted)' }}>\u2014</div>
              <div className="fw-bill-card-meta">{isTrial ? `Trial ends ${state.trialEndsAt}` : 'No upcoming charges.'}</div>
              <div className="fw-bill-card-foot">&nbsp;</div>
            </>
          )}
        </div>

        {/* Lifetime */}
        <div className="fw-bill-card">
          <div className="fw-bill-card-label">Lifetime paid</div>
          <div className="fw-bill-card-value">{fmtAmt(totalPaid)}</div>
          <div className="fw-bill-card-meta mono">CAD \u00b7 since Oct 2025</div>
          <div className="fw-bill-card-foot">
            <span>{INVOICES.filter(i => i.status === 'paid').length} invoices</span>
            <button className="fw-link muted">Export all</button>
          </div>
        </div>
      </div>

      {/* Invoices */}
      <div className="fw-section">
        <div className="fw-section-head" style={{ alignItems: 'center' }}>
          <div>
            <div className="fw-section-title">Invoice history</div>
            <div className="fw-section-sub">Receipts for every charge on this account.</div>
          </div>
          <div style={{ display: 'flex', gap: 4, background: 'var(--color-surface-soft)', padding: 4, borderRadius: 999 }}>
            {['all', 'paid', 'failed', 'refunded'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="fw-nav-link"
                style={{
                  background: filter === f ? 'var(--color-canvas)' : 'transparent',
                  color: filter === f ? 'var(--color-ink)' : 'var(--color-muted)',
                  fontWeight: filter === f ? 600 : 500,
                  boxShadow: filter === f ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                  textTransform: 'capitalize',
                  fontSize: 13,
                  padding: '6px 14px',
                }}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="fw-empty">
            <div className="fw-empty-glyph">
              <WebIcon name="receipt" size={28} strokeWidth={1.5} />
            </div>
            <h3 className="fw-empty-title">No invoices yet</h3>
            <p className="fw-empty-sub">
              {isFree ? 'Start a paid plan to start receiving invoices.' : "Your first invoice will appear here once you're billed."}
            </p>
          </div>
        ) : (
          <div className="fw-invoice-table">
            <div className="fw-invoice-head">
              <div>Date</div>
              <div>Description</div>
              <div>Amount</div>
              <div>Method</div>
              <div>Status</div>
              <div style={{ textAlign: 'right' }}>Receipt</div>
            </div>
            {filtered.map(inv => {
              const status = STATUS_META[inv.status];
              return (
                <div className="fw-invoice-row" key={inv.id}>
                  <div className="date">{inv.date}</div>
                  <div className="desc">
                    {inv.desc}
                    <span className="sub">{inv.period}</span>
                  </div>
                  <div className={`amt ${inv.amount < 0 ? 'refund' : ''}`}>
                    {fmtAmt(inv.amount)} <span style={{ color: 'var(--color-muted)', fontSize: 11, marginLeft: 2 }}>CAD</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="fw-card-brand visa" style={{ width: 32, height: 22, fontSize: 8 }}>VISA</span>
                    <span className="mono" style={{ color: 'var(--color-muted)', fontSize: 12 }}>\u2022\u20224242</span>
                  </div>
                  <div>
                    <span className={`fw-pill ${status.cls}`}>
                      <span className="dot"></span>
                      {status.label}
                    </span>
                  </div>
                  <div className="fw-invoice-actions">
                    {inv.receipt ? (
                      <button
                        title={`Download ${inv.receipt}`}
                        onClick={() => dispatch({ type: 'toast', message: `Downloading ${inv.receipt}` })}
                      >
                        <WebIcon name="download" size={16} strokeWidth={1.8} />
                      </button>
                    ) : (
                      <button
                        title="Retry payment"
                        onClick={() => dispatch({ type: 'toast', message: 'Retrying payment\u2026' })}
                        style={{ color: 'var(--color-down)' }}
                      >
                        <WebIcon name="refresh" size={16} strokeWidth={1.8} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Billing info */}
      <div className="fw-section">
        <div className="fw-section-head">
          <div>
            <div className="fw-section-title">Billing details</div>
            <div className="fw-section-sub">Appears on every invoice. Update for tax / company billing.</div>
          </div>
          <button
            className="fw-btn outline sm"
            onClick={() => dispatch({ type: 'toast', message: 'Opening Stripe portal to edit billing details\u2026' })}
          >
            <WebIcon name="edit" size={14} />
            Edit
          </button>
        </div>
        <div className="fw-card">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
            <div>
              <div className="fw-eyebrow" style={{ marginBottom: 6 }}>Billed to</div>
              <div style={{ font: 'var(--type-body-md)', fontWeight: 600, color: 'var(--color-ink)' }}>{user.name}</div>
              <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-body)', marginTop: 2 }}>{user.email}</div>
            </div>
            <div>
              <div className="fw-eyebrow" style={{ marginBottom: 6 }}>Billing address</div>
              <div style={{ font: 'var(--type-body-md)', color: 'var(--color-ink)', lineHeight: 1.5 }}>
                42 Spadina Ave, Unit 1804<br/>
                Toronto, ON M5V 2H8<br/>
                Canada
              </div>
            </div>
            <div>
              <div className="fw-eyebrow" style={{ marginBottom: 6 }}>Tax ID</div>
              <div style={{ font: 'var(--type-body-md)', color: 'var(--color-muted)', fontFamily: 'var(--font-mono)' }}>None on file</div>
            </div>
            <div>
              <div className="fw-eyebrow" style={{ marginBottom: 6 }}>Currency</div>
              <div style={{ font: 'var(--type-body-md)', color: 'var(--color-ink)', fontFamily: 'var(--font-mono)' }}>
                CAD <span style={{ fontFamily: 'var(--font-sans)', color: 'var(--color-muted)', fontWeight: 400, marginLeft: 6 }}>\u00b7 Canadian dollar</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="fw-billing-footnote">
        <strong style={{ color: 'var(--color-ink)' }}>Subscribed via mobile?</strong> Subscriptions purchased through the iOS or Android app are billed by Apple or Google. Find those invoices in the App Store or Google Play \u2014 they don't appear here.
      </div>
    </div>
  );
};

window.BillingPage = BillingPage;
