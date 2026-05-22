// chat-blocks.jsx — Chat message bubbles + categorize_card / confirm_card / quick_replies

const Bubble = ({ role = 'ai', children, variant = 'default', showAvatar = false, tag }) => {
  const ai = role === 'ai';
  const aiTag = ai && tag !== false ? (tag || 'Fina') : null;
  return (
    <>
      {aiTag && <div className="fm-msg-tag">{aiTag}</div>}
      <div className={`fm-msg ${role}`}>
        {ai && showAvatar && (
          <div className="fm-avatar"><FinaMark size={28} radius={8} /></div>
        )}
        <div className={`fm-bubble${variant !== 'default' ? ` fm-bubble-${variant}` : ''}`}>
          {children}
        </div>
      </div>
    </>
  );
};

// ──────────────────────────────────────────────
// CategorizeCard — three layouts via `layout` prop
//   'default' : vertical, top row, suggestion chip, two buttons
//   'compact' : single row, inline suggestion
//   'split'   : top merchant + bottom big suggestion w/ confirm
// ──────────────────────────────────────────────
const CategorizeCard = ({
  merchant, amount, when, glyph = 'cart',
  suggestion = 'Groceries',
  layout = 'default',
  confirmed = false,
  category = null, // when confirmed
  dark = false,
}) => {
  if (confirmed) {
    return (
      <div className="fm-block confirmed">
        <div className="fm-block-top">
          <div className="fm-cat-glyph" style={{ background: 'rgba(31, 138, 91,0.12)', color: 'var(--color-up)' }}>
            <Icon name="check" size={20} strokeWidth={2} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fm-merchant" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {merchant}
              <span style={{ color: 'var(--color-up)', fontWeight: 500, fontSize: 14 }}>· {category || suggestion}</span>
            </div>
            <div className="fm-merchant-sub">{amount} · {when}</div>
          </div>
        </div>
      </div>
    );
  }

  if (layout === 'compact') {
    return (
      <div className="fm-block">
        <div className="fm-block-top" style={{ paddingBottom: 16 }}>
          <div className="fm-cat-glyph"><Icon name={glyph} size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fm-merchant">{merchant}</div>
            <div className="fm-merchant-sub">{amount} · {when}</div>
          </div>
        </div>
        <div className="fm-block-divider" />
        <div style={{ padding: '12px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="fm-chip suggest">
            <Icon name="sparkle" size={12} strokeWidth={2} /> {suggestion}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button className="fm-btn ghost" style={{ padding: '8px 12px', fontSize: 14 }}>Change</button>
            <button className="fm-btn primary" style={{ padding: '8px 16px', fontSize: 14 }}>Confirm</button>
          </span>
        </div>
      </div>
    );
  }

  if (layout === 'split') {
    return (
      <div className="fm-block">
        <div className="fm-block-top">
          <div className="fm-cat-glyph"><Icon name={glyph} size={20} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fm-merchant">{merchant}</div>
            <div className="fm-merchant-sub">{when}</div>
          </div>
          <div className="fm-amount-mono">{amount}</div>
        </div>
        <div className="fm-block-divider" />
        <div style={{
          padding: '14px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
          background: dark ? 'rgba(125, 216, 184,0.06)' : 'rgba(125, 216, 184,0.04)',
        }}>
          <Icon name="sparkle" size={16} color="var(--color-primary)" strokeWidth={2} />
          <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-body)' }}>
            Fina suggests <strong style={{ color: 'var(--color-ink)' }}>{suggestion}</strong>
          </div>
          <button style={{
            marginLeft: 'auto', padding: '4px 10px', borderRadius: 999,
            background: 'transparent', border: '1px solid var(--color-hairline)',
            font: 'var(--type-caption-strong)', cursor: 'pointer',
          }}>
            <Icon name="chevDown" size={12} strokeWidth={2} />
          </button>
        </div>
        <div className="fm-block-actions">
          <button className="fm-btn">Other</button>
          <button className="fm-btn primary">Confirm</button>
        </div>
      </div>
    );
  }

  // default
  return (
    <div className="fm-block">
      <div className="fm-block-top">
        <div className="fm-cat-glyph"><Icon name={glyph} size={20} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fm-merchant">{merchant}</div>
          <div className="fm-merchant-sub">{when}</div>
        </div>
        <div className="fm-amount-mono">{amount}</div>
      </div>
      <div className="fm-block-suggestion">
        <Icon name="sparkle" size={14} color="var(--color-primary)" strokeWidth={2} />
        <span>Categorize as</span>
        <button className="fm-chip" style={{ marginLeft: 'auto' }}>
          {suggestion} <Icon name="chevDown" size={12} strokeWidth={2} />
        </button>
      </div>
      <div className="fm-block-actions">
        <button className="fm-btn">Skip</button>
        <button className="fm-btn primary">
          <Icon name="check" size={14} strokeWidth={2.4} style={{ marginRight: 4, verticalAlign: -2 }} />
          Confirm
        </button>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────
// ConfirmCard
// ──────────────────────────────────────────────
const ConfirmCard = ({ question, acceptLabel = 'Yes, do it', rejectLabel = 'No' }) => (
  <div className="fm-block">
    <div style={{ padding: '16px 16px 8px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div className="fm-cat-glyph" style={{ background: 'rgba(230, 184, 92,0.12)', color: '#a87600' }}>
        <Icon name="alert" size={18} />
      </div>
      <div style={{ flex: 1, font: 'var(--type-body-md)', color: 'var(--color-ink)' }}>
        {question}
      </div>
    </div>
    <div className="fm-block-actions">
      <button className="fm-btn">{rejectLabel}</button>
      <button className="fm-btn primary">{acceptLabel}</button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// QuickReplies — pill list
// ──────────────────────────────────────────────
const QuickReplies = ({ options = [] }) => (
  <div className="fm-quick">
    {options.map((o, i) => <button key={i} className="fm-quick-pill">{o}</button>)}
  </div>
);

// ──────────────────────────────────────────────
// StatCard — morning brief hero
// ──────────────────────────────────────────────
const StatCard = ({ label, value, sub, progress, accentColor }) => (
  <div className="fm-stat">
    <div className="fm-stat-label">{label}</div>
    <div className="fm-stat-value">{value}</div>
    {sub && <div className="fm-stat-sub">{sub}</div>}
    {progress !== undefined && (
      <div className="fm-stat-bar">
        <span style={{ width: `${Math.min(progress, 100)}%`, background: accentColor || 'var(--color-primary)' }} />
      </div>
    )}
  </div>
);

// ──────────────────────────────────────────────
// Input bar
// ──────────────────────────────────────────────
const InputBar = ({ locked = false, lockMessage = 'Upgrade to Pro to chat', placeholder = 'Message Fina…', value = '', withTabBar = false }) => {
  const cls = `fm-input-bar${withTabBar ? ' with-tabbar' : ''}`;
  if (locked) {
    return (
      <div className={cls}>
        <div className="fm-input-locked">
          <Icon name="lock" size={16} />
          <span>{lockMessage}</span>
          <span className="fm-lock-cta">Upgrade</span>
        </div>
      </div>
    );
  }
  return (
    <div className={cls}>
      <div className={`fm-input${!value ? ' placeholder' : ''}`}>
        {value || placeholder}
      </div>
      <button className={`fm-send${!value ? ' disabled' : ''}`}>
        <Icon name="send" size={16} strokeWidth={2} />
      </button>
    </div>
  );
};

// ──────────────────────────────────────────────
// ScheduleFormBlock — inline mini-form for scheduling a future expense.
// AI sends this after detecting a recurring pattern or after user
// mentions an upcoming bill in chat.
// ──────────────────────────────────────────────
const ScheduleFormBlock = ({
  title = 'Schedule next month\'s rent?',
  sub = 'You\'ve paid Acme Properties on the 1st for 6 months running. Want me to track it?',
  when = 'Jun 1 · Sunday',
  amount = '$1,800.00',
  category = 'Housing',
  account = 'BMO Chequing',
  done = false,
}) => {
  if (done) {
    return (
      <div className="fm-block completed">
        <div className="fm-block-head">
          <div className="fm-cat-glyph up">
            <Icon name="calendar" size={18} strokeWidth={2} />
          </div>
          <div className="fm-block-head-text">
            <div className="fm-block-head-title">Scheduled for {when.split('·')[0].trim()}</div>
            <div className="fm-block-head-sub">{amount} · {category} · I'll remind you 2 days before.</div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="fm-block">
      <div className="fm-block-head">
        <div className="fm-cat-glyph">
          <Icon name="calendar" size={18} strokeWidth={2} />
        </div>
        <div className="fm-block-head-text">
          <div className="fm-block-head-title">{title}</div>
          <div className="fm-block-head-sub">{sub}</div>
        </div>
      </div>
      <div className="fm-form-rows">
        <div className="fm-form-row">
          <div className="fm-form-row-label">When</div>
          <div className="fm-form-row-value">
            {when}
            <span className="fm-chev"><Icon name="chevDown" size={12} strokeWidth={2} /></span>
          </div>
        </div>
        <div className="fm-form-row">
          <div className="fm-form-row-label">Amount</div>
          <div className="fm-form-row-value">
            {amount}
            <span className="fm-chev"><Icon name="chevDown" size={12} strokeWidth={2} /></span>
          </div>
        </div>
        <div className="fm-form-row">
          <div className="fm-form-row-label">Category</div>
          <div className="fm-form-row-value">
            {category}
            <span className="fm-chev"><Icon name="chevDown" size={12} strokeWidth={2} /></span>
          </div>
        </div>
        <div className="fm-form-row">
          <div className="fm-form-row-label">From</div>
          <div className="fm-form-row-value">
            {account}
            <span className="fm-chev"><Icon name="chevDown" size={12} strokeWidth={2} /></span>
          </div>
        </div>
      </div>
      <div className="fm-block-actions">
        <button className="fm-btn">Skip</button>
        <button className="fm-btn primary">Add to schedule</button>
      </div>
    </div>
  );
};

// ──────────────────────────────────────────────
// BudgetEditBlock — inline mini-form for adjusting a category budget.
// AI sends this when the user is consistently over or under budget.
// ──────────────────────────────────────────────
const BudgetEditBlock = ({
  category = 'Coffee & dining',
  glyph = 'coffee',
  current = '$250',
  spent = '$312',
  newAmount = '320',
  overBy = '25%',
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph warn">
        <Icon name="chart" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">Lift {category} budget?</div>
        <div className="fm-block-head-sub">You're {overBy} over for May ({spent} of {current}). Match real life?</div>
      </div>
    </div>
    <div className="fm-form-rows">
      <div className="fm-form-row">
        <div className="fm-form-row-label">Current</div>
        <div className="fm-form-row-value" style={{ color: 'var(--color-muted)', fontWeight: 500 }}>
          {current}/mo
        </div>
      </div>
      <div className="fm-form-row">
        <div className="fm-form-row-label">New</div>
        <div className="fm-form-row-value" style={{ marginLeft: 'auto' }}>
          <div className="fm-stepper">
            <button className="fm-stepper-btn">−</button>
            <span className="fm-stepper-val">${newAmount}</span>
            <button className="fm-stepper-btn">+</button>
          </div>
        </div>
      </div>
    </div>
    <div className="fm-block-actions">
      <button className="fm-btn">Keep {current}</button>
      <button className="fm-btn primary">Update to ${newAmount}</button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// PlanCard — savings goal / plan preview, sent inline in chat
// after AI helps the user reason about a future expense.
// ──────────────────────────────────────────────
const PlanCard = ({
  title = 'Japan trip · plan',
  meta = 'Target $2,400 · 6 months',
  status = 'On track',
  statusColor = 'var(--color-up)',
  progress = 62,
  saved = '$1,488 saved',
  glyph = 'sparkle',
  accentColor = 'var(--color-primary)',
}) => (
  <div className="fm-plan-card">
    <div className="fm-plan-card-head">
      <div className="fm-plan-glyph" style={{
        background: 'rgba(125, 216, 184,0.10)',
        color: accentColor,
      }}>
        <Icon name={glyph} size={16} strokeWidth={2} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="fm-plan-title">{title}</div>
        <div className="fm-plan-meta">{meta}</div>
      </div>
      <div className="fm-plan-status" style={{ color: statusColor }}>
        <span className="dot" />{status}
      </div>
    </div>
    <div className="fm-plan-bar">
      <div className="fm-plan-bar-fill" style={{
        width: `${Math.min(progress, 100)}%`,
        background: accentColor,
      }} />
    </div>
    <div className="fm-plan-foot">
      <span><strong>{saved}</strong></span>
      <span>{progress}%</span>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// AnomalyAlertBlock — flagged unusual spend.
// Big hero amount in red, compared to user's baseline.
// ──────────────────────────────────────────────
const AnomalyAlertBlock = ({
  merchant = 'Loblaws',
  when = 'Yesterday · 6:42 PM',
  amount = '−$342.18',
  usual = '$94.50',
  multiple = '3.6× higher',
  title = 'Heads-up — bigger than your usual',
  sub = "Worth a glance before I file it under Groceries?",
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph down">
        <Icon name="alert" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-block-hero">
      <div className="fm-block-hero-amount down">{amount}</div>
      <div className="fm-block-hero-sub"><strong>{merchant}</strong> · {when}</div>
    </div>
    <div className="fm-compare-row">
      <span className="label">Your usual here</span>
      <span className="value">{usual}</span>
      <span className="pill">{multiple}</span>
    </div>
    <div className="fm-block-actions">
      <button className="fm-btn">Looks right</button>
      <button className="fm-btn primary">Why so much?</button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// IncomeDetectedBlock — payroll/income hit. Big green amount + 4-up quick allocation.
// ──────────────────────────────────────────────
const IncomeDetectedBlock = ({
  source = 'Acme Co. payroll',
  when = 'Today · 9:02 AM',
  amount = '+$2,840.00',
  account = 'BMO Chequing',
  title = 'Payday landed',
  sub = "Anything you want me to do with it before it gets lost in the chequing soup?",
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph up">
        <Icon name="trendUp" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-block-hero">
      <div className="fm-block-hero-amount up">{amount}</div>
      <div className="fm-block-hero-sub"><strong>{source}</strong> · {when} · → {account}</div>
    </div>
    <div className="fm-quick-grid">
      <button className="fm-quick-tile">
        <span className="fm-quick-tile-glyph up"><Icon name="sparkle" size={14} strokeWidth={2} /></span>
        <span className="fm-quick-tile-label">Save 30%</span>
        <span className="fm-quick-tile-meta">$852 → goals</span>
      </button>
      <button className="fm-quick-tile">
        <span className="fm-quick-tile-glyph"><Icon name="calendar" size={14} strokeWidth={2} /></span>
        <span className="fm-quick-tile-label">Bills first</span>
        <span className="fm-quick-tile-meta">$1,217 reserved</span>
      </button>
      <button className="fm-quick-tile">
        <span className="fm-quick-tile-glyph warn"><Icon name="utensils" size={14} strokeWidth={2} /></span>
        <span className="fm-quick-tile-label">Tip jar</span>
        <span className="fm-quick-tile-meta">$50 to "Eat out"</span>
      </button>
      <button className="fm-quick-tile">
        <span className="fm-quick-tile-glyph"><Icon name="check" size={14} strokeWidth={2.4} /></span>
        <span className="fm-quick-tile-label">Just log it</span>
        <span className="fm-quick-tile-meta">No allocation</span>
      </button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// SubscriptionAuditBlock — list of subscriptions Fina noticed look unused.
// ──────────────────────────────────────────────
const SubscriptionAuditBlock = ({
  title = 'Found 3 subscriptions worth a look',
  sub = "These charged you last month but didn't show up in the activity I'd expect.",
  items = [
    { name: 'Hulu',    glyph: 'h',  meta: '$17.99/mo · last used 84 days', flag: 'idle',  flagLabel: 'Dormant' },
    { name: 'Headspace', glyph: 'H', meta: '$12.99/mo · last opened 31 days', flag: '',  flagLabel: 'Light use' },
    { name: 'Adobe CC',  glyph: 'A', meta: '$54.99/mo · used 14 days ago',     flag: 'keep', flagLabel: 'Keep' },
  ],
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph warn">
        <Icon name="bell" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-sub-list">
      {items.map((it, i) => (
        <div key={i} className="fm-sub-row">
          <div className="fm-sub-row-glyph">{it.glyph}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fm-sub-row-name">{it.name}</div>
            <div className="fm-sub-row-meta">{it.meta}</div>
          </div>
          {it.flagLabel && <span className={`fm-sub-row-flag ${it.flag || ''}`}>{it.flagLabel}</span>}
        </div>
      ))}
    </div>
    <div className="fm-block-actions">
      <button className="fm-btn">Keep all</button>
      <button className="fm-btn primary">Review one-by-one</button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// RecurringDetectedBlock — Fina noticed N charges on a cadence; offers to track.
// ──────────────────────────────────────────────
const RecurringDetectedBlock = ({
  merchant = 'Netflix',
  amount = '$22.99',
  cadence = 'Monthly · 12th',
  nextDate = 'Jun 12',
  title = "Looks like Netflix is monthly",
  sub = "Same amount, same week, four months running. Want me to track it so it doesn't surprise you?",
  history = ['Feb 12', 'Mar 12', 'Apr 12', 'May 12'],
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph">
        <Icon name="refresh" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-recurring-timeline">
      <div className="fm-recurring-dots">
        {history.map((_, i) => (
          <React.Fragment key={i}>
            <span className="fm-recurring-dot filled" />
            <span className="spacer" />
          </React.Fragment>
        ))}
        <span className="fm-recurring-dot next" />
      </div>
      <div className="fm-recurring-labels">
        {history.map((d, i) => (
          <React.Fragment key={i}>
            <span className="lbl">{d}</span>
            <span className="spacer" />
          </React.Fragment>
        ))}
        <span className="lbl next">{nextDate}</span>
      </div>
    </div>
    <div className="fm-form-rows">
      <div className="fm-form-row">
        <div className="fm-form-row-label">Amount</div>
        <div className="fm-form-row-value">{amount}</div>
      </div>
      <div className="fm-form-row">
        <div className="fm-form-row-label">Cadence</div>
        <div className="fm-form-row-value">
          {cadence}
          <span className="fm-chev"><Icon name="chevDown" size={12} strokeWidth={2} /></span>
        </div>
      </div>
    </div>
    <div className="fm-block-actions">
      <button className="fm-btn">Just this once</button>
      <button className="fm-btn primary">Track recurring</button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// MerchantRenameBlock — clean up a messy Plaid merchant string.
// ──────────────────────────────────────────────
const MerchantRenameBlock = ({
  raw = 'AMZN MKTPL*S94X81',
  proposed = 'Amazon',
  title = 'Rename this merchant?',
  sub = "Plaid sends ugly names. I'd file it as Amazon — and clean up 14 past transactions too.",
  affected = 14,
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph ink">
        <Icon name="pencil" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-rename-form">
      <div className="fm-rename-input">
        {proposed}
        <span className="caret" />
      </div>
      <div className="fm-rename-preview">
        <span className="from">{raw}</span>
        <span className="arrow"><Icon name="arrowRight" size={14} strokeWidth={2} /></span>
        <span className="to">{proposed}</span>
      </div>
      <div className="fm-rename-helper">Applies to {affected} past transactions and everything Amazon sends next.</div>
    </div>
    <div className="fm-block-actions">
      <button className="fm-btn">Keep ugly</button>
      <button className="fm-btn primary">Rename to {proposed}</button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// SplitTransactionBlock — divide a single transaction across categories.
// ──────────────────────────────────────────────
const SplitTransactionBlock = ({
  merchant = 'Costco Wholesale',
  amount = '$237.84',
  title = 'Split this Costco run?',
  sub = "Mostly Groceries but I spotted a $58 case of wine and a $48 fuel charge.",
  splits = [
    { name: 'Groceries',     amount: '$131.84', pct: 55, color: '#7dd8b8' },
    { name: 'Wine & spirits', amount: '$58.00',  pct: 25, color: '#cd6c50' },
    { name: 'Fuel',          amount: '$48.00',  pct: 20, color: '#a87600' },
  ],
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph">
        <Icon name="pieChart" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-block-hero" style={{ paddingBottom: 8 }}>
      <div className="fm-block-hero-amount" style={{ fontSize: 30, letterSpacing: '-1px' }}>{amount}</div>
      <div className="fm-block-hero-sub"><strong>{merchant}</strong> · Yesterday · 8:51 PM</div>
    </div>
    <div className="fm-split-bar">
      {splits.map((s, i) => (
        <span key={i} style={{ width: `${s.pct}%`, background: s.color }} />
      ))}
    </div>
    <div className="fm-split-rows">
      {splits.map((s, i) => (
        <div key={i} className="fm-split-row">
          <span className="fm-split-swatch" style={{ background: s.color }} />
          <span className="fm-split-name">{s.name}</span>
          <span className="fm-split-amount">{s.amount}</span>
          <span className="fm-split-pct">{s.pct}%</span>
        </div>
      ))}
    </div>
    <div className="fm-block-actions">
      <button className="fm-btn">All Groceries</button>
      <button className="fm-btn primary">Split it</button>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// WeeklyRecapBlock — Sunday-evening "this week" digest, 3 stats + a flourish.
// ──────────────────────────────────────────────
const WeeklyRecapBlock = ({
  title = 'Your week, recapped',
  sub = "May 6–12 · Calmer than last week — and that's worth saying out loud.",
  stats = [
    { lbl: 'Spent',    val: '$487',  delta: '−$162',  dir: 'up' },
    { lbl: 'Top cat',  val: 'Groceries', delta: '4 trips', dir: '' },
    { lbl: 'Saved',    val: '$214',  delta: '+38%', dir: 'up' },
  ],
  highlight = "You didn't open delivery apps once. First week of May — that's a streak.",
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph">
        <Icon name="chart" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-recap-grid">
      {stats.map((s, i) => (
        <div key={i} className="fm-recap-stat">
          <div className="lbl">{s.lbl}</div>
          <div className="val">{s.val}</div>
          {s.delta && <div className={`delta ${s.dir}`}>{s.delta}</div>}
        </div>
      ))}
    </div>
    <div style={{
      margin: '0 16px 14px',
      padding: '12px 14px',
      background: 'rgba(31, 138, 91,0.06)',
      border: '1px solid rgba(31, 138, 91,0.18)',
      borderRadius: 12,
      font: 'var(--type-body-sm)',
      color: 'var(--color-ink)',
      display: 'flex', alignItems: 'flex-start', gap: 10,
      lineHeight: 1.4,
    }}>
      <Icon name="sparkle" size={16} color="var(--color-up)" strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{highlight}</span>
    </div>
  </div>
);

// ──────────────────────────────────────────────
// SafeToSpendBlock — hero number ($X free this week after bills/saving).
// ──────────────────────────────────────────────
const SafeToSpendBlock = ({
  amount = '$284',
  period = 'free until Sunday',
  title = "Here's your runway",
  sub = "After bills and the goals you set, this is yours to spend without thinking.",
  bills = 60,
  saved = 22,
  free = 18,
  billsAmount = '$910',
  savedAmount = '$330',
  freeAmount = '$284',
}) => (
  <div className="fm-block">
    <div className="fm-block-head">
      <div className="fm-cat-glyph up">
        <Icon name="sparkle" size={18} strokeWidth={2} />
      </div>
      <div className="fm-block-head-text">
        <div className="fm-block-head-title">{title}</div>
        <div className="fm-block-head-sub">{sub}</div>
      </div>
    </div>
    <div className="fm-block-hero">
      <div className="fm-block-hero-amount up" style={{ fontSize: 46, letterSpacing: '-1.8px' }}>{amount}</div>
      <div className="fm-block-hero-sub">{period}</div>
    </div>
    <div className="fm-safe-strip">
      <span className="bills" style={{ width: `${bills}%` }} />
      <span className="saved" style={{ width: `${saved}%` }} />
      <span className="free" style={{ width: `${free}%` }} />
    </div>
    <div className="fm-safe-legend">
      <span className="item"><span className="swatch" style={{ background: 'var(--color-muted-soft, #b9b3a3)' }} /> Bills <strong>{billsAmount}</strong></span>
      <span className="item"><span className="swatch" style={{ background: 'var(--color-up)' }} /> Saved <strong>{savedAmount}</strong></span>
      <span className="item"><span className="swatch" style={{ background: 'var(--color-primary)' }} /> Free <strong>{freeAmount}</strong></span>
    </div>
  </div>
);

Object.assign(window, {
  Bubble, CategorizeCard, ConfirmCard, QuickReplies, StatCard, InputBar,
  ScheduleFormBlock, BudgetEditBlock, PlanCard,
  AnomalyAlertBlock, IncomeDetectedBlock, SubscriptionAuditBlock,
  RecurringDetectedBlock, MerchantRenameBlock, SplitTransactionBlock,
  WeeklyRecapBlock, SafeToSpendBlock,
});
