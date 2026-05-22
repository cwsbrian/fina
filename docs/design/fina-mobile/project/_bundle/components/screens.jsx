// screens.jsx — Each function returns a <Phone>-wrapped screen.
// All accept { dark, tier } where relevant.

// ============================================================
// 1. CHAT — Morning ritual hero (the core funnel)
// ============================================================
const ChatMorningHero = ({ dark, tier = 'pro' }) => {
  const inputLocked = tier !== 'pro';
  return (
    <Phone dark={dark}>
      <ChatHeader title="Morning brief" dark={dark} />
      <div className="fm-content" style={{ paddingBottom: inputLocked ? 60 : 100 }}>
        <div className="fm-chat-list" style={{ paddingTop: 12 }}>
          <div className="fm-chat-day">Today · 8:00 AM</div>
          <Bubble role="ai">
            Morning, Brian — yesterday came to <strong>$214.83</strong> across 5 transactions. Two need a category.
          </Bubble>

          <CategorizeCard
            merchant="Costco Wholesale"
            amount="$87.43"
            when="Yesterday, 9:12 PM"
            glyph="cart"
            suggestion="Groceries"
            layout="default"
            dark={dark}
          />

          <CategorizeCard
            merchant="Tim Hortons"
            amount="$6.50"
            when="Yesterday, 10:04 AM"
            glyph="coffee"
            suggestion="Coffee & dining"
            layout="default"
            dark={dark}
          />

          <Bubble role="ai">
            Heads-up — Netflix charges <strong>$22.99</strong> tomorrow. You have a friends&apos; dinner Friday too.
          </Bubble>

          <QuickReplies options={['Show me this week', 'Pause Netflix?', 'What did I spend on coffee?']} />
        </div>
      </div>

      {!inputLocked && <InputBar />}
      {inputLocked && <InputBar locked lockMessage={tier === 'lite' ? 'Tap any card to confirm — chat is Pro' : 'Upgrade to chat with Fina'} />}
    </Phone>
  );
};

// ============================================================
// 2. CHAT — Mid-ritual (one card already confirmed)
// ============================================================
const ChatMidRitual = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Morning brief" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-chat-list" style={{ paddingTop: 12 }}>
        <CategorizeCard
          merchant="Costco Wholesale"
          amount="$87.43"
          when="Yesterday, 9:12 PM"
          glyph="cart"
          category="Groceries"
          confirmed
        />

        <CategorizeCard
          merchant="Shell Gas Station"
          amount="$52.10"
          when="Yesterday, 4:38 PM"
          glyph="fuel"
          suggestion="Transport"
          layout="default"
        />

        <div className="fm-msg user">
          <div className="fm-bubble">Move all Walmart to Groceries going forward</div>
        </div>

        <ConfirmCard
          question="Got it — move 23 past Walmart transactions to Groceries, and auto-categorize new ones too?"
          acceptLabel="Yes, do it"
          rejectLabel="Just past ones"
        />
      </div>
    </div>
    <InputBar />
  </Phone>
);

// ============================================================
// 3. CHAT — All done
// ============================================================
const ChatDone = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Morning brief" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-chat-list" style={{ paddingTop: 12 }}>
        <CategorizeCard merchant="Costco Wholesale" amount="$87.43" when="Yesterday, 9:12 PM" glyph="cart" category="Groceries" confirmed />
        <CategorizeCard merchant="Tim Hortons" amount="$6.50" when="Yesterday, 10:04 AM" glyph="coffee" category="Coffee" confirmed />
        <CategorizeCard merchant="Shell Gas" amount="$52.10" when="Yesterday, 4:38 PM" glyph="fuel" category="Transport" confirmed />
        <Bubble role="ai">
          All caught up ✓ See you tomorrow morning.
        </Bubble>
        <QuickReplies options={['How am I doing this month?', 'Any subscriptions to cut?']} />
      </div>
    </div>
    <InputBar />
  </Phone>
);

// ============================================================
// 3b. CHAT — schedule_form block (in context)
// ============================================================
const ChatSchedule = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Schedule rent" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-chat-list" style={{ paddingTop: 12 }}>
        <div className="fm-chat-day">Today · 8:14 AM</div>
        <Bubble role="ai">
          Heads-up — your rent to <strong>Acme Properties</strong> is due in <strong>3 weeks</strong>. Same amount as the last 6 months. Want me to put it on the schedule?
        </Bubble>

        <ScheduleFormBlock
          title="Schedule June rent?"
          sub="Acme Properties · paid on the 1st for 6 months straight."
          when="Jun 1 · Sunday"
          amount="$1,800.00"
          category="Housing"
          account="BMO Chequing"
        />

        <QuickReplies options={['Yes, every month', 'Just this once', 'Different amount']} />
      </div>
    </div>
    <InputBar />
  </Phone>
);

// ============================================================
// 3c. CHAT — budget_edit block (in context)
// ============================================================
const ChatBudget = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Coffee & dining" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-chat-list" style={{ paddingTop: 12 }}>
        <div className="fm-chat-day">Today · 8:00 AM</div>
        <Bubble role="ai">
          You went <strong>$62 over</strong> on Coffee &amp; dining this month — and same the month before. Looks like the budget might be unrealistic.
        </Bubble>

        <BudgetEditBlock
          category="Coffee & dining"
          current="$250"
          spent="$312"
          newAmount="320"
          overBy="25%"
        />

        <Bubble role="ai" tag={false}>
          Or — if you want to <em>actually</em> cut back, I can flag every coffee over $5 for you. Up to you.
        </Bubble>

        <QuickReplies options={['Update budget', 'Help me cut back', 'Leave it']} />
      </div>
    </div>
    <InputBar />
  </Phone>
);

// ============================================================
// 3d. CHAT — plan card + reasoning (user asks "Can we afford X?")
// ============================================================
const ChatPlan = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Japan trip · plan" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-chat-list" style={{ paddingTop: 12 }}>
        <div className="fm-chat-day">Today · 7:42 PM</div>

        <div className="fm-msg user">
          <div className="fm-bubble">Can we afford Japan in November?</div>
        </div>

        <Bubble role="ai">
          Almost. You'd be <strong>$420 short</strong> at the current pace. Trim <strong>$80/mo</strong> on dining and you're there by <strong>Nov 12</strong>.
        </Bubble>

        <PlanCard
          title="Japan trip · plan"
          meta="Target $2,400 · 6 months"
          status="On track"
          progress={62}
          saved="$1,488 saved"
        />

        <Bubble role="ai" tag={false}>
          Want me to set a soft cap on Coffee &amp; dining at <strong>$170/mo</strong>? I'll nudge you if you're trending over.
        </Bubble>

        <QuickReplies options={['Set the cap', 'Show me where I overspend', 'Not yet']} />
      </div>
    </div>
    <InputBar />
  </Phone>
);

// ============================================================
// 4. TRANSACTIONS — list
// ============================================================
const TransactionsList = ({ dark, view = 'list' }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      <div className="fm-uncat-banner">
        <Icon name="sparkle" size={20} strokeWidth={2} />
        <div>
          <div style={{ fontWeight: 600 }}>2 uncategorized</div>
          <div style={{ font: 'var(--type-caption)', opacity: 0.85, marginTop: 2 }}>Sort them in chat in 30 seconds</div>
        </div>
        <div className="fm-uncat-cta">Open<br />chat →</div>
      </div>

      <div className="fm-tx-day">
        <span>Today · May 12</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
      </div>
      <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
      <TxRow icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$146.03</span>
      </div>
      <TxRow icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="21:12" pending />
      <TxRow icon="coffee" name="Tim Hortons" cat={null} amount="−$6.50" time="10:04" />
      <TxRow icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="16:38" />

      <div className="fm-tx-day">
        <span>May 10</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>+$2,840.00</span>
      </div>
      <TxRow icon="home" name="Payroll · Stripe Inc." cat="Income" amount="+$2,840.00" time="09:00" income />
      <TxRow icon="utensils" name="Joe&apos;s Pizza" cat="Coffee & dining" amount="−$28.50" time="20:14" />
      <TxRow icon="film" name="Netflix" cat="Subscriptions" amount="−$22.99" time="00:01" />

      <div style={{ height: 24 }} />
    </div>

    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

const TxRow = ({ icon, name, cat, amount, time, pending = false, income = false }) => (
  <div className="fm-tx-row">
    <div className="fm-cat-glyph" style={{ width: 36, height: 36, fontSize: 16 }}>
      <Icon name={icon} size={16} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="fm-tx-name">
        {name}
        {pending && <span className="fm-tx-badge">Pending</span>}
      </div>
      <div className={`fm-tx-cat${!cat ? ' uncat' : ''}`}>{cat || 'Uncategorized'}</div>
    </div>
    <div className="fm-tx-amount">
      <div className={`amt${income ? ' up' : ''}`}>{amount}</div>
      <div className="time">{time}</div>
    </div>
  </div>
);

// ============================================================
// 5. TRANSACTION DETAIL
// ============================================================
const TransactionDetail = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Transaction</div>
      <div className="fm-nav-spacer" />
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div style={{ padding: '12px 24px 28px', textAlign: 'left' }}>
        <div className="fm-cat-glyph" style={{ width: 52, height: 52, marginBottom: 14 }}>
          <Icon name="cart" size={22} />
        </div>
        <div style={{ font: 'var(--type-title-md)', fontWeight: 600 }}>Costco Wholesale</div>
        <div style={{ font: '38px/1 var(--font-sans)', fontWeight: 500, letterSpacing: '-1.4px', fontVariantNumeric: 'tabular-nums lining-nums', marginTop: 8 }}>
          −$87.43
        </div>
        <div style={{ font: 'var(--type-body-sm)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)', marginTop: 6 }}>
          May 11 · 9:12 PM
        </div>
      </div>

      <div className="fm-settings-group-label">Details</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row">
          <span>Account</span>
          <div className="fm-row-detail">BMO Chequing ··1234</div>
        </div>
        <div className="fm-settings-row">
          <span>Status</span>
          <div className="fm-row-detail" style={{ color: 'var(--color-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-up)', display: 'inline-block' }} /> Posted
          </div>
        </div>
        <div className="fm-settings-row">
          <span>Merchant</span>
          <div className="fm-row-detail">COSTCO WHSE #0641</div>
        </div>
      </div>

      <div className="fm-settings-group-label">Category</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row" style={{ padding: '16px' }}>
          <div className="fm-cat-glyph" style={{ width: 34, height: 34 }}><Icon name="cart" size={16} /></div>
          <div>
            <div style={{ fontWeight: 600 }}>Groceries</div>
            <div style={{ font: 'var(--type-caption)', color: 'var(--color-muted)', marginTop: 2 }}>
              Applies to 12 past Costco transactions
            </div>
          </div>
          <div className="fm-row-detail"><span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Change</span></div>
        </div>
      </div>

      <div className="fm-settings-group-label">Note</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row" style={{ padding: '14px 16px', color: 'var(--color-muted)' }}>
          Weekly grocery run — split with Jen
        </div>
      </div>

      <div style={{ padding: '12px 16px 24px' }}>
        <button className="fm-btn" style={{ width: '100%', color: 'var(--color-down)', background: 'transparent' }}>
          Delete transaction
        </button>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 6. BANKS
// ============================================================
const Banks = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Banks</div>
      <div className="fm-nav-spacer" />
      <button className="fm-nav-back" aria-label="Add bank" style={{ marginRight: -4 }}>
        <Icon name="plus" size={20} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-content" style={{ paddingTop: 55, paddingBottom: 32 }}>
      <BankCard
        name="BMO"
        logo="BMO"
        logoBg="#0079c1"
        sync="Synced 2 minutes ago"
        accounts={[
          { name: 'Chequing', mask: '1234', balance: '$4,128.50' },
          { name: 'Savings', mask: '5678', balance: '$12,890.00' },
        ]}
      />
      <BankCard
        name="TD Bank"
        logo="TD"
        logoBg="#1c8c44"
        sync="Reconnection required"
        error
        accounts={[
          { name: 'Credit Card', mask: '0042', balance: '−$487.20' },
        ]}
      />
      <button className="fm-add-bank">
        <span className="fm-add-bank-tile">
          <Icon name="plus" size={18} strokeWidth={2.2} />
        </span>
        <span className="fm-add-bank-body">
          <span className="fm-add-bank-title">Connect another bank</span>
          <span className="fm-add-bank-sub">Plaid · 12,000+ banks worldwide</span>
        </span>
        <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
      </button>

      <div style={{ padding: '16px 24px 32px', font: 'var(--type-caption)', color: 'var(--color-muted)', lineHeight: 1.5 }}>
        Fina connects via Plaid using bank-grade encryption. Your credentials are never stored.
      </div>
    </div>
  </Phone>
);

const BankCard = ({ name, logo, logoBg, sync, accounts = [], error = false }) => (
  <div className={`fm-bank-card${error ? ' error' : ''}`} style={error ? { marginTop: 0 } : {}}>
    <div className="fm-bank-head">
      <div className="fm-bank-logo" style={{ background: logoBg, color: '#fff' }}>{logo}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="fm-bank-name">{name}</div>
        <div className={`fm-bank-sync${error ? ' error' : ''}`}>
          {error && <Icon name="alert" size={12} strokeWidth={2} style={{ verticalAlign: -1, marginRight: 4 }} />}
          {sync}
        </div>
      </div>
    </div>
    {accounts.length > 0 && (
      <div style={{ marginTop: 12 }}>
        {accounts.map((a, i) => (
          <div key={i} className="fm-account-row">
            <span className="fm-account-name">{a.name}</span>
            <span className="fm-account-mask">··{a.mask}</span>
            <span className="fm-account-balance">{a.balance}</span>
          </div>
        ))}
      </div>
    )}
    <div className="fm-bank-actions">
      {error
        ? <><button className="fm-btn primary" style={{ flex: 2 }}>Reconnect</button><button className="fm-btn">Remove</button></>
        : <><button className="fm-btn">Refresh</button><button className="fm-btn">Manage</button></>
      }
    </div>
  </div>
);

// ============================================================
// 7. SETTINGS
// ============================================================
const Settings = ({ dark, tier = 'pro' }) => {
  const tierLabel = tier === 'pro' ? 'Pro Trial · 27 days left' : tier === 'lite' ? 'Lite' : 'Free';
  const tierClass = tier === 'pro' ? '' : tier === 'lite' ? '' : 'free';

  return (
    <Phone dark={dark}>
      <Header title="More" dark={dark} />
      <div className="fm-content" style={{ paddingBottom: 84 }}>
        {/* Profile — first, label-less */}
        <div className="fm-profile-card">
          <div className="fm-profile-avatar">B</div>
          <div style={{ flex: 1 }}>
            <div className="fm-profile-name">Brian Choi</div>
            <div className="fm-profile-mail">cwsbrian@gmail.com</div>
            <div className={`fm-tier-pill ${tierClass}`}>{tierLabel}</div>
          </div>
        </div>

        {/* Workspace — prominent */}
        <div className="fm-settings-group-label" style={{ marginTop: 6 }}>Workspace</div>
        <button className="fm-ws-card">
          <span className="fm-ws-card-mark" style={{ background: 'var(--color-ink)' }}>C</span>
          <div className="fm-ws-card-body">
            <div className="fm-ws-card-name">Choi family</div>
            <div className="fm-ws-card-meta">Owner · 2 members · 1 pending</div>
          </div>
          <span className="fm-ws-card-switch">
            <Icon name="chevDown" size={14} strokeWidth={2} />
          </span>
        </button>
        <div className="fm-ws-card-actions">
          <button className="fm-ws-card-action">
            <Icon name="user" size={14} strokeWidth={1.8} />
            Manage members
          </button>
          <button className="fm-ws-card-action">
            <Icon name="plus" size={14} strokeWidth={2.2} />
            New workspace
          </button>
        </div>

        <div className="fm-settings-group-label" style={{ marginTop: 20 }}>Planning</div>
        <div className="fm-settings-group">
          <div className="fm-settings-row">
            <span className="fm-settings-glyph">
              <Icon name="calendar" size={16} strokeWidth={1.8} />
            </span>
            <div className="fm-settings-row-body">
              <span className="fm-settings-row-title">Schedule</span>
              <span className="fm-settings-row-sub">
                <span>6 upcoming this month</span>
                <span className="dot" />
                <span>4 subscriptions</span>
              </span>
            </div>
            <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
          </div>
        </div>

        <div className="fm-settings-group-label" style={{ marginTop: 20 }}>Insights</div>
        <div className="fm-settings-group">
          <div className="fm-settings-row">
            <span className="fm-settings-glyph">
              <Icon name="chart" size={16} strokeWidth={1.8} />
            </span>
            <div className="fm-settings-row-body">
              <span className="fm-settings-row-title">Analysis</span>
              <span className="fm-settings-row-sub">
                <span>Patterns, trends &amp; category breakdown</span>
              </span>
            </div>
            <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
          </div>
        </div>

        <div className="fm-settings-group-label" style={{ marginTop: 20 }}>Connections</div>
        <div className="fm-settings-group">
          <div className="fm-settings-row">
            <span className="fm-settings-glyph">
              <Icon name="bank" size={16} strokeWidth={1.8} />
            </span>
            <div className="fm-settings-row-body">
              <span className="fm-settings-row-title">Banks</span>
              <span className="fm-settings-row-sub">
                <span>2 connected</span>
                <span className="dot warn" />
                <span className="warn">1 needs reconnect</span>
              </span>
            </div>
            <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
          </div>
        </div>

        <div className="fm-settings-group-label">AI</div>
        <div className="fm-settings-group">
          <SettingsRow label="Morning brief time" detail="8:00 AM" />
          <SettingsRow label="Notifications" detail="7 on" />
          <SettingsRow label="Pause briefings" detail={<div className="fm-toggle" />} chevron={false} />
          <SettingsRow label="Categorization style" detail="Strict" />
        </div>

        <div className="fm-settings-group-label">Subscription</div>
        <div className="fm-settings-group">
          <SettingsRow label="Plan" detail={tier === 'pro' ? 'Pro · 27 days left' : tier === 'lite' ? 'Lite · $7/mo' : 'Free'} />
          <SettingsRow label="Manage billing" />
        </div>

        <div className="fm-settings-group-label">Account</div>
        <div className="fm-settings-group">
          <SettingsRow label="Export data" />
          <SettingsRow label="Sign out" />
          <SettingsRow label={<span style={{ color: 'var(--color-down)' }}>Delete account</span>} chevron={false} />
        </div>

        <div style={{ height: 24 }} />
      </div>
      <TabBar active="more" />
    </Phone>
  );
};

const SettingsRow = ({ label, detail, chevron = true }) => (
  <div className="fm-settings-row">
    <span style={{ flex: 1 }}>{label}</span>
    {detail && <div className="fm-row-detail">{detail}</div>}
    {chevron && <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />}
  </div>
);

// ============================================================
// 8. UPGRADE PROMPT (bottom-sheet over chat)
// ============================================================
const UpgradePrompt = ({ dark }) => (
  <Phone dark={dark}>
    <div style={{ filter: 'blur(2px) brightness(0.85)' }}>
      <ChatHeader title="Morning brief" dark={dark} />
      <div className="fm-content" style={{ paddingBottom: 100 }}>
        <div className="fm-chat-list" style={{ paddingTop: 12 }}>
          <Bubble role="ai">Morning, Brian — yesterday came to <strong>$214.83</strong>.</Bubble>
        </div>
      </div>
    </div>
    <div className="fm-sheet-scrim">
      <div className="fm-sheet">
        <div className="fm-sheet-grabber" />
        <div style={{ width: 48, height: 48, borderRadius: 14, background: 'rgba(125, 216, 184,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)',
          marginBottom: 16 }}>
          <Icon name="sparkle" size={24} strokeWidth={1.8} />
        </div>
        <h2>Chat with Fina</h2>
        <p>Get an AI that knows your accounts, surfaces what matters, and categorizes for you each morning.</p>

        <div className="fm-tier-card">
          <div style={{ flex: 1 }}>
            <div className="fm-tier-name">Lite</div>
            <div className="fm-tier-price">$7/mo · 1 bank · read-only chat</div>
          </div>
          <button className="fm-tier-cta" style={{ background: 'var(--color-ink)' }}>Choose</button>
        </div>

        <div className="fm-tier-card featured">
          <div style={{ flex: 1 }}>
            <div className="fm-tier-name">Pro</div>
            <div className="fm-tier-price">$15/mo · unlimited banks · full chat</div>
          </div>
          <button className="fm-tier-cta">Choose</button>
        </div>

        <button style={{
          marginTop: 16, padding: '12px 16px', background: 'transparent', border: 0,
          font: 'var(--type-body-sm)', color: 'var(--color-muted)', cursor: 'pointer',
        }}>Maybe later</button>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 9. ONBOARDING (slide 1)
// ============================================================
const Onboarding = ({ dark }) => (
  <Phone dark={dark}>
    <div style={{ position: 'absolute', top: 20, right: 24, zIndex: 5 }}>
      <button style={{ background: 'transparent', border: 0, font: 'var(--type-body-sm)', color: 'var(--color-muted)', cursor: 'pointer' }}>
        Skip
      </button>
    </div>
    <div className="fm-onb">
      <div className="fm-onb-illo">
        {/* Mini chat preview as illustration */}
        <div style={{
          position: 'absolute', inset: 22,
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10,
        }}>
          <div style={{
            font: 'var(--type-caption-strong)', textTransform: 'uppercase', letterSpacing: '0.6px',
            color: 'var(--color-ink)', display: 'inline-flex', alignItems: 'center', gap: 7,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-primary)' }} />
            Fina · Morning brief
          </div>
          <div style={{
            background: '#fff', padding: '12px 14px', borderRadius: 18, borderBottomLeftRadius: 6,
            font: 'var(--type-body-sm)', maxWidth: '94%',
            border: '1px solid #dee1e6',
          }}>
            Morning — yesterday came to <strong>$214.83</strong>.
          </div>
          <div style={{
            background: '#fff', padding: 14, borderRadius: 16,
            border: '1px solid #dee1e6',
            boxShadow: '0 4px 12px rgba(0,0,0,0.04)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="fm-cat-glyph" style={{ width: 32, height: 32 }}>
                <Icon name="cart" size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: 'var(--type-body-sm)', fontWeight: 600 }}>Costco</div>
                <div style={{ font: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>$87.43 · Groceries?</div>
              </div>
              <div style={{
                width: 28, height: 28, borderRadius: 999, background: 'var(--color-primary)', color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name="check" size={14} strokeWidth={2.4} />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="fm-onb-title">Every morning, before you open your wallet.</div>
      <div className="fm-onb-sub">Fina checks yesterday, flags what matters, and asks for one tap to sort the rest.</div>
      <button className="fm-onb-cta">Create account</button>
      <div className="fm-onb-dots">
        <span className="fm-onb-dot active" />
        <span className="fm-onb-dot" />
        <span className="fm-onb-dot" />
      </div>
      <div style={{ textAlign: 'center', marginTop: 14, font: 'var(--type-body-sm)', color: 'var(--color-muted)' }}>
        Already have an account? <a href="#" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Sign in</a>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 9b. ONBOARDING (slide 2) — "Talk it over with Fina"
// ============================================================
const OnboardingTalk = ({ dark }) => (
  <Phone dark={dark}>
    <div style={{ position: 'absolute', top: 20, right: 24, zIndex: 5 }}>
      <button style={{ background: 'transparent', border: 0, font: 'var(--type-body-sm)', color: 'var(--color-muted)', cursor: 'pointer' }}>
        Skip
      </button>
    </div>
    <div className="fm-onb">
      <div className="fm-onb-illo">
        <div style={{
          position: 'absolute', inset: 22,
          display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 10,
        }}>
          <div style={{
            font: 'var(--type-caption-strong)', textTransform: 'uppercase', letterSpacing: '0.6px',
            color: 'var(--color-ink)', display: 'inline-flex', alignItems: 'center', gap: 7,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-primary)' }} />
            Fina · Chat
          </div>
          {/* User question — right aligned */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{
              background: 'var(--color-primary)', color: '#fff',
              padding: '10px 14px', borderRadius: 18, borderBottomRightRadius: 6,
              font: 'var(--type-body-sm)', maxWidth: '82%',
              boxShadow: '0 2px 6px rgba(201,100,66,0.16)',
            }}>
              Can we afford Japan in November?
            </div>
          </div>
          {/* AI reply — left aligned */}
          <div style={{
            background: '#fff', padding: '12px 14px', borderRadius: 18, borderBottomLeftRadius: 6,
            font: 'var(--type-body-sm)', maxWidth: '92%',
            border: '1px solid #dee1e6',
          }}>
            Almost. Trim <strong>$80/mo</strong> on dining and you&apos;re there by <strong>Nov 12</strong>.
          </div>
          {/* Plan preview card */}
          <div style={{
            background: '#fff', padding: '12px 14px', borderRadius: 16,
            border: '1px solid #dee1e6',
            boxShadow: '0 4px 12px rgba(0,0,0,0.04)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 9,
                background: 'rgba(201,100,66,0.12)', color: 'var(--color-primary)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name="sparkle" size={14} strokeWidth={2} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: 'var(--type-body-sm)', fontWeight: 600, color: 'var(--color-ink)' }}>Japan trip · plan</div>
                <div style={{ font: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-muted)', marginTop: 1 }}>
                  Target $2,400 · 6 months
                </div>
              </div>
              <div style={{ font: 13, fontWeight: 600, color: 'var(--color-up)', letterSpacing: '-0.2px' }}>On track</div>
            </div>
            {/* Progress bar */}
            <div style={{ height: 6, borderRadius: 999, background: '#eef0f3', overflow: 'hidden' }}>
              <div style={{
                width: '62%', height: '100%',
                background: 'linear-gradient(90deg, var(--color-primary), #e58a6c)',
                borderRadius: 999,
              }} />
            </div>
            <div style={{
              marginTop: 8, display: 'flex', justifyContent: 'space-between',
              font: 11, fontFamily: 'var(--font-mono)', color: 'var(--color-muted)',
            }}>
              <span>$1,488 saved</span>
              <span>62%</span>
            </div>
          </div>
        </div>
      </div>
      <div className="fm-onb-title">Talk it over with Fina.</div>
      <div className="fm-onb-sub">Should we cancel Netflix? Can we afford the trip? Fina knows your numbers and helps you decide.</div>
      <button className="fm-onb-cta">Create account</button>
      <div className="fm-onb-dots">
        <span className="fm-onb-dot" />
        <span className="fm-onb-dot active" />
        <span className="fm-onb-dot" />
      </div>
      <div style={{ textAlign: 'center', marginTop: 14, font: 'var(--type-body-sm)', color: 'var(--color-muted)' }}>
        Already have an account? <a href="#" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Sign in</a>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 9c. ONBOARDING (slide 3) — "Together"
// ============================================================
const OnboardingShare = ({ dark }) => (
  <Phone dark={dark}>
    <div style={{ position: 'absolute', top: 20, right: 24, zIndex: 5 }}>
      <button style={{ background: 'transparent', border: 0, font: 'var(--type-body-sm)', color: 'var(--color-muted)', cursor: 'pointer' }}>
        Skip
      </button>
    </div>
    <div className="fm-onb">
      <div className="fm-onb-illo">
        <div style={{ position: 'absolute', inset: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* Workspace card */}
          <div style={{
            width: '100%',
            background: '#fff', borderRadius: 20,
            border: '1px solid #dee1e6',
            boxShadow: '0 10px 28px rgba(0,0,0,0.06)',
            overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding: '14px 16px 12px',
              borderBottom: '1px solid #ececec',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{
                  font: 'var(--type-caption-strong)', textTransform: 'uppercase', letterSpacing: '0.6px',
                  color: 'var(--color-muted)', marginBottom: 2,
                }}>Workspace</div>
                <div style={{ font: 'var(--type-body-md)', fontWeight: 600, color: 'var(--color-ink)' }}>Choi family</div>
              </div>
              <div style={{
                padding: '3px 8px', borderRadius: 999,
                background: 'rgba(46,160,67,0.12)', color: '#1e7d36',
                font: 11, fontWeight: 600, letterSpacing: '0.2px',
              }}>2 members</div>
            </div>
            {/* Member rows */}
            <div style={{ padding: '6px 8px' }}>
              {[
                { name: 'Brian Choi', role: 'Owner · you', bg: '#c96442', initials: 'BC' },
                { name: 'Joelle Choi', role: 'Editor · active', bg: '#2a7c8c', initials: 'JC' },
              ].map((m) => (
                <div key={m.initials} style={{
                  padding: '10px 10px', display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <div style={{
                    width: 34, height: 34, borderRadius: 999,
                    background: m.bg, color: '#fff',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    font: 12, fontWeight: 700, letterSpacing: '0.3px',
                  }}>{m.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ font: 'var(--type-body-sm)', fontWeight: 600, color: 'var(--color-ink)' }}>{m.name}</div>
                    <div style={{ font: 12, color: 'var(--color-muted)', marginTop: 1 }}>{m.role}</div>
                  </div>
                  <Icon name="check" size={15} color="var(--color-muted)" strokeWidth={1.8} />
                </div>
              ))}
            </div>
            {/* Footer — shared spend snapshot */}
            <div style={{
              padding: '12px 16px 14px',
              borderTop: '1px solid #ececec',
              display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
            }}>
              <div style={{
                font: 'var(--type-caption-strong)', textTransform: 'uppercase', letterSpacing: '0.6px',
                color: 'var(--color-muted)',
              }}>This month, together</div>
              <div style={{ font: 17, fontWeight: 600, color: 'var(--color-ink)', letterSpacing: '-0.3px' }}>$1,847</div>
            </div>
          </div>
          {/* Floating "+ Invite" pill */}
          <div style={{
            position: 'absolute', bottom: 20, right: -6,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 14px', borderRadius: 999,
            background: 'var(--color-ink)', color: '#fff',
            font: 'var(--type-body-sm)', fontWeight: 600,
            boxShadow: '0 6px 16px rgba(0,0,0,0.18)',
            transform: 'rotate(-2deg)',
          }}>
            <Icon name="plus" size={13} strokeWidth={2.4} />
            Invite
          </div>
        </div>
      </div>
      <div className="fm-onb-title">Money is a household thing.</div>
      <div className="fm-onb-sub">Invite your partner or family. See the same numbers, no spreadsheets. Free, forever.</div>
      <button className="fm-onb-cta">Create account</button>
      <div className="fm-onb-dots">
        <span className="fm-onb-dot" />
        <span className="fm-onb-dot" />
        <span className="fm-onb-dot active" />
      </div>
      <div style={{ textAlign: 'center', marginTop: 14, font: 'var(--type-body-sm)', color: 'var(--color-muted)' }}>
        Already have an account? <a href="#" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Sign in</a>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 10. SPLASH
// ============================================================
const Splash = ({ dark }) => (
  <Phone dark={dark}>
    <div style={{
      position: 'absolute', inset: 0,
      background: dark ? 'var(--color-surface-dark)' : 'var(--color-canvas)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 6,
    }}>
      <div style={{
        font: '56px var(--font-display)', fontWeight: 400, letterSpacing: '-2px',
        color: dark ? '#fff' : 'var(--color-ink)',
      }}>Fina</div>
      <div style={{
        position: 'absolute', bottom: 80,
        font: 'var(--type-caption-strong)', color: 'var(--color-muted)',
        textTransform: 'uppercase', letterSpacing: '0.5px',
      }}>
        The trusted home for your money
      </div>
    </div>
  </Phone>
);

// ============================================================
// 11. SIGN UP
// ============================================================
const AuthField = ({ label, value, filled = true, focused = false, secret = false, strength, trailing }) => (
  <div className={`fm-auth-field${focused ? ' focused' : filled ? ' filled' : ''}`}>
    <span className="fm-auth-field-label">{label}</span>
    {(filled || focused) && (
      <div className="fm-auth-field-value">
        {secret ? '•'.repeat(value.length) : value}
      </div>
    )}
    {strength && <span className="fm-auth-field-strength">{strength}</span>}
    {trailing}
  </div>
);

const SocialButton = ({ glyph, label, dark = false }) => (
  <button
    className="fm-auth-social"
    style={dark ? { background: 'var(--color-ink)', color: '#fff', borderColor: 'var(--color-ink)' } : {}}
  >
    {glyph}
    {label}
  </button>
);

const GoogleGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62z"/>
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.34A9 9 0 0 0 9 18z"/>
    <path fill="#FBBC05" d="M3.95 10.7a5.41 5.41 0 0 1 0-3.4V4.96H.94a9 9 0 0 0 0 8.08l3.01-2.34z"/>
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 0 0 .94 4.96L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z"/>
  </svg>
);

const AppleGlyph = () => (
  <svg width="16" height="18" viewBox="0 0 16 18" fill="#fff" aria-hidden>
    <path d="M13.05 9.55c-.02-2.13 1.74-3.16 1.82-3.21-1-1.46-2.55-1.66-3.1-1.68-1.32-.13-2.58.78-3.25.78-.67 0-1.71-.76-2.81-.74-1.45.02-2.78.84-3.53 2.13-1.5 2.6-.38 6.43 1.08 8.54.72 1.03 1.57 2.19 2.68 2.15 1.07-.04 1.48-.69 2.78-.69s1.67.69 2.81.67c1.16-.02 1.9-1.05 2.6-2.09a9.2 9.2 0 0 0 1.18-2.42c-.03-.01-2.26-.87-2.28-3.44zM10.96 3.32c.59-.71.98-1.7.87-2.69-.84.03-1.86.56-2.46 1.27-.54.63-1.01 1.64-.88 2.61.94.07 1.89-.48 2.47-1.19z"/>
  </svg>
);

const SignUp = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth centered">
      <button className="fm-auth-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>

      <div className="fm-auth-head">
        <div className="fm-auth-title">Create your account.</div>
        <div className="fm-auth-sub">A trusted home for your money — set up in 30 seconds.</div>
      </div>

      <div className="fm-auth-form">
        <AuthField label="Full name" value="Brian Choi" focused />
        <AuthField label="Email" value="brian.choi@gmail.com" />
        <AuthField
          label="Password"
          value="ninetwentythree"
          secret
          strength="Strong"
          trailing={
            <button className="fm-auth-field-eye" aria-label="Show password">
              <Icon name="eye" size={18} />
            </button>
          }
        />
      </div>

      <button className="fm-auth-cta primary">Create account</button>

      <div className="fm-auth-divider">or</div>

      <SocialButton glyph={<GoogleGlyph />} label="Continue with Google" />
      <SocialButton glyph={<AppleGlyph />} label="Continue with Apple" dark />

      <div className="fm-auth-legal">
        By creating an account you agree to Fina&apos;s <a>Terms</a> and <a>Privacy&nbsp;Policy</a>.
      </div>

      <div className="fm-auth-foot">
        Already have an account? <a>Sign in</a>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 12. SIGN IN
// ============================================================
const SignIn = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth centered">
      <button className="fm-auth-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>

      <div className="fm-auth-head">
        <div className="fm-auth-title">Welcome back.</div>
        <div className="fm-auth-sub">Pick up right where you left off.</div>
      </div>

      <div className="fm-auth-form">
        <AuthField label="Email" value="cwsbrian@gmail.com" />
        <AuthField
          label="Password"
          value="ninetwentythree"
          secret
          focused
          trailing={
            <button className="fm-auth-field-eye" aria-label="Show password">
              <Icon name="eye" size={18} />
            </button>
          }
        />
      </div>

      <div className="fm-auth-helper-row">
        <button className="fm-auth-helper-link">Forgot password?</button>
      </div>

      <button className="fm-auth-cta primary" style={{ marginTop: 12 }}>Sign in</button>

      <div className="fm-auth-divider">or</div>

      <SocialButton glyph={<GoogleGlyph />} label="Continue with Google" />
      <SocialButton glyph={<AppleGlyph />} label="Continue with Apple" dark />

      <button
        className="fm-auth-social"
        style={{
          marginTop: 10,
          background: 'transparent',
          border: '1px dashed var(--color-hairline)',
          color: 'var(--color-body)',
          fontWeight: 500,
        }}
      >
        <Icon name="mail" size={18} strokeWidth={1.8} />
        Email me a magic link
      </button>

      <div className="fm-auth-foot">
        New to Fina? <a>Create an account</a>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 13. EMAIL VERIFY (OTP)
// ============================================================
const EmailVerify = ({ dark }) => {
  const digits = ['4', '8', '2', '6', '', ''];
  const activeIndex = 4;
  return (
    <Phone dark={dark}>
      <div className="fm-auth">
        <button className="fm-auth-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>

        <div className="fm-auth-head">
          <div className="fm-auth-otp-illo">
            <Icon name="mailOpen" size={28} strokeWidth={1.6} />
          </div>
          <div className="fm-auth-title">Check your email.</div>
          <div className="fm-auth-sub">
            We sent a 6-digit code to <strong style={{ color: 'var(--color-ink)', fontWeight: 600 }}>brian.choi@gmail.com</strong>. It expires in 10 minutes.
          </div>
        </div>

        <div className="fm-otp-row">
          {digits.map((d, i) => (
            <div
              key={i}
              className={`fm-otp-box${d ? ' filled' : ''}${i === activeIndex ? ' active' : ''}`}
            >
              {d}
            </div>
          ))}
        </div>

        <div className="fm-auth-resend">
          Resend code in <strong>0:24</strong>
        </div>

        <div style={{ flex: 1 }} />

        <button
          className="fm-auth-social"
          style={{ marginTop: 12, background: 'transparent', border: 0, color: 'var(--color-muted)' }}
        >
          Wrong address? <span style={{ color: 'var(--color-primary)', fontWeight: 600, marginLeft: 4 }}>Change email</span>
        </button>
      </div>
    </Phone>
  );
};

// ============================================================
// 13a. FORGOT PASSWORD — email entry (reached from Sign in)
// ============================================================
const ForgotPassword = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth">
      <button className="fm-auth-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>

      <div className="fm-auth-head">
        <div className="fm-auth-title">Forgot your password?</div>
        <div className="fm-auth-sub">
          Type your email and we'll send a link to reset it.
        </div>
      </div>

      <div className="fm-auth-form">
        <AuthField label="Email" value="cwsbrian@gmail.com" focused />
      </div>

      <button className="fm-auth-cta primary" style={{ marginTop: 12 }}>Send reset link</button>

      <div className="fm-auth-foot">
        Remembered it? <a>Back to sign in</a>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 13b. RESET LINK SENT — confirmation after submitting email
// ============================================================
const ResetLinkSent = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth">
      <button className="fm-auth-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>

      <div className="fm-auth-head">
        <div className="fm-auth-otp-illo">
          <Icon name="mailOpen" size={28} strokeWidth={1.6} />
        </div>
        <div className="fm-auth-title">Check your email.</div>
        <div className="fm-auth-sub">
          We sent a reset link to <strong style={{ color: 'var(--color-ink)', fontWeight: 600 }}>cwsbrian@gmail.com</strong>.
          It expires in 30 minutes.
        </div>
      </div>

      <div className="fm-reset-checklist">
        <div className="fm-reset-step">
          <span className="num">1</span>
          <span>Open the email and tap the link.</span>
        </div>
        <div className="fm-reset-step">
          <span className="num">2</span>
          <span>Choose a new password.</span>
        </div>
        <div className="fm-reset-step">
          <span className="num">3</span>
          <span>You'll be signed in right after.</span>
        </div>
      </div>

      <div style={{ flex: 1 }} />

      <div className="fm-auth-resend" style={{ marginBottom: 8 }}>
        Didn't get it? <strong>Resend in 0:42</strong>
      </div>

      <button className="fm-auth-social"
        style={{ background: 'transparent', border: 0, color: 'var(--color-muted)' }}>
        Wrong address?
        <span style={{ color: 'var(--color-primary)', fontWeight: 600, marginLeft: 4 }}>Change email</span>
      </button>
    </div>
  </Phone>
);

// ============================================================
// 13c. RESET PASSWORD — new password form (after tapping email link)
// ============================================================
const ResetPassword = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth">
      <div className="fm-auth-head">
        <div className="fm-auth-title">Pick a new password.</div>
        <div className="fm-auth-sub">
          Make it something you'll remember — at least 8 characters.
        </div>
      </div>

      <div className="fm-auth-form">
        <AuthField
          label="New password"
          value="thursdaymornings"
          secret
          focused
          strength="Strong"
          trailing={
            <button className="fm-auth-field-eye" aria-label="Show password">
              <Icon name="eye" size={18} />
            </button>
          }
        />
        <AuthField
          label="Confirm new password"
          value="thursdaymornings"
          secret
          trailing={
            <button className="fm-auth-field-eye" aria-label="Show password">
              <Icon name="eye" size={18} />
            </button>
          }
        />
      </div>

      <div className="fm-reset-rules">
        <div className="fm-reset-rule met">
          <span className="ic"><Icon name="check" size={11} strokeWidth={2.6} /></span>
          At least 8 characters
        </div>
        <div className="fm-reset-rule met">
          <span className="ic"><Icon name="check" size={11} strokeWidth={2.6} /></span>
          Mix of letters and numbers or symbols
        </div>
        <div className="fm-reset-rule met">
          <span className="ic"><Icon name="check" size={11} strokeWidth={2.6} /></span>
          Passwords match
        </div>
      </div>

      <button className="fm-auth-cta primary" style={{ marginTop: 12 }}>Set new password</button>

      <div className="fm-auth-foot">
        Changed your mind? <a>Cancel</a>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 13d. PASSWORD RESET SUCCESS
// ============================================================
const PasswordResetDone = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth fm-reset-done">
      <div className="fm-reset-done-stack">
        <div className="fm-reset-done-illo">
          <Icon name="check" size={36} strokeWidth={2.4} />
          <span className="fm-reset-done-illo-ring" />
        </div>
        <div className="fm-reset-done-title">All set</div>
        <div className="fm-reset-done-sub">
          Password updated. We've signed you in on this device.
        </div>

        <div className="fm-reset-done-card">
          <div className="fm-reset-done-card-row">
            <span className="lbl">Account</span>
            <span className="val">cwsbrian@gmail.com</span>
          </div>
          <div className="fm-reset-done-card-row">
            <span className="lbl">Signed in</span>
            <span className="val">Just now · iPhone</span>
          </div>
        </div>

        <div className="fm-reset-done-tip">
          <Icon name="lock" size={12} strokeWidth={1.8} />
          <span>If this wasn't you, <a>sign out everywhere</a> right away.</span>
        </div>
      </div>

      <button className="fm-auth-cta primary" style={{ marginTop: 22, width: '100%' }}>Continue to Fina</button>
    </div>
  </Phone>
);

// ============================================================
// 13b. PROFILE EDIT — drilled in from Settings
// ============================================================
const ProfileEdit = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth" style={{ paddingTop: 102 }}>
      <div className="fm-nav-bar">
        <button className="fm-nav-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>
        <span className="fm-nav-title">Edit profile</span>
        <span className="fm-nav-spacer" />
      </div>
      <button className="fm-auth-action">Save</button>

      <div className="fm-profile-tile">
        <div className="fm-profile-tile-avatar">
          B
          <span className="fm-profile-tile-cam">
            <Icon name="camera" size={14} strokeWidth={1.8} />
          </span>
        </div>
        <button className="fm-profile-tile-link">Change photo</button>
      </div>

      <div className="fm-auth-form">
        <AuthField label="Display name" value="Brian Choi" focused />
        <AuthField
          label="Email"
          value="cwsbrian@gmail.com"
          filled
          trailing={
            <span className="fm-auth-field-trail-icon">
              <Icon name="lock" size={16} strokeWidth={1.8} />
            </span>
          }
        />
      </div>

      <div className="fm-auth-helper-text">
        Email changes require verification. <a style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Contact support</a> to update yours.
      </div>
    </div>
  </Phone>
);

// ============================================================
// 13c. DELETE ACCOUNT — drilled in from Settings → Account
// ============================================================
const DeleteAccount = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth" style={{ paddingTop: 102 }}>
      <div className="fm-nav-bar">
        <button className="fm-nav-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>
        <span className="fm-nav-title">Delete account</span>
        <span className="fm-nav-spacer" />
      </div>

      <div className="fm-auth-head" style={{ marginTop: 0 }}>
        <div className="fm-auth-danger-illo">
          <Icon name="alert" size={28} strokeWidth={1.6} />
        </div>
        <div className="fm-auth-sub">
          This is permanent. Once you confirm, we cannot recover your data.
        </div>
      </div>

      <ul className="fm-danger-list">
        <li>All transactions, categories, and budgets — across every workspace you own.</li>
        <li>Plaid connections + cached balances (your bank&apos;s data is untouched).</li>
        <li>Chat history with Fina and any saved plans or schedules.</li>
        <li>Workspace memberships — co-owners will be notified.</li>
      </ul>

      <div className="fm-auth-form" style={{ marginTop: 22 }}>
        <AuthField label="Type your email to confirm" value="cwsbrian@g" focused />
      </div>

      <div style={{ flex: 1 }} />

      <button className="fm-auth-cta danger" disabled>
        Delete account
      </button>
      <button className="fm-auth-cancel">Cancel</button>
    </div>
  </Phone>
);

// ============================================================
// 14. ADD TRANSACTION — Unified single-form (hero amount + rows + keypad sheet)
// ============================================================
const Keypad = ({ activeKey }) => {
  const keys = [
    '1', '2', '3',
    '4', '5', '6',
    '7', '8', '9',
    '.', '0', 'del',
  ];
  return (
    <div className="fm-keypad">
      {keys.map((k) => {
        if (k === 'del') {
          return (
            <button key={k} className="fm-key del" aria-label="Delete">
              <Icon name="backspace" size={22} strokeWidth={1.6} />
            </button>
          );
        }
        if (k === '.') {
          return <button key={k} className="fm-key aux">.</button>;
        }
        return (
          <button
            key={k}
            className="fm-key"
            style={activeKey === k ? { background: 'var(--color-surface-strong)' } : {}}
          >
            {k}
          </button>
        );
      })}
    </div>
  );
};

const AddTransaction = ({
  dark,
  kind = 'expense',
  mode = 'amount',          // 'amount' (keypad up) | 'detail' (keypad down, save CTA visible)
  amount = '24',
  cents = '00',
  empty = false,
  merchant = "Joe's Pizza",
  date = 'Today, May 12',
  account = 'Cash',
  note = 'Friday team lunch',
  focusedField = null,      // 'note' etc. — only honored when mode='detail'
}) => {
  const isIncome = kind === 'income';
  const isAmountMode = mode === 'amount';
  const showPlaceholder = empty;
  const category = isIncome ? 'Income' : 'Coffee & dining';

  const Row = ({ icon, label, value, placeholder = false }) => (
    <div className="fm-detail-row">
      <div className="ic"><Icon name={icon} size={16} /></div>
      <div className="lbl">{label}</div>
      <div className={`val${placeholder ? ' placeholder' : ''}`}>
        {value}
        <span className="chev"><Icon name="chevRight" size={16} /></span>
      </div>
    </div>
  );

  return (
    <Phone dark={dark}>
      <div className="fm-add-tx">
        <div className="fm-add-tx-bar">
          <button>Cancel</button>
          <div className="fm-add-tx-title">New transaction</div>
          <button className={`save${showPlaceholder ? ' disabled' : ''}`}>Save</button>
        </div>

        <div className="fm-add-tx-body" style={{ paddingBottom: isAmountMode ? 320 : 0 }}>
          {isAmountMode ? (
            <>
              <div className="fm-seg">
                <div className={`fm-seg-opt${!isIncome ? ' active' : ''}`}>Expense</div>
                <div className={`fm-seg-opt income${isIncome ? ' active' : ''}`}>Income</div>
              </div>

              <div className="fm-amt-hero">
                <div className="fm-amt-row">
                  <span className="sign">{isIncome ? '+' : '−'}</span>
                  <span className="currency">$</span>
                  {showPlaceholder ? (
                    <>
                      <span className="whole placeholder">0</span>
                      <span className="fm-amt-caret" />
                    </>
                  ) : (
                    <>
                      <span className={`whole${isIncome ? ' income' : ''}`}>{amount}</span>
                      <span className="decimal">.{cents}</span>
                      <span className="fm-amt-caret" />
                    </>
                  )}
                </div>
                <div className="fm-amt-helper">
                  {showPlaceholder ? 'Enter amount' : isIncome ? 'Income · CAD' : 'Expense · CAD'}
                </div>
              </div>
            </>
          ) : (
            <div className="fm-add-tx-amount-recap">
              <span className={`v${isIncome ? ' income' : ''}`}>
                {isIncome ? '+' : '−'}${amount}.{cents}
              </span>
              <button className="edit">Edit</button>
            </div>
          )}

          <div className="fm-add-tx-rows">
            <div className="fm-detail-rows">
              <Row icon="store" label="Merchant" value={showPlaceholder ? 'Required' : merchant} placeholder={showPlaceholder} />
              <Row icon="calendar" label="Date" value={date} />
              <Row icon="tag" label="Category" value={showPlaceholder ? 'Choose' : category} placeholder={showPlaceholder} />
              <Row icon="bank" label="Account" value={account} />
              <div className={`fm-detail-row note-row${!isAmountMode && focusedField === 'note' ? ' focused' : ''}`}>
                <div className="note-lbl">Note (optional)</div>
                {!isAmountMode && focusedField === 'note' ? (
                  <div className="note-text">
                    {note}<span className="note-caret" />
                  </div>
                ) : (
                  <div className="note-text placeholder">{isAmountMode ? 'Add a memo' : note || 'Add a memo'}</div>
                )}
              </div>
            </div>
          </div>

        </div>

        {isAmountMode && (
          <div className="fm-add-tx-keypad-sheet">
            <div className="fm-amt-chips">
              <div className="fm-amt-chip">$5</div>
              <div className="fm-amt-chip">$10</div>
              <div className={`fm-amt-chip${!showPlaceholder && amount === '24' ? ' active' : ''}`}>$25</div>
              <div className="fm-amt-chip">$50</div>
              <div className="fm-amt-chip">$100</div>
            </div>
            <Keypad activeKey={showPlaceholder ? null : '4'} />
          </div>
        )}
      </div>
    </Phone>
  );
};

// ============================================================
// 15. CATEGORY PICKER — bottom sheet (drilled in from Transaction Detail · Change)
// ============================================================
const CAT_COLORS = {
  'Groceries':         { bg: 'rgba(31,140,68,0.12)',  fg: '#1f8c44' },
  'Coffee & dining':   { bg: 'rgba(217,113,67,0.16)', fg: '#c25a25' },
  'Transport':         { bg: 'rgba(125, 216, 184,0.12)', fg: '#5fc4a1' },
  'Bills & utilities': { bg: 'rgba(118,90,200,0.14)', fg: '#6a4dba' },
  'Entertainment':     { bg: 'rgba(220,82,116,0.14)', fg: '#c93c64' },
  'Health':            { bg: 'rgba(36,164,148,0.14)', fg: '#19957f' },
  'Household':         { bg: 'rgba(178,114,52,0.14)', fg: '#9f6420' },
  'Income':            { bg: 'rgba(15,124,58,0.14)',  fg: '#0f7c3a' },
  'Shopping':          { bg: 'rgba(206,84,166,0.14)', fg: '#b54590' },
  'Subscriptions':     { bg: 'rgba(86,104,228,0.14)', fg: '#3a4cd4' },
  'Travel':            { bg: 'rgba(38,159,196,0.14)', fg: '#1d8aab' },
};

const CategoryPicker = ({ dark, selected = 'Groceries', searchValue = '' }) => {
  const frequent = [
    { name: 'Groceries', glyph: 'cart', meta: '12 this month' },
    { name: 'Coffee & dining', glyph: 'coffee', meta: '8 this month' },
    { name: 'Transport', glyph: 'fuel', meta: '4 this month' },
    { name: 'Shopping', glyph: 'shopping', meta: '3 this month' },
  ];
  const all = [
    { name: 'Bills & utilities', glyph: 'bolt' },
    { name: 'Entertainment', glyph: 'film' },
    { name: 'Health', glyph: 'heart' },
    { name: 'Household', glyph: 'home' },
    { name: 'Income', glyph: 'trendUp' },
    { name: 'Subscriptions', glyph: 'tag' },
    { name: 'Travel', glyph: 'plane' },
  ];

  const Tile = ({ item }) => {
    const c = CAT_COLORS[item.name] || { bg: 'var(--color-surface-strong)', fg: 'var(--color-ink)' };
    const isSel = selected === item.name;
    return (
      <button className={`fm-cat-tile${isSel ? ' selected' : ''}`}>
        <span className="fm-cat-tile-glyph" style={{ background: c.bg, color: c.fg }}>
          <Icon name={item.glyph} size={20} strokeWidth={1.8} />
        </span>
        <span className="fm-cat-tile-name">{item.name}</span>
        <span className="fm-cat-tile-meta">{item.meta}</span>
        {isSel && (
          <span className="fm-cat-tile-check">
            <Icon name="check" size={13} strokeWidth={2.6} color="#fff" />
          </span>
        )}
      </button>
    );
  };

  const Row = ({ item }) => {
    const c = CAT_COLORS[item.name] || { bg: 'var(--color-surface-strong)', fg: 'var(--color-ink)' };
    const isSel = selected === item.name;
    return (
      <div className={`fm-cat-row${isSel ? ' selected' : ''}`}>
        <span className="glyph" style={{ background: c.bg, color: c.fg }}>
          <Icon name={item.glyph} size={16} strokeWidth={1.8} />
        </span>
        <span className="name">{item.name}</span>
        {isSel && (
          <span className="selected-mark">
            <Icon name="check" size={13} strokeWidth={2.6} color="#fff" />
          </span>
        )}
      </div>
    );
  };

  return (
    <Phone dark={dark}>
      {/* Faded transaction-detail backdrop */}
      <div className="fm-content" style={{ paddingBottom: 0, filter: 'blur(3px) brightness(0.86)' }}>
        <div style={{ padding: '20px 24px 28px' }}>
          <div className="fm-cat-glyph" style={{ width: 52, height: 52, marginBottom: 14 }}>
            <Icon name="cart" size={22} />
          </div>
          <div style={{ font: 'var(--type-title-md)', fontWeight: 600 }}>Costco Wholesale</div>
          <div style={{ font: '38px/1 var(--font-sans)', fontWeight: 500, letterSpacing: '-1.4px', marginTop: 8 }}>
            −$87.43
          </div>
        </div>
      </div>

      <div className="fm-cat-sheet-scrim">
        <div className="fm-cat-sheet">
          <div className="fm-cat-sheet-grabber" />
          <div className="fm-cat-sheet-head">
            <div className="fm-cat-sheet-title">Choose category</div>
          </div>

          <div className="fm-cat-search">
            <Icon name="search" size={16} color="var(--color-muted)" />
            {searchValue
              ? <span style={{ color: 'var(--color-ink)' }}>{searchValue}</span>
              : <span>Search categories</span>
            }
          </div>

          <div className="fm-cat-list">
            <div className="fm-cat-group-label">Frequent</div>
            <div className="fm-cat-grid">
              {frequent.map((item) => <Tile key={item.name} item={item} />)}
            </div>

            <div className="fm-cat-group-label">All categories</div>
            {all.map((item) => <Row key={item.name} item={item} />)}

            <div className="fm-cat-create">
              <span className="plus"><Icon name="plus" size={16} strokeWidth={2.2} /></span>
              <div className="body">
                <div className="top">Create new category</div>
                <div className="sub">Adds to your workspace for everyone.</div>
              </div>
              <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
            </div>
            <div style={{ height: 16 }} />
          </div>
        </div>
      </div>
    </Phone>
  );
};

// ============================================================
// 16. ACCOUNT DETAIL — drill-in from a bank account row
// ============================================================
const AccountDetail = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Bank detail</div>
      <div className="fm-nav-spacer" />
    </div>

    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div className="fm-acct-hero">
        <div className="fm-acct-hero-top">
          <div className="fm-bank-logo" style={{ background: '#0079c1', color: '#fff', width: 38, height: 38, fontSize: 13 }}>BMO</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="fm-acct-meta">BMO · Chequing</div>
            <div className="fm-acct-name">Everyday Chequing ··1234</div>
          </div>
        </div>

        <div className="fm-acct-balance">$4,128.50</div>
        <div className="fm-acct-sub">
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-up)', display: 'inline-block' }} />
          Synced 2 minutes ago
          <span className="dot" />
          <span style={{ color: 'var(--color-muted-soft)' }}>Available $4,128.50</span>
        </div>

        <div className="fm-acct-stats">
          <div className="fm-acct-stat">
            <div className="lbl">Money in</div>
            <div className="val up">+$2,840.00</div>
          </div>
          <div className="fm-acct-stat">
            <div className="lbl">Money out</div>
            <div className="val down">−$1,217.43</div>
          </div>
        </div>
      </div>

      <div className="fm-acct-section-head">
        <span className="lbl">Recent activity · May</span>
        <span className="link">See all</span>
      </div>

      <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="Today" />
      <TxRow icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="Today" />
      <TxRow icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="Yesterday" pending />
      <TxRow icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="Yesterday" />
      <TxRow icon="home" name="Payroll · Stripe Inc." cat="Income" amount="+$2,840.00" time="May 10" income />
      <TxRow icon="utensils" name="Joe's Pizza" cat="Coffee & dining" amount="−$28.50" time="May 10" />
      <TxRow icon="film" name="Netflix" cat="Subscriptions" amount="−$22.99" time="May 10" />

      <div className="fm-acct-see-all">See all 38 transactions</div>
      <div style={{ height: 8 }} />
    </div>
  </Phone>
);

// ============================================================
// 17. BANK RECONNECT — bottom sheet for ITEM_LOGIN_REQUIRED
// ============================================================
const BankReconnect = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar" style={{ filter: 'blur(3px) brightness(0.84)' }}>
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Banks</div>
      <div className="fm-nav-spacer" />
      <button className="fm-nav-back" aria-label="Add bank" style={{ marginRight: -4 }}>
        <Icon name="plus" size={20} strokeWidth={1.8} />
      </button>
    </div>
    {/* Faded Banks screen behind the sheet */}
    <div className="fm-content" style={{ paddingTop: 55, paddingBottom: 32, filter: 'blur(3px) brightness(0.84)' }}>
      <div className="fm-bank-error-banner">
        <span className="icon"><Icon name="alert" size={16} strokeWidth={1.8} /></span>
        <div className="body">
          <div className="title">TD Bank needs a sign-in</div>
          <div className="sub">We can't pull new transactions until you re-authorize.</div>
        </div>
      </div>
      <BankCard
        name="BMO"
        logo="BMO"
        logoBg="#0079c1"
        sync="Synced 2 minutes ago"
        accounts={[
          { name: 'Chequing', mask: '1234', balance: '$4,128.50' },
        ]}
      />
    </div>

    <div className="fm-reconnect-sheet-scrim">
      <div className="fm-reconnect-sheet">
        <div className="grabber" />
        <div className="fm-reconnect-illo">
          <span className="bank-mini">TD</span>
        </div>
        <div className="fm-reconnect-title">Sign back in to TD Bank</div>
        <div className="fm-reconnect-sub">
          TD asked us to verify it's really you. Sign in once and Fina will keep your accounts in sync.
        </div>

        <div className="fm-reconnect-meta">
          <span className="lbl">Last sync</span>
          <span className="val">3 days ago</span>
        </div>
        <div className="fm-reconnect-meta" style={{ marginTop: -8 }}>
          <span className="lbl">Missed transactions</span>
          <span className="val">7</span>
        </div>

        <button className="fm-reconnect-cta">Reconnect with Plaid</button>
        <button className="fm-reconnect-secondary">Not now</button>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 18. PLAID ERROR TOAST — already_connected / INSTITUTION_DOWN
// ============================================================
const PlaidErrorToast = ({ dark, variant = 'already' }) => {
  const copy = variant === 'down'
    ? { title: 'BMO is unavailable', sub: 'Their servers are taking a break. Try again in a few minutes.' }
    : { title: 'Already connected', sub: 'BMO is linked to this workspace. Open it from your bank list.' };

  return (
    <Phone dark={dark}>
      <div className="fm-nav-bar">
        <button className="fm-nav-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>
        <div className="fm-nav-title">Banks</div>
        <div className="fm-nav-spacer" />
        <button className="fm-nav-back" aria-label="Add bank" style={{ marginRight: -4 }}>
          <Icon name="plus" size={20} strokeWidth={1.8} />
        </button>
      </div>
      <div className="fm-content" style={{ paddingTop: 55, paddingBottom: 32 }}>
        <BankCard
          name="BMO"
          logo="BMO"
          logoBg="#0079c1"
          sync="Synced 2 minutes ago"
          accounts={[
            { name: 'Chequing', mask: '1234', balance: '$4,128.50' },
            { name: 'Savings', mask: '5678', balance: '$12,890.00' },
          ]}
        />
        <BankCard
          name="TD Bank"
          logo="TD"
          logoBg="#1c8c44"
          sync="Reconnection required"
          error
          accounts={[
            { name: 'Credit Card', mask: '0042', balance: '−$487.20' },
          ]}
        />
        <button className="fm-add-bank">
          <span className="fm-add-bank-tile">
            <Icon name="plus" size={18} strokeWidth={2.2} />
          </span>
          <span className="fm-add-bank-body">
            <span className="fm-add-bank-title">Connect another bank</span>
            <span className="fm-add-bank-sub">Plaid · 12,000+ banks worldwide</span>
          </span>
          <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
        </button>
      </div>

      <div className="fm-plaid-toast">
        <span className="ic"><Icon name="alert" size={16} strokeWidth={2} color="var(--color-down)" /></span>
        <div className="body">
          <div className="title">{copy.title}</div>
          <div className="sub">{copy.sub}</div>
        </div>
        <button className="dismiss" aria-label="Dismiss">
          <Icon name="x" size={16} strokeWidth={1.8} />
        </button>
      </div>
    </Phone>
  );
};

// ============================================================
// 19. WORKSPACE SETTINGS — drilled in from Settings → "Choi family"
// ============================================================
const MemberRow = ({ avatar, avatarBg, name, email, role, you, pending, pendingMeta }) => (
  <div className={`fm-member-row${pending ? ' pending' : ''}`}>
    <span
      className={`fm-member-avatar${pending ? ' pending' : ''}`}
      style={!pending ? { background: avatarBg } : undefined}
    >
      {pending ? <Icon name="mail" size={16} strokeWidth={1.8} /> : avatar}
    </span>
    <div className="fm-member-body">
      <div className="fm-member-name">
        {pending ? email : name}
        {you && <span className="you">You</span>}
      </div>
      {!pending && <div className="fm-member-mail">{email}</div>}
      {pending && <div className="fm-member-mail">{pendingMeta}</div>}
    </div>
    <span className={`fm-role-pill ${role === 'OWNER' ? 'owner' : ''} ${pending ? 'pending' : ''}`}>
      {pending ? 'PENDING' : role}
    </span>
  </div>
);

const WorkspaceSettings = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-auth" style={{ padding: '102px 0 0' }}>
      <div className="fm-nav-bar">
        <button className="fm-nav-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>
        <span className="fm-nav-title">Workspace</span>
        <span className="fm-nav-spacer" />
      </div>

      <div className="fm-ws-hero">
        <span className="fm-ws-hero-mark">C</span>
        <div className="fm-ws-hero-body">
          <div className="fm-ws-hero-name">Choi family</div>
          <div className="fm-ws-hero-meta">
            <span>2 members</span>
            <span className="dot" />
            <span>1 pending</span>
            <span className="dot" />
            <span>USD</span>
          </div>
        </div>
      </div>

      <div className="fm-settings-group-label">Workspace</div>
      <div className="fm-settings-group">
        <SettingsRow label="Name" detail="Choi family" />
        <SettingsRow label="Currency" detail="USD · $" />
      </div>

      <div className="fm-ws-section-head" style={{ marginTop: 22 }}>
        <span className="lbl">Members</span>
        <button className="action">
          <Icon name="plus" size={14} strokeWidth={2.2} />
          Invite
        </button>
      </div>
      <div className="fm-settings-group">
        <MemberRow
          avatar="B"
          avatarBg="var(--color-ink)"
          name="Brian Choi"
          email="cwsbrian@gmail.com"
          role="OWNER"
          you
        />
        <MemberRow
          avatar="J"
          avatarBg="#cd6c50"
          name="Joelle Lee"
          email="joelle.lee@gmail.com"
          role="EDITOR"
        />
        <MemberRow
          email="sangju@gmail.com"
          pending
          pendingMeta="Invited 2 days ago · Editor"
        />
      </div>

      <button className="fm-ws-danger-link" style={{ color: 'var(--color-muted)' }}>
        Transfer ownership
      </button>
      <button className="fm-ws-danger-link">
        Delete workspace
      </button>
    </div>
  </Phone>
);

// ============================================================
// 19b. MEMBER INVITE — bottom sheet over WorkspaceSettings
// ============================================================
const MemberInvite = ({ dark }) => (
  <Phone dark={dark}>
    {/* Faded WorkspaceSettings behind the sheet */}
    <div style={{ filter: 'blur(3px) brightness(0.84)', height: '100%' }}>
      <WorkspaceSettings dark={dark} />
    </div>

    <div className="fm-ws-sheet-scrim">
      <div className="fm-ws-sheet" style={{ paddingBottom: 28 }}>
        <div className="grabber" />

        <div className="fm-invite-sheet-head">
          <div className="body">
            <div className="title">Invite to Choi family</div>
            <div className="sub">
              Add a family member or roommate. They'll see your transactions and budgets — Fina is free for them.
            </div>
          </div>
        </div>

        <div className="fm-invite-sheet-body">
          <AuthField
            label="Email"
            value="sangju@gmail.com"
            focused
            trailing={
              <span className="fm-auth-field-trail-icon">
                <Icon name="mail" size={16} strokeWidth={1.8} />
              </span>
            }
          />

          <div className="fm-ws-section-head" style={{ marginTop: 22, padding: 0 }}>
            <span className="lbl">Role</span>
          </div>
          <div className="fm-role-choice" style={{ padding: 0, marginTop: 10 }}>
            <div className="fm-role-card selected">
              <span className="fm-role-card-check">
                <Icon name="check" size={12} strokeWidth={2.6} />
              </span>
              <div className="fm-role-card-name">Editor</div>
              <div className="fm-role-card-sub">
                Can categorize, edit budgets, add transactions.
              </div>
            </div>
            <div className="fm-role-card">
              <div className="fm-role-card-name">Viewer</div>
              <div className="fm-role-card-sub">
                Read-only — sees the numbers, doesn't change them.
              </div>
            </div>
          </div>

          <div className="fm-invite-helper" style={{ marginTop: 18 }}>
            <span className="ic"><Icon name="mail" size={12} strokeWidth={1.8} /></span>
            <div>
              We'll email a magic-link invite. They join automatically after signing up — no payment needed.
            </div>
          </div>
        </div>

        <button className="fm-invite-sheet-cta">Send invite</button>
      </div>
    </div>
  </Phone>
);

// ============================================================
// 19c. WORKSPACE SWITCHER — bottom sheet
// ============================================================
const WorkspaceSwitcher = ({ dark }) => (
  <Phone dark={dark}>
    {/* Faded Settings behind the sheet */}
    <div style={{ filter: 'blur(3px) brightness(0.84)', height: '100%' }}>
      <Settings dark={dark} tier="pro" />
    </div>

    <div className="fm-ws-sheet-scrim">
      <div className="fm-ws-sheet">
        <div className="grabber" />
        <div className="fm-ws-sheet-title">Switch workspace</div>

        <button className="fm-ws-row">
          <span className="mark" style={{ background: 'var(--color-ink)' }}>C</span>
          <div className="body">
            <div className="name">Choi family</div>
            <div className="meta">Owner · 2 members</div>
          </div>
          <span className="check"><Icon name="check" size={12} strokeWidth={2.6} /></span>
        </button>

        <button className="fm-ws-row">
          <span className="mark" style={{ background: 'var(--color-primary)' }}>B</span>
          <div className="body">
            <div className="name">Brian solo</div>
            <div className="meta">Owner · just you</div>
          </div>
        </button>

        <button className="fm-ws-row">
          <span className="mark" style={{ background: '#cd6c50' }}>W</span>
          <div className="body">
            <div className="name">Wong family</div>
            <div className="meta">Editor · 4 members</div>
          </div>
        </button>

        <div className="fm-ws-create">
          <span className="plus"><Icon name="plus" size={18} strokeWidth={2.2} /></span>
          <div className="body">
            <div className="top">Create new workspace</div>
            <div className="sub">For a new project, business, or another household.</div>
          </div>
        </div>
      </div>
    </div>
  </Phone>
);

// ============================================================
// SUBSCRIPTION MANAGE — drill-in from Settings · 4 state variants
// state: 'trial-active' (default) | 'trial-expiring' | 'trial-expired' | 'pro-active'
// ============================================================

const PricingFeature = ({ on = true, children }) => (
  <li className={on ? '' : 'off'}>
    <span className={`fm-pricing-icon ${on ? 'on' : 'off'}`}>
      <Icon name={on ? 'check' : 'x'} size={14} strokeWidth={2.2} />
    </span>
    <span>{children}</span>
  </li>
);

const SubscriptionManage = ({ dark, state = 'trial-active' }) => {
  const isTrial   = state === 'trial-active' || state === 'trial-expiring';
  const isExpired = state === 'trial-expired';
  const isPro     = state === 'pro-active';

  let pillVariant = 'trial';
  let pillLabel   = 'Pro Trial';
  let heroTitle   = 'Pro Trial';
  let heroSub     = 'Full Fina — chat, unlimited banks, AI brief.';
  let heroRowL    = 'Trial ends';
  let heroRowR    = 'Jun 12, 2026';
  let heroGlyph   = 'sparkle';
  let heroGlyphClass = '';

  if (state === 'trial-expiring') {
    pillVariant = 'expiring'; pillLabel = '3 days left';
    heroSub = 'Your trial ends Sunday. Pick a plan to keep your AI features.';
  }
  if (state === 'trial-expired') {
    pillVariant = 'expired'; pillLabel = 'Expired';
    heroTitle = 'Trial ended';
    heroSub = 'Plaid sync, AI brief, and chat are paused until you pick a plan.';
    heroRowL = 'Expired';
    heroRowR = 'May 12, 2026';
    heroGlyph = 'lock'; heroGlyphClass = 'expired';
  }
  if (state === 'pro-active') {
    pillVariant = 'active'; pillLabel = 'Active';
    heroTitle = 'Pro';
    heroSub = 'Auto-renews via App Store. Cancel anytime.';
    heroRowL = 'Renews';
    heroRowR = 'Aug 14, 2026 · $15';
    heroGlyphClass = 'active';
  }

  return (
    <Phone dark={dark}>
      <div className="fm-auth" style={{ padding: '102px 0 0', overflowY: 'auto' }}>
        <div className="fm-nav-bar">
          <button className="fm-nav-back" aria-label="Back">
            <Icon name="chevLeft" size={22} strokeWidth={1.8} />
          </button>
          <span className="fm-nav-title">Subscription</span>
          <span className="fm-nav-spacer" />
        </div>

        {state === 'trial-expiring' && (
          <div className="fm-trial-banner danger">
            <span className="fm-trial-banner-glyph">
              <Icon name="alert" size={16} strokeWidth={1.8} />
            </span>
            <div className="fm-trial-banner-body">
              <div className="fm-trial-banner-title">Trial ends in 3 days</div>
              <div className="fm-trial-banner-sub">After Sunday, your AI brief and Plaid sync will pause until you subscribe.</div>
            </div>
          </div>
        )}

        {/* Current plan hero */}
        <div className={`fm-sub-hero${isExpired ? ' expired' : ''}`}>
          <div className="fm-sub-hero-top">
            <span className={`fm-sub-hero-glyph ${heroGlyphClass}`}>
              <Icon name={heroGlyph} size={20} strokeWidth={1.8} />
            </span>
            <div className="fm-sub-hero-body">
              <div className="fm-sub-hero-title">
                {heroTitle}
                <span className={`fm-sub-status-pill ${pillVariant}`}>{pillLabel}</span>
              </div>
              <div className="fm-sub-hero-sub">{heroSub}</div>
            </div>
          </div>
          <div className="fm-sub-hero-row">
            <span className="label">{heroRowL}</span>
            <span className="value">{heroRowR}</span>
          </div>
        </div>

        {/* Plans */}
        <div className="fm-sub-group-label">{isPro ? 'Change plan' : 'Choose a plan'}</div>
        <div className="fm-pricing-stack">

          {/* Free */}
          <div className={`fm-pricing-card ${(!isPro && !isTrial && !isExpired) ? 'current' : 'dimmed'}`}>
            <div className="fm-pricing-card-head">
              <div className="fm-pricing-name">Free</div>
              <div className="fm-pricing-price">$0<span className="per">/mo</span></div>
            </div>
            <ul className="fm-pricing-features">
              <PricingFeature on>Manual transactions & budgets</PricingFeature>
              <PricingFeature on>Workspace sharing</PricingFeature>
              <PricingFeature off>Plaid bank sync</PricingFeature>
              <PricingFeature off>AI chat & morning brief</PricingFeature>
            </ul>
            <button className="fm-pricing-cta muted" disabled>
              {isPro || isTrial ? 'Downgrade — keeps data' : 'Current plan'}
            </button>
          </div>

          {/* Lite */}
          <div className="fm-pricing-card">
            <div className="fm-pricing-card-head">
              <div className="fm-pricing-name">Lite</div>
              <div className="fm-pricing-price">$7<span className="per">/mo</span></div>
            </div>
            <ul className="fm-pricing-features">
              <PricingFeature on>Connect 1 bank via Plaid</PricingFeature>
              <PricingFeature on>AI categorization suggestions</PricingFeature>
              <PricingFeature on>Read-only morning brief</PricingFeature>
              <PricingFeature off>Chat with Fina</PricingFeature>
            </ul>
            <button className="fm-pricing-cta">Switch to Lite</button>
          </div>

          {/* Pro */}
          <div className={`fm-pricing-card ${isPro ? 'current' : 'featured'}`}>
            <div className="fm-pricing-card-head">
              <div className="fm-pricing-name">
                Pro
                {!isPro && <span className="fm-pricing-flag">Recommended</span>}
                {isPro  && <span className="fm-pricing-flag" style={{ background: 'var(--color-up)' }}>Current</span>}
              </div>
              <div className="fm-pricing-price">$15<span className="per">/mo</span></div>
            </div>
            <ul className="fm-pricing-features">
              <PricingFeature on>Unlimited bank connections</PricingFeature>
              <PricingFeature on>Full chat with Fina — plan & ask</PricingFeature>
              <PricingFeature on>Personalized AI morning brief</PricingFeature>
              <PricingFeature on>Schedule, budget, anomaly alerts</PricingFeature>
            </ul>
            {isPro
              ? <button className="fm-pricing-cta muted" disabled>Current plan</button>
              : <button className={`fm-pricing-cta ${state === 'trial-expiring' || isExpired ? 'primary' : 'ink'}`}>
                  {isExpired ? 'Subscribe to Pro' : isTrial ? 'Continue on Pro' : 'Start Pro'}
                </button>}
          </div>
        </div>

        {/* Footer meta */}
        <div className="fm-sub-meta">
          <div className="row">
            <span className="label">Billed through</span>
            <span className="source">
              <Icon name="store" size={14} strokeWidth={1.8} />
              App Store
            </span>
          </div>
          {isPro && (
            <a href="#" style={{ padding: '4px 2px' }}>Manage in App Store <Icon name="arrowUpRight" size={12} strokeWidth={2} style={{ verticalAlign: '-1px', marginLeft: 2 }} /></a>
          )}
          <div style={{ padding: '0 2px' }}>
            Subscribed on the web? Sign in with the same email and your plan applies automatically.
          </div>
          <div style={{ height: 20 }} />
        </div>
      </div>
    </Phone>
  );
};

// ============================================================
// TRIAL EXPIRED LOCK MODAL — full-screen blocking modal
// Renders on top of the Chat screen as backdrop.
// ============================================================

const TrialExpiredLock = ({ dark }) => (
  <Phone dark={dark}>
    {/* Backdrop — paused chat */}
    <div style={{ filter: 'blur(4px) brightness(0.7)' }}>
      <ChatHeader title="Morning brief" dark={dark} />
      <div className="fm-content" style={{ paddingBottom: 0 }}>
        <div className="fm-chat-list" style={{ paddingTop: 12 }}>
          <Bubble role="ai">Morning, Brian — yesterday came to <strong>$214.83</strong>.</Bubble>
          <Bubble role="ai">Two need a category.</Bubble>
        </div>
      </div>
    </div>

    {/* Lock card */}
    <div className="fm-lock-scrim">
      <div className="fm-lock-card">
        <div className="fm-lock-illo">
          <Icon name="lock" size={28} strokeWidth={1.8} />
        </div>
        <div className="fm-lock-title">Your trial ended</div>
        <div className="fm-lock-sub">Your transactions are safe. Subscribe to keep AI features working.</div>

        <ul className="fm-lock-features">
          <li><span className="lock-icon"><Icon name="lock" size={14} strokeWidth={1.8} /></span> Plaid bank sync — paused</li>
          <li><span className="lock-icon"><Icon name="lock" size={14} strokeWidth={1.8} /></span> Morning brief — paused</li>
          <li><span className="lock-icon"><Icon name="lock" size={14} strokeWidth={1.8} /></span> Chat with Fina — paused</li>
        </ul>

        <div className="fm-lock-ctas">
          <button className="fm-lock-cta primary">Subscribe to Pro · $15/mo</button>
          <button className="fm-lock-cta secondary">Try Lite — $7/mo</button>
          <button className="fm-lock-cta subtle">Continue with Free</button>
        </div>
      </div>
    </div>
  </Phone>
);

// ============================================================
// Phase 2 — Reusable banner components
// ============================================================
const BudgetContextBanner = ({ spent = '$1,847', total = '$2,400', pct = 77, tone = 'default' }) => {
  const barClass = tone === 'danger' ? 'fm-context-bar-fill danger'
    : tone === 'warn' ? 'fm-context-bar-fill warn'
    : 'fm-context-bar-fill';
  return (
    <div className="fm-context-banner">
      <div className="fm-context-row">
        <span className="fm-context-label">May spent</span>
        <span className="fm-context-spent">{spent}</span>
        <span className="fm-context-of">of {total}</span>
        <span className="fm-context-pct">{pct}%</span>
      </div>
      <div className="fm-context-bar">
        <div className={barClass} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const BankErrorBanner = ({ bank = 'TD Bank', sub = 'Last sync 3 days ago — sign back in to keep syncing' }) => (
  <div className="fm-bank-banner">
    <div className="fm-bank-banner-icon">
      <Icon name="alert" size={18} strokeWidth={1.8} />
    </div>
    <div className="fm-bank-banner-body">
      <div className="fm-bank-banner-title">{bank} needs reconnecting</div>
      <div className="fm-bank-banner-sub">{sub}</div>
    </div>
    <button className="fm-bank-banner-cta">Reconnect</button>
  </div>
);

// ============================================================
// Phase 2 — Morning brief settings (drill-in)
// ============================================================
const MorningBriefSettings = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={26} strokeWidth={1.7} />
      </button>
      <span className="fm-nav-title">Morning brief</span>
      <span className="fm-nav-spacer" />
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div className="fm-brief-hero">
        <div className="fm-brief-hero-glyph">
          <Icon name="sun" size={26} strokeWidth={1.7} />
        </div>
        <div className="fm-brief-hero-body">
          <div className="fm-brief-hero-title">Daily morning brief</div>
          <div className="fm-brief-hero-sub">Fina sends one push each morning with yesterday's activity and what's coming.</div>
        </div>
      </div>

      <div className="fm-settings-group-label">Delivery</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row">
          <div className="fm-settings-row-body">
            <div className="fm-settings-row-title">Get the brief</div>
            <div className="fm-settings-row-sub">Push on days with new activity</div>
          </div>
          <div className="fm-toggle on" />
        </div>
        <div className="fm-settings-row">
          <div className="fm-settings-row-body">
            <div className="fm-settings-row-title">Delivery time</div>
            <div className="fm-settings-row-sub">Tap to change</div>
          </div>
          <div className="fm-row-detail">8:00 AM <Icon name="chevRight" size={16} strokeWidth={1.6} /></div>
        </div>
        <div className="fm-settings-row">
          <div className="fm-settings-row-body">
            <div className="fm-settings-row-title">Time zone</div>
            <div className="fm-settings-row-sub">Auto-detected</div>
          </div>
          <div className="fm-row-detail">America/Vancouver</div>
        </div>
      </div>

      <div className="fm-brief-time" style={{ marginTop: 18 }}>
        <span className="fm-brief-time-num">8</span>
        <span className="fm-brief-time-colon">:</span>
        <span className="fm-brief-time-num">00</span>
        <span className="fm-brief-time-meridian">AM</span>
      </div>

      <div className="fm-settings-group-label" style={{ marginTop: 22 }}>Pause</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row">
          <div className="fm-settings-row-body">
            <div className="fm-settings-row-title">Pause briefs</div>
            <div className="fm-settings-row-sub">Useful for vacations</div>
          </div>
          <div className="fm-row-detail">Off <Icon name="chevRight" size={16} strokeWidth={1.6} /></div>
        </div>
      </div>

      <button className="fm-brief-test">
        <Icon name="send" size={16} strokeWidth={1.7} />
        Send me one now
      </button>

      <div className="fm-brief-helper">
        Fina skips the brief on days with no new transactions.
      </div>
    </div>
  </Phone>
);

// ============================================================
// Phase 2 — Push permission pre-prompt
// ============================================================
const PushPermissionPrompt = ({ dark }) => (
  <Phone dark={dark}>
    <Header />
    <div className="fm-perm">
      <div className="fm-perm-illo">
        <Icon name="bell" size={36} strokeWidth={1.7} />
      </div>
      <div className="fm-perm-title">Hear from Fina each morning.</div>
      <div className="fm-perm-sub">
        Allow notifications so we can text you a quick summary. Usually 30 seconds to glance over.
      </div>

      <div className="fm-perm-stack">
        <div className="fm-perm-notif">
          <div className="fm-perm-notif-icon">F</div>
          <div className="fm-perm-notif-body">
            <div className="fm-perm-notif-head">
              <span className="fm-perm-notif-app">Fina</span>
              <span className="fm-perm-notif-time">now</span>
            </div>
            <div className="fm-perm-notif-text">Morning, Brian — yesterday came to $214.83. Two need a category.</div>
          </div>
        </div>
        <div className="fm-perm-notif muted">
          <div className="fm-perm-notif-icon">F</div>
          <div className="fm-perm-notif-body">
            <div className="fm-perm-notif-head">
              <span className="fm-perm-notif-app">Fina</span>
              <span className="fm-perm-notif-time">tomorrow, 8:00 AM</span>
            </div>
            <div className="fm-perm-notif-text">Heads-up: Netflix charges $22.99 today. Friends dinner Friday too.</div>
          </div>
        </div>
        <div className="fm-perm-notif muted-2">
          <div className="fm-perm-notif-icon">F</div>
          <div className="fm-perm-notif-body">
            <div className="fm-perm-notif-head">
              <span className="fm-perm-notif-app">Fina</span>
              <span className="fm-perm-notif-time">Sunday, 8:00 AM</span>
            </div>
            <div className="fm-perm-notif-text">Calmer week — $87 under your usual. Nice.</div>
          </div>
        </div>
      </div>

      <div className="fm-perm-actions">
        <button className="fm-perm-cta">Allow notifications</button>
        <button className="fm-perm-cta subtle">Maybe later</button>
      </div>
    </div>
  </Phone>
);

// ============================================================
// Phase 2 — Data export sheet (bottom sheet over Settings)
// ============================================================
const DataExportSheet = ({ dark }) => (
  <Phone dark={dark}>
    <div style={{ position: 'absolute', inset: 0, filter: 'blur(4px) brightness(0.9)' }}>
      <Settings dark={dark} tier="pro" />
    </div>
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(11,15,23,0.18)', zIndex: 4 }} />

    <div className="fm-export-sheet">
      <div className="fm-export-grabber" />
      <div className="fm-export-head">
        <div className="fm-export-title">Export your data</div>
        <div className="fm-export-sub">We'll prepare a file you can save or share. Everything in this workspace.</div>
      </div>

      <div className="fm-export-section">
        <div className="fm-export-section-label">Date range</div>
        <div className="fm-export-chips">
          <button className="fm-export-chip active">
            All time
            <span className="fm-export-chip-check"><Icon name="check" size={14} strokeWidth={2} /></span>
          </button>
          <button className="fm-export-chip">This month</button>
          <button className="fm-export-chip">Last 90 days</button>
          <button className="fm-export-chip">Custom…</button>
        </div>
      </div>

      <div className="fm-export-section">
        <div className="fm-export-section-label">Format</div>
        <div className="fm-export-format">
          <div className="fm-export-format-icon">CSV</div>
          <div className="fm-export-format-body">
            <div className="fm-export-format-title">CSV (comma-separated)</div>
            <div className="fm-export-format-sub">Opens in Excel, Numbers, Sheets.</div>
          </div>
        </div>
      </div>

      <div className="fm-export-section">
        <div className="fm-export-section-label">Included</div>
        <div className="fm-export-includes">
          <span className="fm-export-include-pill">Transactions</span>
          <span className="fm-export-include-pill">Categories</span>
          <span className="fm-export-include-pill">Budgets</span>
          <span className="fm-export-include-pill">Schedules</span>
        </div>
      </div>

      <button className="fm-export-cta">Export</button>
    </div>
  </Phone>
);

// ============================================================
// Phase 2 — Variant chat/tx screens with banners
// ============================================================
const ChatWithBudgetContext = ({ dark, tier = 'pro' }) => {
  const inputLocked = tier !== 'pro';
  return (
    <Phone dark={dark}>
      <ChatHeader title="Morning brief" dark={dark} />
      <div className="fm-content" style={{ paddingBottom: inputLocked ? 60 : 100 }}>
        <BudgetContextBanner spent="$1,847" total="$2,400" pct={77} tone="warn" />
        <div className="fm-chat-list" style={{ paddingTop: 12 }}>
          <div className="fm-chat-day">Today · 8:00 AM</div>
          <Bubble role="ai">
            Morning, Brian — yesterday came to <strong>$214.83</strong> across 5 transactions. Two need a category.
          </Bubble>

          <CategorizeCard
            merchant="Costco Wholesale"
            amount="$87.43"
            when="Yesterday, 9:12 PM"
            glyph="cart"
            suggestion="Groceries"
            layout="default"
            dark={dark}
          />

          <CategorizeCard
            merchant="Tim Hortons"
            amount="$6.50"
            when="Yesterday, 10:04 AM"
            glyph="coffee"
            suggestion="Coffee & dining"
            layout="default"
            dark={dark}
          />

          <Bubble role="ai">
            Pace check — you've used <strong>77%</strong> of May with 12 days left. Pretty close, not over.
          </Bubble>
        </div>
      </div>

      {!inputLocked && <InputBar />}
      {inputLocked && <InputBar locked lockMessage="Upgrade to chat with Fina" />}
    </Phone>
  );
};

const TransactionsWithBankError = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <BankErrorBanner bank="TD Bank" sub="Last sync 3 days ago — 7 transactions waiting" />

      <div className="fm-filter-bar">
        <span className="fm-filter-pill active">This month <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      <div className="fm-tx-day">
        <span>Today · May 12</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
      </div>
      <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
      <TxRow icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$146.03</span>
      </div>
      <TxRow icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="21:12" pending />
      <TxRow icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="16:38" />

      <div className="fm-tx-day">
        <span>May 10</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>+$2,840.00</span>
      </div>
      <TxRow icon="home" name="Payroll · Stripe Inc." cat="Income" amount="+$2,840.00" time="09:00" income />

      <div style={{ height: 24 }} />
    </div>

    <TabBar active="tx" />
  </Phone>
);

// ============================================================
// Phase 2 — Chat thread list (spec §3.1 — Conversations index)
// Reached as the Chat tab landing screen once threads > 1.
// ============================================================
const ChatThreadList = ({ dark, tier = 'pro' }) => {
  const Thread = ({ kind = 'brief', unread = 0, title, preview, time, you = false, muted = false }) => {    const glyph = kind === 'brief' ? 'sparkle'
      : kind === 'plan' ? 'trendUp'
      : kind === 'schedule' ? 'calendar'
      : kind === 'budget' ? 'tag'
      : 'chat';
    return (
      <button className={`fm-thread-row${muted ? ' muted' : ''}${unread > 0 ? ' unread' : ''}`}>
        <span className={`fm-thread-avatar k-${kind}`}>
          {you ? 'B' : <Icon name={glyph} size={15} strokeWidth={1.8} />}
        </span>
        <div className="fm-thread-body">
          <div className="fm-thread-top">
            <span className="fm-thread-title">{title}</span>
            <span className="fm-thread-time">{time}</span>
          </div>
          <div className="fm-thread-preview">
            {you && <span className="fm-thread-you">You · </span>}
            {preview}
          </div>
        </div>
        {unread > 0 && <span className="fm-thread-unread">{unread}</span>}
      </button>
    );
  };

  return (
    <Phone dark={dark}>
      <ChatHistoryHeader title="Chats" dark={dark} noBorder />
      <div className="fm-content" style={{ paddingBottom: 24 }}>
        <div className="fm-thread-group-label" style={{ paddingTop: 4 }}>Today</div>
        <div className="fm-thread-group">
          <Thread
            kind="brief"
            unread={2}
            title="Morning brief"
            preview="Yesterday came to $214.83. Two need a category."
            time="8:00 AM"
          />
        </div>

        <div className="fm-thread-group-label">This week</div>
        <div className="fm-thread-group">
          <Thread
            kind="brief"
            title="Morning brief · Monday"
            preview="All caught up ✓ See you tomorrow."
            time="Yesterday"
          />
          <Thread
            kind="plan"
            title="Japan trip · plan"
            preview="Can we afford Japan in November?"
            time="Sun"
            you
          />
          <Thread
            kind="brief"
            title="Morning brief · Saturday"
            preview="Quiet day — $32 spent. Nothing to sort."
            time="Sat"
          />
          <Thread
            kind="budget"
            title="Coffee & dining · over budget"
            preview="You went $62 over. Want to nudge the cap?"
            time="Fri"
          />
        </div>

        <div className="fm-thread-group-label">Earlier</div>
        <div className="fm-thread-group">
          <Thread
            kind="schedule"
            title="Rent scheduled"
            preview="Acme Properties — $1,800 on the 1st of every month."
            time="May 1"
            muted
          />
          <Thread
            kind="brief"
            title="Morning brief · April 30"
            preview="April closed at $2,318. $382 under budget."
            time="Apr 30"
            muted
          />
        </div>

        <div style={{ height: 24 }} />
      </div>
    </Phone>
  );
};

// ============================================================
// Phase 2 — Lock-screen push notifications (spec §8.2)
// All four push types stacked on an iOS-style lock screen.
// ============================================================
const PushNotificationsLockScreen = () => {
  const Notif = ({ time, title, body, accent }) => (
    <div className="fm-lock-notif">
      <div className="fm-lock-notif-icon" style={accent ? { background: accent } : undefined}>F</div>
      <div className="fm-lock-notif-body">
        <div className="fm-lock-notif-head">
          <span className="fm-lock-notif-app">Fina</span>
          <span className="fm-lock-notif-time">{time}</span>
        </div>
        <div className="fm-lock-notif-title">{title}</div>
        <div className="fm-lock-notif-text">{body}</div>
      </div>
    </div>
  );

  return (
    <Phone dark>
      {/* Wallpaper — warm dusk gradient, off-brand intentionally for realism */}
      <div className="fm-lock-wall" />
      <div className="fm-lock-wall-tint" />

      {/* Lock affordance + date + time */}
      <div className="fm-lock-chrome">
        <span className="fm-lock-padlock">
          <Icon name="lock" size={16} strokeWidth={1.8} color="rgba(255,255,255,0.85)" />
        </span>
        <div className="fm-lock-date">Tuesday, May 12</div>
        <div className="fm-lock-time">8:01</div>
      </div>

      {/* Notification stack */}
      <div className="fm-lock-stack">
        <div className="fm-lock-stack-label">Notification Center</div>
        <Notif
          time="now"
          title="Morning brief ☀️"
          body="Yesterday came to $214.83. Two need a category — tap to sort in 30s."
        />
        <Notif
          time="2 min ago"
          title="Large charge spotted"
          body="Loblaws $342.18 is well above your usual run. Review?"
        />
        <Notif
          time="2h ago"
          title="BMO needs reconnecting"
          body="Last sync was 3 days ago. Sign in once to resume."
        />
        <Notif
          time="yesterday"
          title="Pro Trial · 3 days left"
          body="Keep your AI brief and Plaid sync — pick a plan in Settings."
        />
      </div>

      {/* Bottom home indicator */}
      <div className="fm-lock-indicator" />
    </Phone>
  );
};

// ============================================================
// Phase 2 — Home with trial-expiring banner (spec §7.2)
// In-app banner shown 5 days before trial ends, on top of Home.
// ============================================================
const HomeTrialExpiring = ({ dark }) => (
  <Phone dark={dark}>
    <Header
      title="Hi, Brian"
      subtitle="Tuesday, May 12"
      dark={dark}
      actions={<>
        <IconBtn icon="bell" dark={dark} />
        <IconBtn icon="more" dark={dark} />
      </>}
    />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-trial-banner danger" style={{ marginTop: 8 }}>
        <span className="fm-trial-banner-glyph">
          <Icon name="alert" size={16} strokeWidth={1.8} />
        </span>
        <div className="fm-trial-banner-body">
          <div className="fm-trial-banner-title">Pro Trial ends in 3 days</div>
          <div className="fm-trial-banner-sub">After Sunday your AI brief, Plaid sync, and chat will pause.</div>
        </div>
        <button className="fm-trial-banner-cta">Choose plan</button>
      </div>

      <div className="fm-hero">
        <div className="fm-stat-label">May spending</div>
        <div className="fm-hero-value">$1,847<span className="fm-hero-value-decimal">.20</span></div>
        <div className="fm-hero-meta">
          <span>of $2,700 budget</span>
          <span className="fm-hero-meta-dot" />
          <span style={{ color: 'var(--color-up)', fontWeight: 600 }}>$852.80 left</span>
        </div>
        <div className="fm-stat-bar" style={{ marginTop: 16 }}>
          <span style={{ width: '68%' }} />
        </div>
        <div className="fm-hero-axis">
          <span>May 1</span>
          <span>·</span>
          <span>12 days left</span>
          <span>·</span>
          <span>May 31</span>
        </div>
      </div>

      <div className="fm-brief-card">
        <div className="fm-brief-head">
          <div className="fm-brief-eyebrow">
            <span className="fm-brief-dot" />
            Fina · Morning brief
          </div>
          <div className="fm-brief-time">Just now</div>
        </div>
        <div className="fm-brief-body">
          <p>
            Yesterday came to <strong>$214.83</strong> across 5 transactions. Two need a category. Netflix bills tomorrow.
          </p>
        </div>
        <div className="fm-brief-foot">
          <span className="fm-brief-meta">2 to sort</span>
          <span className="fm-brief-cta">Open <Icon name="chevRight" size={14} strokeWidth={2} /></span>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="home" badges={{ tx: 2, home: 'dot' }} />
  </Phone>
);

// ============================================================
// Empty / first-run states
// ============================================================

// 1. Transactions — no transactions yet (Free, or just-installed Pro pre-sync)
const TransactionsEmpty = ({ dark, tier = 'free' }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />
    <div className="fm-content fm-empty centered" style={{ paddingBottom: 84 }}>
      <div className="fm-empty-illo neutral">
        <Icon name="receipt" size={36} strokeWidth={1.5} />
      </div>
      <div className="fm-empty-title">No transactions yet</div>
      <div className="fm-empty-sub">
        Add one manually, or connect a bank to pull them in automatically.
      </div>
      <div className="fm-empty-ctas">
        <button className="fm-empty-cta primary">
          <Icon name="plus" size={16} strokeWidth={2.2} color="#fff" />
          Add a transaction
        </button>
        <button className="fm-empty-cta secondary">
          <Icon name="bank" size={16} strokeWidth={1.8} />
          {tier === 'free' ? 'Connect bank · Lite' : 'Connect your first bank'}
        </button>
      </div>
    </div>
    <TabBar active="tx" />
  </Phone>
);

// 2. Banks — first connection
const BanksEmpty = ({ dark, tier = 'lite' }) => (
  <Phone dark={dark}>
    <Header title="Banks" dark={dark} />
    <div className="fm-content fm-empty centered" style={{ paddingBottom: 84 }}>
      <div className="fm-empty-illo blue">
        <Icon name="bank" size={36} strokeWidth={1.5} />
        <span className="fm-empty-illo-badge">
          <Icon name="plus" size={14} strokeWidth={2.6} />
        </span>
      </div>
      <div className="fm-empty-title">Connect your first bank</div>
      <div className="fm-empty-sub">
        {tier === 'free'
          ? 'Bank sync starts on Lite — $7/mo. Or keep tracking manually for free.'
          : 'We use Plaid to pull transactions and balances. Read-only — your credentials stay with your bank.'}
      </div>
      <div className="fm-empty-ctas">
        <button className="fm-empty-cta">
          <Icon name="plus" size={16} strokeWidth={2.2} color="#fff" />
          {tier === 'free' ? 'Upgrade to Lite' : 'Connect with Plaid'}
        </button>
        <button className="fm-empty-cta subtle">Maybe later</button>
      </div>
      <div className="fm-empty-trust">
        <Icon name="lock" size={12} strokeWidth={2} />
        Bank-grade encryption · <strong>Plaid</strong>
      </div>
    </div>
    <TabBar active="home" />
  </Phone>
);

// 3. Chats — first ritual not yet delivered
const ChatsEmpty = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHistoryHeader title="Chats" dark={dark} noBorder />
    <div className="fm-content fm-empty centered" style={{ paddingBottom: 24 }}>
      <div className="fm-empty-illo">
        <Icon name="sparkle" size={36} strokeWidth={1.5} />
      </div>
      <div className="fm-empty-title">Fina checks in each morning</div>
      <div className="fm-empty-sub">
        Tomorrow at 8:00 AM you'll get your first brief — yesterday's spending, things to sort, what's coming up.
      </div>
      <div className="fm-empty-ctas">
        <button className="fm-empty-cta">
          <Icon name="bell" size={16} strokeWidth={1.8} color="#fff" />
          Turn on notifications
        </button>
        <button className="fm-empty-cta secondary">
          <Icon name="clock" size={16} strokeWidth={1.8} />
          Change brief time
        </button>
        <button className="fm-empty-cta subtle">Or ask Fina anything now</button>
      </div>
    </div>
  </Phone>
);

// 4. Home — first-day, no spending data
const HomeEmpty = ({ dark }) => (
  <Phone dark={dark}>
    <Header
      title="Hi, Brian"
      subtitle="Tuesday, May 12"
      dark={dark}
      actions={<>
        <IconBtn icon="bell" dark={dark} />
        <IconBtn icon="more" dark={dark} />
      </>}
    />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-empty" style={{ padding: '16px 24px 28px' }}>
        <div className="fm-empty-illo up" style={{ width: 72, height: 72, borderRadius: 20, marginBottom: 16 }}>
          <Icon name="sun" size={32} strokeWidth={1.5} />
        </div>
        <div className="fm-empty-title" style={{ fontSize: 20, marginBottom: 6 }}>Let's set up your money</div>
        <div className="fm-empty-sub">
          Pick one to get started. Most people knock these out in under 2 minutes.
        </div>

        <div className="fm-empty-checklist">
          <button className="fm-empty-step done">
            <span className="fm-empty-step-glyph">
              <Icon name="check" size={18} strokeWidth={2.4} />
            </span>
            <span className="fm-empty-step-body">
              <span className="fm-empty-step-title">Create your workspace</span>
              <span className="fm-empty-step-sub">Choi family · USD</span>
            </span>
          </button>
          <button className="fm-empty-step">
            <span className="fm-empty-step-glyph">
              <Icon name="bank" size={18} strokeWidth={1.8} />
            </span>
            <span className="fm-empty-step-body">
              <span className="fm-empty-step-title">Connect a bank</span>
              <span className="fm-empty-step-sub">Pulls in transactions automatically.</span>
            </span>
            <span className="fm-empty-step-chev">
              <Icon name="chevRight" size={16} strokeWidth={1.7} />
            </span>
          </button>
          <button className="fm-empty-step">
            <span className="fm-empty-step-glyph">
              <Icon name="tag" size={18} strokeWidth={1.8} />
            </span>
            <span className="fm-empty-step-body">
              <span className="fm-empty-step-title">Set a monthly budget</span>
              <span className="fm-empty-step-sub">We'll suggest one once data lands.</span>
            </span>
            <span className="fm-empty-step-chev">
              <Icon name="chevRight" size={16} strokeWidth={1.7} />
            </span>
          </button>
          <button className="fm-empty-step">
            <span className="fm-empty-step-glyph">
              <Icon name="user" size={18} strokeWidth={1.8} />
            </span>
            <span className="fm-empty-step-body">
              <span className="fm-empty-step-title">Invite your partner</span>
              <span className="fm-empty-step-sub">Free forever — they share your view.</span>
            </span>
            <span className="fm-empty-step-chev">
              <Icon name="chevRight" size={16} strokeWidth={1.7} />
            </span>
          </button>
        </div>
      </div>
    </div>
    <TabBar active="home" />
  </Phone>
);

// 5. Analysis — not enough data
const AnalysisEmpty = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Analysis</div>
      <div className="fm-nav-spacer" />
      <button className="fm-chathead-btn" aria-label="More">
        <Icon name="more" size={20} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-content fm-empty centered" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div className="fm-empty-illo blue">
        <Icon name="chart" size={36} strokeWidth={1.5} />
      </div>
      <div className="fm-empty-title">Not enough data yet</div>
      <div className="fm-empty-sub">
        Charts unlock after a week of activity. Connect a bank to fast-track, or keep adding transactions manually.
      </div>

      <div className="fm-empty-skeleton">
        <div className="fm-empty-skel-row w-60" />
        <div className="fm-empty-skel-bars">
          <div className="fm-empty-skel-bar" style={{ height: '35%' }} />
          <div className="fm-empty-skel-bar" style={{ height: '60%' }} />
          <div className="fm-empty-skel-bar" style={{ height: '45%' }} />
          <div className="fm-empty-skel-bar" style={{ height: '80%' }} />
          <div className="fm-empty-skel-bar" style={{ height: '55%' }} />
          <div className="fm-empty-skel-bar" style={{ height: '70%' }} />
        </div>
        <div className="fm-empty-skel-row w-45" style={{ marginTop: 6 }} />
        <div className="fm-empty-skel-row w-80" />
      </div>

      <div className="fm-empty-ctas">
        <button className="fm-empty-cta">
          <Icon name="bank" size={16} strokeWidth={1.8} color="#fff" />
          Connect a bank
        </button>
      </div>
    </div>
  </Phone>
);


// ============================================================
// Phase 3 — Anomaly alerts
// (1) Chat — anomaly review screen, using AnomalyAlertBlock
// (2) Anomaly detail — focused drill-in from a push or flagged row
// (3) Activity · flagged — list of all flagged anomalies
// ============================================================

const ChatAnomaly = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Unusual charge" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-chat-list" style={{ paddingTop: 12 }}>
        <div className="fm-chat-day">Today · 8:02 AM</div>
        <Bubble role="ai">
          One thing from yesterday that's worth a beat — Loblaws charged you <strong>$342.18</strong>. That's a lot more than usual.
        </Bubble>

        <AnomalyAlertBlock
          merchant="Loblaws"
          when="Yesterday · 6:42 PM"
          amount="−$342.18"
          usual="$94.50"
          multiple="3.6× higher"
        />

        <Bubble role="ai" tag={false}>
          Could be a costco-style monthly stock-up. If so, no biggie. Or maybe a card got skimmed — your call.
        </Bubble>

        <QuickReplies options={['Looks right', 'Show me the receipt', 'It was a stock-up']} />
      </div>
    </div>
    <InputBar />
  </Phone>
);

// ────────────────────────────────────────────────
// Anomaly detail — focused review.
// Reached from the push notification "Large charge spotted" or by tapping a
// flagged-row in the Activity list. Drill-in style with chev-left back.
// ────────────────────────────────────────────────
const AnomalyDetail = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Unusual charge</div>
      <div className="fm-nav-spacer" />
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 96 }}>
      {/* Hero — red amount + merchant */}
      <div className="fm-anomaly-hero">
        <div className="fm-anomaly-pill">
          <Icon name="alert" size={12} strokeWidth={2.2} />
          Flagged · 3.6× your usual
        </div>
        <div className="fm-anomaly-amount">−$342.18</div>
        <div className="fm-anomaly-merchant">Loblaws</div>
        <div className="fm-anomaly-when">Yesterday · 6:42 PM · BMO Chequing ··1234</div>
      </div>

      {/* Why flagged — comparison strip */}
      <div className="fm-anomaly-compare">
        <div className="fm-anomaly-compare-head">
          <span>Your last 6 charges here</span>
          <span className="up">Avg $94.50</span>
        </div>
        <div className="fm-anomaly-bars">
          {[88, 92, 102, 89, 95, 342].map((v, i) => {
            const max = 342;
            const isCurrent = i === 5;
            return (
              <div key={i} className="fm-anomaly-bar">
                <div
                  className={`bar${isCurrent ? ' current' : ''}`}
                  style={{ height: `${(v / max) * 100}%` }}
                />
                <div className={`lbl${isCurrent ? ' current' : ''}`}>${v}</div>
              </div>
            );
          })}
        </div>
        <div className="fm-anomaly-bars-axis">
          <span>Apr 14</span>
          <span>Yesterday</span>
        </div>
      </div>

      {/* Context — what was different */}
      <div className="fm-settings-group-label">What changed</div>
      <div className="fm-settings-group">
        <div className="fm-anomaly-context-row">
          <span className="lbl">Time of day</span>
          <span className="val">6:42 PM (usually 11 AM–2 PM)</span>
        </div>
        <div className="fm-anomaly-context-row">
          <span className="lbl">Days since last visit</span>
          <span className="val">11 days (usually 6)</span>
        </div>
        <div className="fm-anomaly-context-row">
          <span className="lbl">Location</span>
          <span className="val">Same store · ··1234</span>
        </div>
      </div>

      {/* Suggested category (with override) */}
      <div className="fm-settings-group-label">Category</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row" style={{ padding: 16 }}>
          <div className="fm-cat-glyph" style={{ width: 34, height: 34 }}>
            <Icon name="cart" size={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Groceries</div>
            <div style={{ font: 'var(--type-caption)', color: 'var(--color-muted)', marginTop: 2 }}>
              AI guess · confirm to apply
            </div>
          </div>
          <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Change</span>
        </div>
      </div>
    </div>

    {/* Action bar — sticky bottom */}
    <div className="fm-anomaly-actionbar">
      <button className="fm-btn" style={{ flex: 1 }}>Mark unusual</button>
      <button className="fm-btn primary" style={{ flex: 1.4 }}>Looks right</button>
    </div>
  </Phone>
);

// ────────────────────────────────────────────────
// Activity · flagged anomalies (filtered list view)
// ────────────────────────────────────────────────
const TransactionsFlagged = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill">This month</span>
        <span className="fm-filter-pill">All accounts</span>
        <span className="fm-filter-pill active danger">
          <Icon name="alert" size={12} strokeWidth={2.2} /> Flagged · 3
        </span>
      </div>

      <div className="fm-anomaly-banner">
        <span className="fm-anomaly-banner-glyph">
          <Icon name="alert" size={16} strokeWidth={2} />
        </span>
        <div className="fm-anomaly-banner-body">
          <div className="fm-anomaly-banner-title">3 charges look unusual</div>
          <div className="fm-anomaly-banner-sub">Worth a quick review before they get auto-categorized.</div>
        </div>
      </div>

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$427.66</span>
      </div>
      <TxRowFlagged icon="cart" name="Loblaws" multiple="3.6× usual" cat="Groceries" amount="−$342.18" time="18:42" />
      <TxRowFlagged icon="fuel" name="Shell Gas Station" multiple="2.2× usual" cat="Transport" amount="−$85.48" time="07:14" />

      <div className="fm-tx-day">
        <span>May 9 (Sun)</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$214.20</span>
      </div>
      <TxRowFlagged icon="utensils" name="Sushi Yoshi" multiple="New merchant · $200+" cat={null} amount="−$214.20" time="20:14" />

      <div className="fm-tx-day" style={{ opacity: 0.6 }}>
        <span>Earlier · all clear</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>—</span>
      </div>

      <div style={{ height: 24 }} />
    </div>

    <TabBar active="tx" badges={{ tx: 'dot-red' }} />
  </Phone>
);

const TxRowFlagged = ({ icon, name, multiple, cat, amount, time }) => (
  <div className="fm-tx-row flagged">
    <div className="fm-cat-glyph down" style={{ width: 36, height: 36 }}>
      <Icon name={icon || 'alert'} size={16} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="fm-tx-name">
        {name}
        <span className="fm-tx-flag-pill">{multiple}</span>
      </div>
      <div className={`fm-tx-cat${!cat ? ' uncat' : ''}`}>{cat || 'Uncategorized'}</div>
    </div>
    <div className="fm-tx-amount">
      <div className="amt down">{amount}</div>
      <div className="time">{time}</div>
    </div>
  </div>
);


// ============================================================
// Phase 3 — Receipt OCR (Pro)
// Flow: Capture → Processing → Parsed (editable) → Saved
// Entered from Add Transaction or via chat ("send me a receipt")
// ============================================================

// (1) Camera viewfinder with framing guides
const ReceiptCapture = ({ dark }) => (
  <Phone dark>
    {/* Dark camera background */}
    <div className="fm-receipt-cam">
      {/* Top chrome — close + flash */}
      <div className="fm-receipt-cam-top">
        <button className="fm-receipt-cam-btn" aria-label="Close">
          <Icon name="x" size={22} strokeWidth={1.8} color="#fff" />
        </button>
        <div className="fm-receipt-cam-title">Capture receipt</div>
        <button className="fm-receipt-cam-btn" aria-label="Toggle flash">
          <Icon name="bolt" size={20} strokeWidth={1.7} color="#fff" />
        </button>
      </div>

      {/* Frame guides */}
      <div className="fm-receipt-frame">
        <div className="fm-receipt-frame-corner tl" />
        <div className="fm-receipt-frame-corner tr" />
        <div className="fm-receipt-frame-corner bl" />
        <div className="fm-receipt-frame-corner br" />

        {/* Simulated receipt preview inside the frame */}
        <div className="fm-receipt-paper">
          <div className="r-line r-store">WHOLE FOODS MARKET</div>
          <div className="r-line r-addr">3640 Westheimer · Houston TX</div>
          <div className="r-rule" />
          <div className="r-row"><span>Organic spinach</span><span>4.99</span></div>
          <div className="r-row"><span>Avocado x3</span><span>6.27</span></div>
          <div className="r-row"><span>Sourdough loaf</span><span>5.49</span></div>
          <div className="r-row"><span>Almond milk</span><span>4.99</span></div>
          <div className="r-row"><span>Free-range eggs</span><span>7.99</span></div>
          <div className="r-rule" />
          <div className="r-row"><span>Subtotal</span><span>29.73</span></div>
          <div className="r-row"><span>Tax</span><span>2.45</span></div>
          <div className="r-row r-total"><span>TOTAL</span><span>32.18</span></div>
          <div className="r-line r-foot">PAID VISA ··1234 · 18:42</div>
        </div>
      </div>

      {/* Hint */}
      <div className="fm-receipt-hint">
        Center the receipt — Fina reads it automatically
      </div>

      {/* Bottom controls */}
      <div className="fm-receipt-cam-bottom">
        <button className="fm-receipt-thumb" aria-label="From photos">
          <Icon name="receipt" size={18} strokeWidth={1.7} color="#fff" />
        </button>
        <button className="fm-receipt-shutter" aria-label="Capture">
          <span className="fm-receipt-shutter-inner" />
        </button>
        <div style={{ width: 44 }} />
      </div>
    </div>
  </Phone>
);

// (2) Processing — OCR running with extracted-so-far preview
const ReceiptProcessing = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Cancel">
        <Icon name="x" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Reading receipt</div>
      <div className="fm-nav-spacer" />
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      {/* Captured photo thumb */}
      <div className="fm-ocr-photo">
        <div className="fm-ocr-photo-stage">
          <div className="fm-receipt-paper" style={{ transform: 'rotate(-1deg)' }}>
            <div className="r-line r-store">WHOLE FOODS MARKET</div>
            <div className="r-line r-addr">3640 Westheimer · Houston TX</div>
            <div className="r-rule" />
            <div className="r-row"><span>Organic spinach</span><span>4.99</span></div>
            <div className="r-row"><span>Avocado x3</span><span>6.27</span></div>
            <div className="r-row"><span>Sourdough loaf</span><span>5.49</span></div>
            <div className="r-row r-dim"><span>Almond milk</span><span>4.99</span></div>
            <div className="r-row r-dim"><span>Free-range eggs</span><span>7.99</span></div>
            <div className="r-rule" />
            <div className="r-row r-dim"><span>Subtotal</span><span>29.73</span></div>
            <div className="r-row r-dim"><span>Tax</span><span>2.45</span></div>
            <div className="r-row r-total r-dim"><span>TOTAL</span><span>32.18</span></div>
          </div>
          <div className="fm-ocr-scanline" />
        </div>
      </div>

      <div className="fm-ocr-progress">
        <div className="fm-ocr-progress-bar"><span style={{ width: '62%' }} /></div>
        <div className="fm-ocr-progress-meta">
          <span>Extracting line items…</span>
          <span>5 of 8</span>
        </div>
      </div>

      <div className="fm-ocr-checks">
        <div className="fm-ocr-check done">
          <span className="ic"><Icon name="check" size={14} strokeWidth={2.6} /></span>
          <span>Merchant <strong>Whole Foods Market</strong></span>
        </div>
        <div className="fm-ocr-check done">
          <span className="ic"><Icon name="check" size={14} strokeWidth={2.6} /></span>
          <span>Total <strong>$32.18</strong></span>
        </div>
        <div className="fm-ocr-check done">
          <span className="ic"><Icon name="check" size={14} strokeWidth={2.6} /></span>
          <span>Date <strong>May 11 · 6:42 PM</strong></span>
        </div>
        <div className="fm-ocr-check pending">
          <span className="ic spin" />
          <span>Matching against your accounts…</span>
        </div>
      </div>
    </div>
  </Phone>
);

// (3) Parsed — editable form with extracted data + line items
const ReceiptParsed = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Confirm receipt</div>
      <div className="fm-nav-spacer" />
      <button className="fm-nav-save">Save</button>
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      {/* Header — small thumb + match status */}
      <div className="fm-ocr-summary">
        <div className="fm-ocr-summary-thumb">
          <Icon name="receipt" size={18} strokeWidth={1.7} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fm-ocr-summary-title">Receipt read · ready to save</div>
          <div className="fm-ocr-summary-sub">
            <span className="fm-ocr-match-pill">
              <Icon name="check" size={11} strokeWidth={2.6} /> Matched a pending charge
            </span>
          </div>
        </div>
      </div>

      {/* Editable fields */}
      <div className="fm-settings-group-label">Details</div>
      <div className="fm-settings-group">
        <div className="fm-detail-row">
          <div className="ic"><Icon name="store" size={16} /></div>
          <div className="lbl">Merchant</div>
          <div className="val">Whole Foods Market<span className="chev"><Icon name="chevRight" size={16} /></span></div>
        </div>
        <div className="fm-detail-row">
          <div className="ic"><Icon name="calendar" size={16} /></div>
          <div className="lbl">Date</div>
          <div className="val">May 11 · 6:42 PM<span className="chev"><Icon name="chevRight" size={16} /></span></div>
        </div>
        <div className="fm-detail-row">
          <div className="ic"><Icon name="bank" size={16} /></div>
          <div className="lbl">Account</div>
          <div className="val">BMO ··1234<span className="chev"><Icon name="chevRight" size={16} /></span></div>
        </div>
      </div>

      {/* Categories — split across multiple */}
      <div className="fm-settings-group-label">
        Categories
        <span style={{ float: 'right', color: 'var(--color-muted)', fontWeight: 500, letterSpacing: 0 }}>
          Split across 3
        </span>
      </div>
      <div className="fm-ocr-cat-strip">
        <div className="fm-ocr-cat-pill">
          <span className="dot" style={{ background: '#1f8c44' }} />
          <span className="name">Groceries</span>
          <span className="amt">$17.74</span>
        </div>
        <div className="fm-ocr-cat-pill">
          <span className="dot" style={{ background: '#c25a25' }} />
          <span className="name">Dining</span>
          <span className="amt">$7.99</span>
        </div>
        <div className="fm-ocr-cat-pill">
          <span className="dot" style={{ background: '#6a4dba' }} />
          <span className="name">Household</span>
          <span className="amt">$4.00</span>
        </div>
      </div>

      {/* Line items — grouped by category, each tappable to recategorize */}
      <div className="fm-settings-group-label">
        Line items
        <span style={{ float: 'right', color: 'var(--color-muted)', fontWeight: 500, letterSpacing: 0 }}>
          5 read · tap to change
        </span>
      </div>

      <div className="fm-settings-group" style={{ padding: 0 }}>
        {/* Groceries group */}
        <div className="fm-ocr-group-head">
          <span className="dot" style={{ background: '#1f8c44' }} />
          <span className="name">Groceries</span>
          <span className="meta">3 items · $17.74</span>
        </div>
        <div className="fm-ocr-item editable">
          <span className="name">Organic spinach</span>
          <span className="cat" style={{ color: '#1f8c44' }}>Groceries <Icon name="chevDown" size={11} strokeWidth={2.2} /></span>
          <span className="amt">$4.99</span>
        </div>
        <div className="fm-ocr-item editable">
          <span className="name">Avocado <span className="qty">×3</span></span>
          <span className="cat" style={{ color: '#1f8c44' }}>Groceries <Icon name="chevDown" size={11} strokeWidth={2.2} /></span>
          <span className="amt">$6.27</span>
        </div>
        <div className="fm-ocr-item editable">
          <span className="name">Almond milk</span>
          <span className="cat" style={{ color: '#1f8c44' }}>Groceries <Icon name="chevDown" size={11} strokeWidth={2.2} /></span>
          <span className="amt">$6.48</span>
        </div>

        {/* Dining group */}
        <div className="fm-ocr-group-head">
          <span className="dot" style={{ background: '#c25a25' }} />
          <span className="name">Dining</span>
          <span className="meta">1 item · $7.99</span>
        </div>
        <div className="fm-ocr-item editable">
          <span className="name">Hot bar lunch</span>
          <span className="cat" style={{ color: '#c25a25' }}>Dining <Icon name="chevDown" size={11} strokeWidth={2.2} /></span>
          <span className="amt">$7.99</span>
        </div>

        {/* Household group */}
        <div className="fm-ocr-group-head">
          <span className="dot" style={{ background: '#6a4dba' }} />
          <span className="name">Household</span>
          <span className="meta">1 item · $4.00</span>
        </div>
        <div className="fm-ocr-item editable">
          <span className="name">Dish soap</span>
          <span className="cat" style={{ color: '#6a4dba' }}>Household <Icon name="chevDown" size={11} strokeWidth={2.2} /></span>
          <span className="amt">$4.00</span>
        </div>

        {/* Totals */}
        <div className="fm-ocr-item subtle"><span className="name" style={{ gridColumn: '1 / span 2' }}>Tax</span><span className="amt">$2.45</span></div>
        <div className="fm-ocr-item total"><span className="name" style={{ gridColumn: '1 / span 2' }}>Total</span><span className="amt">$32.18</span></div>
      </div>

      <div style={{ padding: '12px 16px 0' }}>
        <button className="fm-btn" style={{ width: '100%', color: 'var(--color-muted)', background: 'transparent' }}>
          Retake photo
        </button>
      </div>
    </div>
  </Phone>
);

// (4) Saved — success state showing the multi-tx breakdown
const ReceiptSaved = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <div className="fm-nav-spacer" />
      <button className="fm-nav-save">Done</button>
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      {/* Header — compact success */}
      <div className="fm-receipt-saved-hero">
        <div className="fm-receipt-saved-check">
          <Icon name="check" size={24} strokeWidth={2.4} />
        </div>
        <div className="fm-receipt-saved-title">Saved · 3 transactions</div>
        <div className="fm-receipt-saved-sub">
          $32.18 at Whole Foods Market on May 11 was split across 3 categories — each one lives as its own activity.
        </div>
      </div>

      {/* Breakdown — 3 cards, one per tx */}
      <div className="fm-settings-group-label">Created</div>
      <div className="fm-receipt-tx-list">
        <button className="fm-receipt-tx-row">
          <span className="fm-receipt-tx-glyph" style={{ background: 'rgba(31,140,68,0.12)', color: '#1f8c44' }}>
            <Icon name="cart" size={16} />
          </span>
          <div className="fm-receipt-tx-body">
            <div className="fm-receipt-tx-top">
              <span className="fm-receipt-tx-merchant">Whole Foods Market</span>
              <span className="fm-receipt-tx-amt">−$17.74</span>
            </div>
            <div className="fm-receipt-tx-meta">
              <span className="fm-receipt-tx-cat" style={{ color: '#1f8c44' }}>Groceries</span>
              <span className="fm-receipt-tx-dot" />
              <span>3 items</span>
              <span className="fm-receipt-tx-dot" />
              <span>May 11 · 6:42 PM</span>
            </div>
          </div>
          <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
        </button>

        <button className="fm-receipt-tx-row">
          <span className="fm-receipt-tx-glyph" style={{ background: 'rgba(217,113,67,0.16)', color: '#c25a25' }}>
            <Icon name="utensils" size={16} />
          </span>
          <div className="fm-receipt-tx-body">
            <div className="fm-receipt-tx-top">
              <span className="fm-receipt-tx-merchant">Whole Foods Market</span>
              <span className="fm-receipt-tx-amt">−$7.99</span>
            </div>
            <div className="fm-receipt-tx-meta">
              <span className="fm-receipt-tx-cat" style={{ color: '#c25a25' }}>Dining</span>
              <span className="fm-receipt-tx-dot" />
              <span>1 item</span>
              <span className="fm-receipt-tx-dot" />
              <span>May 11 · 6:42 PM</span>
            </div>
          </div>
          <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
        </button>

        <button className="fm-receipt-tx-row">
          <span className="fm-receipt-tx-glyph" style={{ background: 'rgba(118,90,200,0.14)', color: '#6a4dba' }}>
            <Icon name="home" size={16} />
          </span>
          <div className="fm-receipt-tx-body">
            <div className="fm-receipt-tx-top">
              <span className="fm-receipt-tx-merchant">Whole Foods Market</span>
              <span className="fm-receipt-tx-amt">−$6.45</span>
            </div>
            <div className="fm-receipt-tx-meta">
              <span className="fm-receipt-tx-cat" style={{ color: '#6a4dba' }}>Household</span>
              <span className="fm-receipt-tx-dot" />
              <span>1 item · incl. tax</span>
              <span className="fm-receipt-tx-dot" />
              <span>May 11 · 6:42 PM</span>
            </div>
          </div>
          <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
        </button>
      </div>

      <div className="fm-receipt-saved-meta">
        <span className="lbl">Linked to</span>
        <span className="val">Pending charge · BMO ··1234 · $32.18</span>
      </div>

      <div style={{ padding: '20px 16px 0', display: 'flex', gap: 8 }}>
        <button className="fm-btn" style={{ flex: 1 }}>
          <Icon name="camera" size={16} strokeWidth={1.8} style={{ marginRight: 6, verticalAlign: '-3px' }} />
          Scan another
        </button>
        <button className="fm-btn primary" style={{ flex: 1 }}>
          View in Activity
        </button>
      </div>
    </div>
  </Phone>
);


// ============================================================
// Phase 3 — Goals (Pro)
// 5 surfaces:
//   (1) Goals list — single linear list sorted by due date
//   (2) Goal create — name + target + AI strategy hint
//   (3) Goal detail — progress + path + reasoning + linked categories
//   (4) Home · Goals section variant
//   (5) Chat plan with "Save as goal" CTA
// ============================================================

// Compact card used inside Goals list, Home section
const GoalGlance = ({
  title,
  target,
  saved,
  pct = 0,
  due,               // e.g. "Due Nov 12 · 6 months"
  status,            // 'on-track' | 'behind' | 'paused' | 'done'
  glyph = 'plane',
  accent = 'var(--color-primary)',
}) => (
  <button className={`fm-pg-card s-${status || 'on-track'}`}>
    <div className="fm-pg-head">
      <span className="fm-plan-glyph" style={{ background: `${accent}1f`, color: accent }}>
        <Icon name={glyph} size={16} strokeWidth={1.8} />
      </span>
      <div className="fm-pg-titles">
        <div className="fm-plan-title">{title}</div>
        <div className="fm-pg-meta">
          <span>{target}</span>
          <span className="dot" />
          <span>{due}</span>
        </div>
      </div>
      {status && <span className={`fm-pg-status ${status}`}>
        {status === 'on-track' ? 'On track' : status === 'behind' ? 'Behind' : status === 'paused' ? 'Paused' : 'Done'}
      </span>}
    </div>
    <div className="fm-plan-bar">
      <span style={{ width: `${pct}%`, background: accent }} />
    </div>
    <div className="fm-pg-foot">
      <span>{saved}</span>
      <span>{pct}%</span>
    </div>
  </button>
);

// (1) Goals list — single linear list sorted by due date (soonest first)
const GoalsList = ({ dark }) => (
  <Phone dark={dark}>
    <Header
      title="Goals"
      subtitle="4 active · $510/mo set aside"
      dark={dark}
      actions={
        <button className="fm-iconbtn" aria-label="New goal">
          <Icon name="plus" size={20} strokeWidth={1.8} />
        </button>
      }
    />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-plans-list">
        <GoalGlance
          title="Mother's Day dinner"
          target="$240"
          saved="$180 saved"
          pct={75}
          due="Due in 13 days · May 25"
          status="on-track"
          glyph="utensils"
          accent="#c25a25"
        />
        <GoalGlance
          title="New laptop"
          target="$1,800"
          saved="$420 saved"
          pct={23}
          due="Due in 4 months · Sep 1"
          status="behind"
          glyph="receipt"
          accent="#6a4dba"
        />
        <GoalGlance
          title="Japan trip"
          target="$2,400"
          saved="$1,488 saved"
          pct={62}
          due="Due in 6 months · Nov 12"
          status="on-track"
          glyph="plane"
          accent="var(--color-primary)"
        />
        <GoalGlance
          title="House down payment"
          target="$40,000"
          saved="$8,420 saved"
          pct={21}
          due="Due in 2.3 years · Aug 2028"
          status="on-track"
          glyph="home"
          accent="#5fc4a1"
        />
      </div>

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="goals" />
  </Phone>
);

// (2) Goal create — name + target + AI strategy hint
const GoalCreate = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Cancel">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">New goal</div>
      <div className="fm-nav-spacer" />
      <button className="fm-nav-save">Create</button>
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div className="fm-settings-group-label">Plan</div>
      <div className="fm-create-name">
        <div className="fm-create-name-label">Name</div>
        <div className="fm-create-name-input">
          Japan trip
          <span className="fm-create-caret" />
        </div>
        <div className="fm-create-name-hint">Two weeks in Tokyo + Kyoto, late November.</div>
      </div>

      <div className="fm-settings-group-label">Target</div>
      <div className="fm-settings-group">
        <div className="fm-detail-row">
          <div className="ic"><Icon name="tag" size={16} /></div>
          <div className="lbl">Amount</div>
          <div className="val" style={{ color: 'var(--color-muted-soft)' }}>Required<span className="chev"><Icon name="chevRight" size={16} /></span></div>
        </div>
        <div className="fm-detail-row">
          <div className="ic"><Icon name="calendar" size={16} /></div>
          <div className="lbl">By</div>
          <div className="val" style={{ color: 'var(--color-muted-soft)' }}>Pick a date<span className="chev"><Icon name="chevRight" size={16} /></span></div>
        </div>
      </div>

      <div className="fm-create-ai-hint">
        <span className="fm-create-ai-hint-glyph">
          <Icon name="sparkle" size={14} strokeWidth={1.8} />
        </span>
        <div className="fm-create-ai-hint-body">
          <div className="fm-create-ai-hint-title">Fina will suggest a path</div>
          <div className="fm-create-ai-hint-sub">
            Once you set an amount and target date, I'll work out monthly pace and where the money comes from.
          </div>
        </div>
      </div>
    </div>
  </Phone>
);

// (3) Goal detail — progress + strategy + reasoning + linked categories
const GoalDetail = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Goal</div>
      <div className="fm-nav-spacer" />
      <button className="fm-chathead-btn" aria-label="More">
        <Icon name="more" size={20} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      {/* Hero — title + progress */}
      <div className="fm-plan-detail-hero">
        <div className="fm-plan-detail-title">Japan trip</div>
        <div className="fm-plan-detail-meta">Two weeks in Tokyo + Kyoto, late November</div>

        <div className="fm-plan-detail-progress">
          <div className="fm-plan-detail-saved">
            <span className="num">$1,488</span>
            <span className="of">/ $2,400</span>
          </div>
          <div className="fm-plan-bar" style={{ height: 10, marginTop: 14 }}>
            <span style={{ width: '62%', background: 'var(--color-primary)' }} />
          </div>
          <div className="fm-plan-detail-axis">
            <span>62%</span>
            <span className="status on-track">On track · 6 months left</span>
            <span>$912 to go</span>
          </div>
        </div>
      </div>

      {/* Path strategy */}
      <div className="fm-settings-group-label">Path · $152/mo</div>
      <div className="fm-settings-group" style={{ padding: '4px 16px' }}>
        <div className="fm-create-strat-row" style={{ borderBottom: '1px solid var(--color-hairline-soft)' }}>
          <span className="ic" style={{ background: 'rgba(31,140,68,0.12)', color: '#1f8c44' }}>
            <Icon name="trendDown" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="title">Trim Dining by $80/mo</div>
            <div className="sub">You're tracking $58 under so far — keep going.</div>
          </div>
          <span className="amt up">+$58</span>
        </div>
        <div className="fm-create-strat-row">
          <span className="ic" style={{ background: 'rgba(125, 216, 184,0.12)', color: '#5fc4a1' }}>
            <Icon name="refresh" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="title">Reroute payroll surplus</div>
            <div className="sub">$72 moved automatically each pay cycle.</div>
          </div>
          <span className="amt up">+$72</span>
        </div>
      </div>

      {/* AI reasoning — collapsed by default */}
      <button className="fm-plan-reasoning collapsed">
        <div className="fm-plan-reasoning-head">
          <div className="fm-plan-reasoning-glyph">
            <Icon name="sparkle" size={14} strokeWidth={1.8} />
          </div>
          <div className="fm-plan-reasoning-titles">
            <div className="fm-plan-reasoning-title">Why this path</div>
            <div className="fm-plan-reasoning-sub">Fina's reasoning · trims dining, reroutes payroll</div>
          </div>
          <span className="fm-plan-reasoning-chev">
            <Icon name="chevDown" size={14} strokeWidth={2} />
          </span>
        </div>
      </button>

      {/* Milestones */}
      <div className="fm-settings-group-label">Milestones</div>
      <div className="fm-plan-milestones">
        <div className="fm-milestone done">
          <span className="dot" />
          <div className="body">
            <div className="title">25%</div>
            <div className="meta">Feb 14</div>
          </div>
        </div>
        <div className="fm-milestone done">
          <span className="dot" />
          <div className="body">
            <div className="title">50%</div>
            <div className="meta">Apr 8</div>
          </div>
        </div>
        <div className="fm-milestone current">
          <span className="dot" />
          <div className="body">
            <div className="title">75%</div>
            <div className="meta">est Jul 20</div>
          </div>
        </div>
        <div className="fm-milestone">
          <span className="dot" />
          <div className="body">
            <div className="title">100%</div>
            <div className="meta">Nov 12</div>
          </div>
        </div>
      </div>

      {/* Linked categories */}
      <div className="fm-settings-group-label">Linked categories</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row">
          <span className="fm-settings-glyph" style={{ background: 'rgba(217,113,67,0.16)', color: '#c25a25' }}>
            <Icon name="utensils" size={16} />
          </span>
          <div className="fm-settings-row-body">
            <span className="fm-settings-row-title">Dining</span>
            <span className="fm-settings-row-sub">Tracking $80/mo savings</span>
          </div>
          <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
        </div>
        <div className="fm-settings-row">
          <span className="fm-settings-glyph" style={{ background: 'rgba(125, 216, 184,0.12)', color: '#5fc4a1' }}>
            <Icon name="bank" size={16} />
          </span>
          <div className="fm-settings-row-body">
            <span className="fm-settings-row-title">BMO Chequing ··1234</span>
            <span className="fm-settings-row-sub">$72 auto-routed each pay cycle</span>
          </div>
          <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
        </div>
      </div>

      <div style={{ padding: '20px 16px 0', display: 'flex', gap: 8 }}>
        <button className="fm-btn" style={{ flex: 1 }}>Pause</button>
        <button className="fm-btn primary" style={{ flex: 1.4 }}>Adjust goal</button>
      </div>
    </div>
  </Phone>
);

// (4) Home with Goals glance section variant
const HomeWithGoals = ({ dark, tier = 'pro' }) => (
  <Phone dark={dark}>
    <Header
      title="Hi, Brian"
      subtitle="Tuesday, May 12"
      dark={dark}
      actions={<>
        <IconBtn icon="bell" dark={dark} />
        <IconBtn icon="more" dark={dark} />
      </>}
    />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-hero">
        <div className="fm-stat-label">May spending</div>
        <div className="fm-hero-value">$1,847<span className="fm-hero-value-decimal">.20</span></div>
        <div className="fm-hero-meta">
          <span>of $2,700 budget</span>
          <span className="fm-hero-meta-dot" />
          <span style={{ color: 'var(--color-up)', fontWeight: 600 }}>$852.80 left</span>
        </div>
        <div className="fm-stat-bar" style={{ marginTop: 16 }}>
          <span style={{ width: '68%' }} />
        </div>
      </div>

      {/* Goals glance */}
      <div className="fm-section-eyebrow" style={{ paddingTop: 12, display: 'flex', justifyContent: 'space-between', paddingRight: 24 }}>
        <span>Goals · 4 active</span>
        <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>See all →</span>
      </div>
      <div className="fm-plans-list" style={{ marginTop: 4 }}>
        <GoalGlance
          title="Japan trip"
          target="$2,400"
          saved="$1,488 saved"
          pct={62}
          due="Due in 6 months · Nov 12"
          status="on-track"
          glyph="plane"
          accent="var(--color-primary)"
        />
        <GoalGlance
          title="Mother's Day dinner"
          target="$240"
          saved="$180 saved"
          pct={75}
          due="Due in 13 days · May 25"
          status="on-track"
          glyph="utensils"
          accent="#c25a25"
        />
      </div>

      {/* AI brief card */}
      <div className="fm-brief-card" style={{ marginTop: 16 }}>
        <div className="fm-brief-head">
          <div className="fm-brief-eyebrow">
            <span className="fm-brief-dot" />
            Fina · Morning brief
          </div>
          <div className="fm-brief-time">Just now</div>
        </div>
        <div className="fm-brief-body">
          <p>Yesterday came to <strong>$214.83</strong>. Two need a category. Japan plan still on track.</p>
        </div>
        <div className="fm-brief-foot">
          <span className="fm-brief-meta">2 to sort</span>
          <span className="fm-brief-cta">Open <Icon name="chevRight" size={14} strokeWidth={2} /></span>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="home" badges={{ tx: 2 }} />
  </Phone>
);

// (5) Chat plan with "Save as goal" CTA + AI reasoning expanded
const ChatPlanWithSave = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Japan trip" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-chat-list" style={{ paddingTop: 12 }}>
        <div className="fm-chat-day">Today · 7:42 PM</div>

        <div className="fm-msg user">
          <div className="fm-bubble">Can we afford Japan in November?</div>
        </div>

        <Bubble role="ai">
          Almost. At today's pace you'd be <strong>$420 short</strong>. Trim <strong>$80/mo</strong> on Dining
          (already $62 over budget) and you're there by <strong>Nov 12</strong>.
        </Bubble>

        <PlanCard
          title="Japan trip · plan"
          meta="Target $2,400 · 6 months"
          status="On track"
          progress={62}
          saved="$1,488 saved"
        />

        <div className="fm-block-actions">
          <button className="fm-btn">Tweak target</button>
          <button className="fm-btn primary">Save as goal</button>
        </div>

        <Bubble role="ai" tag={false}>
          I can also reroute the <strong>$72/mo</strong> sitting idle in chequing each pay cycle straight to Savings — that's where the math closes.
        </Bubble>

        <QuickReplies options={['Show me where I overspend', 'Set the dining cap', 'Not yet']} />
      </div>
    </div>
    <InputBar />
  </Phone>
);


// ============================================================
// Phase 3 (misc) — Date range picker (Activity filter)
// Bottom sheet opened from "This month ▾" pill in Activity filter bar.
// Two variants:
//  (a) Preset list view — quick presets, current selection highlighted
//  (b) Custom calendar view — range selection across days
// ============================================================
const DateRangePicker = ({ dark, mode = 'preset' }) => {
  // Calendar data — May 2025
  const monthDays = (() => {
    const days = [];
    const firstWeekday = 4; // May 1, 2025 is a Thursday (Sun=0)
    // Previous month tail (gray)
    for (let i = firstWeekday - 1; i >= 0; i--) {
      days.push({ d: 27 + i, muted: true });
    }
    for (let i = 1; i <= 31; i++) days.push({ d: i });
    return days;
  })();

  return (
    <Phone dark={dark}>
      {/* Faded Activity behind the sheet */}
      <div style={{ filter: 'blur(3px) brightness(0.86)', height: '100%' }}>
        <Header title="Activity" dark={dark}
          actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />
        <div className="fm-content" style={{ paddingBottom: 84 }}>
          <div className="fm-filter-bar">
            <span className="fm-filter-pill active">This month <Icon name="chevDown" size={12} strokeWidth={2} /></span>
            <span className="fm-filter-pill">All accounts</span>
            <span className="fm-filter-pill">All categories</span>
          </div>
          <div className="fm-tx-day">
            <span>Today · May 12</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
          </div>
          <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
        </div>
      </div>

      <div className="fm-daterange-sheet-scrim">
        <div className="fm-daterange-sheet">
          <div className="fm-sheet-grabber" />
          <div className="fm-daterange-head">
            <button className="fm-daterange-cancel">Cancel</button>
            <div className="fm-daterange-title">Date range</div>
            <button className="fm-daterange-apply">Apply</button>
          </div>

          <div className="fm-daterange-tabs">
            <button className={`fm-daterange-tab${mode === 'preset' ? ' active' : ''}`}>Presets</button>
            <button className={`fm-daterange-tab${mode === 'custom' ? ' active' : ''}`}>Custom</button>
          </div>

          {mode === 'preset' ? (
            <div className="fm-daterange-presets">
              <div className="fm-daterange-preset selected">
                <span className="lbl">This month</span>
                <span className="range">May 1 – May 12</span>
                <span className="check"><Icon name="check" size={13} strokeWidth={2.6} color="#fff" /></span>
              </div>
              <div className="fm-daterange-preset">
                <span className="lbl">Last month</span>
                <span className="range">Apr 1 – Apr 30</span>
              </div>
              <div className="fm-daterange-preset">
                <span className="lbl">Last 3 months</span>
                <span className="range">Feb 13 – May 12</span>
              </div>
              <div className="fm-daterange-preset">
                <span className="lbl">Year to date</span>
                <span className="range">Jan 1 – May 12</span>
              </div>
              <div className="fm-daterange-preset">
                <span className="lbl">All time</span>
                <span className="range">Since Mar 2024</span>
              </div>
            </div>
          ) : (
            <div className="fm-daterange-custom">
              {/* Range summary */}
              <div className="fm-daterange-range">
                <div className="fm-daterange-range-cell selected start">
                  <span className="lbl">Start</span>
                  <span className="val">May 3</span>
                </div>
                <span className="fm-daterange-arrow">→</span>
                <div className="fm-daterange-range-cell selected end">
                  <span className="lbl">End</span>
                  <span className="val">May 18</span>
                </div>
              </div>

              {/* Calendar */}
              <div className="fm-daterange-cal">
                <div className="fm-daterange-cal-head">
                  <button className="fm-daterange-cal-nav" aria-label="Previous month">
                    <Icon name="chevLeft" size={16} strokeWidth={2} />
                  </button>
                  <div className="fm-daterange-cal-month">May 2025</div>
                  <button className="fm-daterange-cal-nav" aria-label="Next month">
                    <Icon name="chevRight" size={16} strokeWidth={2} />
                  </button>
                </div>
                <div className="fm-daterange-cal-dow">
                  {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                    <div key={i}>{d}</div>
                  ))}
                </div>
                <div className="fm-daterange-cal-grid">
                  {monthDays.map((day, i) => {
                    if (day.muted) return <div key={i} className="cell muted">{day.d}</div>;
                    const inRange = day.d >= 3 && day.d <= 18;
                    const isStart = day.d === 3;
                    const isEnd = day.d === 18;
                    const isToday = day.d === 12;
                    return (
                      <div key={i} className={`cell${inRange ? ' in-range' : ''}${isStart ? ' start' : ''}${isEnd ? ' end' : ''}${isToday ? ' today' : ''}`}>
                        {day.d}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="fm-daterange-summary">
                <span>16 days selected</span>
                <span className="dot" />
                <span>3 weeks ago → today</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </Phone>
  );
};


// ============================================================
// Phase 3 (misc) — Trial expiring banner · other surfaces
// Same fm-trial-banner.danger as HomeTrialExpiring, dropped onto
// Activity / Chat / Banks so the warning is consistent everywhere
// in the 5 days before trial ends.
// ============================================================

const ActivityTrialExpiring = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-trial-banner danger" style={{ marginTop: 8 }}>
        <span className="fm-trial-banner-glyph">
          <Icon name="alert" size={16} strokeWidth={1.8} />
        </span>
        <div className="fm-trial-banner-body">
          <div className="fm-trial-banner-title">Pro Trial ends in 3 days</div>
          <div className="fm-trial-banner-sub">Plaid sync pauses Sunday.</div>
        </div>
        <button className="fm-trial-banner-cta">Choose plan</button>
      </div>

      <div className="fm-filter-bar">
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      <div className="fm-tx-day">
        <span>Today · May 12</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
      </div>
      <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
      <TxRow icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$146.03</span>
      </div>
      <TxRow icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="21:12" pending />
      <TxRow icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="16:38" />

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="tx" badges={{ tx: 2, settings: 'dot' }} />
  </Phone>
);

const ChatTrialExpiring = ({ dark }) => (
  <Phone dark={dark}>
    <ChatHeader title="Morning brief" dark={dark} />
    <div className="fm-content" style={{ paddingBottom: 180 }}>
      <div className="fm-trial-banner danger" style={{ marginTop: 8 }}>
        <span className="fm-trial-banner-glyph">
          <Icon name="alert" size={16} strokeWidth={1.8} />
        </span>
        <div className="fm-trial-banner-body">
          <div className="fm-trial-banner-title">Pro Trial ends in 3 days</div>
          <div className="fm-trial-banner-sub">AI brief, chat, and Plaid sync pause Sunday.</div>
        </div>
        <button className="fm-trial-banner-cta">Choose plan</button>
      </div>
      <div className="fm-chat-list" style={{ paddingTop: 4 }}>
        <div className="fm-chat-day">Today · 8:00 AM</div>
        <Bubble role="ai">
          Morning, Brian — yesterday came to <strong>$214.83</strong> across 5 transactions. Two need a category.
        </Bubble>
        <CategorizeCard merchant="Costco Wholesale" amount="$87.43" when="Yesterday, 9:12 PM" glyph="cart" suggestion="Groceries" />
        <CategorizeCard merchant="Tim Hortons" amount="$6.50" when="Yesterday, 10:04 AM" glyph="coffee" suggestion="Coffee & dining" />
      </div>
    </div>
    <InputBar />
  </Phone>
);

const BanksTrialExpiring = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Banks</div>
      <div className="fm-nav-spacer" />
      <button className="fm-nav-back" aria-label="Add bank" style={{ marginRight: -4 }}>
        <Icon name="plus" size={20} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 32 }}>
      <div className="fm-trial-banner danger" style={{ marginTop: 8 }}>
        <span className="fm-trial-banner-glyph">
          <Icon name="alert" size={16} strokeWidth={1.8} />
        </span>
        <div className="fm-trial-banner-body">
          <div className="fm-trial-banner-title">Pro Trial ends in 3 days</div>
          <div className="fm-trial-banner-sub">After Sunday, syncing pauses — your data stays.</div>
        </div>
        <button className="fm-trial-banner-cta">Choose plan</button>
      </div>

      <BankCard
        name="BMO"
        logo="BMO"
        logoBg="#0079c1"
        sync="Synced 2 minutes ago"
        accounts={[
          { name: 'Chequing', mask: '1234', balance: '$4,128.50' },
          { name: 'Savings', mask: '5678', balance: '$12,890.00' },
        ]}
      />
      <BankCard
        name="TD Bank"
        logo="TD"
        logoBg="#1c8c44"
        sync="Reconnection required"
        error
        accounts={[
          { name: 'Credit Card', mask: '0042', balance: '−$487.20' },
        ]}
      />
    </div>
  </Phone>
);


// ============================================================
// Phase 3 (misc) — Sign out confirm modal
// Bottom sheet over the More page when "Sign out" is tapped.
// ============================================================
const SignOutConfirm = ({ dark }) => (
  <Phone dark={dark}>
    {/* Faded More page behind the sheet */}
    <div style={{ filter: 'blur(3px) brightness(0.86)', height: '100%' }}>
      <Settings dark={dark} tier="pro" />
    </div>

    <div className="fm-ws-sheet-scrim">
      <div className="fm-ws-sheet" style={{ paddingBottom: 28 }}>
        <div className="grabber" />

        <div className="fm-signout-head">
          <div className="fm-signout-illo">
            <Icon name="lock" size={22} strokeWidth={1.8} />
          </div>
          <div className="fm-signout-title">Sign out of Fina?</div>
          <div className="fm-signout-sub">
            Your transactions, plans, and goals stay on your account.
            Sign back in any time to pick up where you left off.
          </div>
        </div>

        <div className="fm-signout-meta">
          <div className="fm-signout-meta-row">
            <span className="lbl">Account</span>
            <span className="val">cwsbrian@gmail.com</span>
          </div>
          <div className="fm-signout-meta-row">
            <span className="lbl">Workspace</span>
            <span className="val">Choi family · 2 members</span>
          </div>
        </div>

        <div className="fm-signout-actions">
          <button className="fm-btn">Cancel</button>
          <button className="fm-btn primary danger">Sign out</button>
        </div>
      </div>
    </div>
  </Phone>
);


// ============================================================
// Phase 3 (misc) — Tier-gated screens (Free / Lite states)
// Goals: Pro-only — Free + Lite users see locked surface.
// Banks · Lite at limit: Lite user trying to add 2nd bank → upgrade prompt.
// ============================================================

// Goals · Free (or Lite) — locked tab with upgrade card
const GoalsLocked = ({ dark, tier = 'free' }) => (
  <Phone dark={dark}>
    <Header
      title="Goals"
      dark={dark}
      actions={
        <button className="fm-iconbtn" aria-label="New goal" disabled>
          <Icon name="plus" size={20} strokeWidth={1.8} color="var(--color-muted-soft)" />
        </button>
      }
    />
    <div className="fm-content fm-empty centered" style={{ paddingBottom: 84 }}>
      <div className="fm-empty-illo" style={{ background: 'rgba(217,113,67,0.12)', color: 'var(--color-primary)' }}>
        <Icon name="target" size={36} strokeWidth={1.5} />
      </div>
      <div className="fm-tier-lock-pill">
        <Icon name="lock" size={11} strokeWidth={2.2} />
        Pro feature
      </div>
      <div className="fm-empty-title">Plan ahead with goals</div>
      <div className="fm-empty-sub">
        Save for a trip, a laptop, or a calmer rainy-day fund.
        Fina sketches a path and nudges when you're off track.
      </div>

      <div className="fm-tier-lock-preview">
        <div className="fm-tier-lock-row">
          <span className="ic" style={{ background: 'rgba(217,113,67,0.14)', color: 'var(--color-primary)' }}>
            <Icon name="plane" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="title">Japan trip</div>
            <div className="meta">$2,400 · Nov 12</div>
          </div>
          <span className="lock"><Icon name="lock" size={12} strokeWidth={1.8} /></span>
        </div>
        <div className="fm-tier-lock-row">
          <span className="ic" style={{ background: 'rgba(118,90,200,0.14)', color: '#6a4dba' }}>
            <Icon name="receipt" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="title">New laptop</div>
            <div className="meta">$1,800 · Sep 1</div>
          </div>
          <span className="lock"><Icon name="lock" size={12} strokeWidth={1.8} /></span>
        </div>
      </div>

      <div className="fm-empty-ctas" style={{ marginTop: 20 }}>
        <button className="fm-empty-cta">
          <Icon name="sparkle" size={16} strokeWidth={1.8} color="#fff" />
          {tier === 'free' ? 'Start Pro trial — 30 days free' : 'Upgrade to Pro · $15/mo'}
        </button>
        <button className="fm-empty-cta subtle">See what's included</button>
      </div>
    </div>
    <TabBar active="goals" />
  </Phone>
);

// Banks · Lite at limit — trying to add 2nd bank
const BanksLiteAtLimit = ({ dark }) => (
  <Phone dark={dark}>
    {/* Faded Banks list behind */}
    <div style={{ filter: 'blur(3px) brightness(0.84)', height: '100%' }}>
      <div className="fm-nav-bar">
        <button className="fm-nav-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>
        <div className="fm-nav-title">Banks</div>
        <div className="fm-nav-spacer" />
        <button className="fm-nav-back" aria-label="Add bank" style={{ marginRight: -4 }}>
          <Icon name="plus" size={20} strokeWidth={1.8} />
        </button>
      </div>
      <div className="fm-content" style={{ paddingTop: 55, paddingBottom: 32 }}>
        <BankCard
          name="BMO"
          logo="BMO"
          logoBg="#0079c1"
          sync="Synced 2 minutes ago"
          accounts={[
            { name: 'Chequing', mask: '1234', balance: '$4,128.50' },
          ]}
        />
      </div>
    </div>

    <div className="fm-sheet-scrim">
      <div className="fm-sheet">
        <div className="fm-sheet-grabber" />
        <div style={{
          width: 48, height: 48, borderRadius: 14, background: 'rgba(217,113,67,0.12)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-primary)',
          marginBottom: 16,
        }}>
          <Icon name="bank" size={24} strokeWidth={1.8} />
        </div>
        <h2>You're at the Lite limit</h2>
        <p>Lite includes 1 connected bank. Upgrade to Pro for unlimited connections — useful if you have multiple banks or a partner's accounts to share.</p>

        <div className="fm-tier-card">
          <div style={{ flex: 1 }}>
            <div className="fm-tier-name">Stay on Lite</div>
            <div className="fm-tier-price">Disconnect BMO first to swap.</div>
          </div>
          <button className="fm-tier-cta" style={{ background: 'var(--color-ink)' }}>Manage</button>
        </div>

        <div className="fm-tier-card featured">
          <div style={{ flex: 1 }}>
            <div className="fm-tier-name">Pro · $15/mo</div>
            <div className="fm-tier-price">Unlimited banks · full chat · AI brief</div>
          </div>
          <button className="fm-tier-cta">Upgrade</button>
        </div>

        <button style={{
          marginTop: 16, padding: '12px 16px', background: 'transparent', border: 0,
          font: 'var(--type-body-sm)', color: 'var(--color-muted)', cursor: 'pointer',
        }}>Maybe later</button>
      </div>
    </div>
  </Phone>
);


// ============================================================
// Phase 3 (misc) — Notification settings (drill-in from More · AI section)
// Toggle each push type independently: daily ritual, anomaly,
// trial alert, plaid error.
// ============================================================
const NotificationSettings = ({ dark }) => {
  const Toggle = ({ on = true }) => (
    <div className={`fm-toggle${on ? ' on' : ''}`} />
  );
  const Row = ({ title, sub, on = true }) => (
    <div className="fm-settings-row">
      <div className="fm-settings-row-body">
        <div className="fm-settings-row-title">{title}</div>
        <div className="fm-settings-row-sub">{sub}</div>
      </div>
      <Toggle on={on} />
    </div>
  );
  return (
    <Phone dark={dark}>
      <div className="fm-nav-bar">
        <button className="fm-nav-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>
        <div className="fm-nav-title">Notifications</div>
        <div className="fm-nav-spacer" />
      </div>
      <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
        <div className="fm-notif-hero">
          <div className="fm-notif-hero-glyph">
            <Icon name="bell" size={20} strokeWidth={1.8} />
          </div>
          <div className="fm-notif-hero-body">
            <div className="fm-notif-hero-title">Push notifications</div>
            <div className="fm-notif-hero-sub">
              Pick what's worth interrupting you for. Everything still shows up in chat.
            </div>
          </div>
        </div>

        <div className="fm-settings-group-label">Daily</div>
        <div className="fm-settings-group">
          <Row
            title="Morning brief"
            sub="One push each morning summarizing yesterday."
            on
          />
        </div>

        <div className="fm-settings-group-label">Worth a look</div>
        <div className="fm-settings-group">
          <Row
            title="Large or unusual charges"
            sub="When something costs way more than your usual."
            on
          />
          <Row
            title="Subscription about to renew"
            sub="Heads-up the day before Netflix, Spotify, etc."
            on
          />
          <Row
            title="Goal milestones"
            sub="When you cross 25 / 50 / 75% on a goal."
          />
        </div>

        <div className="fm-settings-group-label">Account</div>
        <div className="fm-settings-group">
          <Row
            title="Bank reconnect required"
            sub="When a connected bank stops syncing."
            on
          />
          <Row
            title="Trial expiring"
            sub="5, 3, and 1 day before your trial ends."
            on
          />
          <Row
            title="Workspace invites"
            sub="When someone invites you to a workspace."
            on
          />
        </div>

        <div className="fm-settings-group-label">Marketing</div>
        <div className="fm-settings-group">
          <Row
            title="Product updates"
            sub="New features and tips. Sparse."
          />
        </div>

        <div className="fm-notif-foot">
          <Icon name="lock" size={12} strokeWidth={1.8} />
          <span>iOS system permissions managed in <a>Settings → Fina</a>.</span>
        </div>
      </div>
    </Phone>
  );
};



// ============================================================
// Activity — Split transaction list (bracketed group)
// One bank charge → multiple categories. Whole Foods $32.18
// split across Groceries / Dining / Household.
// ============================================================
const CC_SPLIT = {
  groceries:  { bg: 'rgba(31,140,68,0.14)',  fg: '#1f8c44', dot: '#1f8c44' },
  dining:     { bg: 'rgba(217,113,67,0.16)', fg: '#c25a25', dot: '#c25a25' },
  household:  { bg: 'rgba(118,90,200,0.14)', fg: '#6a4dba', dot: '#6a4dba' },
  transport:  { bg: 'rgba(125, 216, 184,0.12)', fg: '#5fc4a1', dot: '#5fc4a1' },
};

const TransactionsListSplit = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      <div className="fm-tx-day">
        <span>Today · May 12</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
      </div>
      <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
      <TxRow icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$178.21</span>
      </div>

      {/* Split transaction — bracketed group */}
      <div className="fm-tx-group">
        <div className="fm-tx-group-head">
          <div className="fm-cat-glyph"><Icon name="cart" size={16} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="merch">Whole Foods Market</div>
            <div className="merch-meta">
              <span className="pill">Split · 3</span>
              <span>18:42</span>
            </div>
          </div>
          <div className="total">−$32.18</div>
        </div>
        <div className="fm-tx-group-splits">
          <div className="fm-tx-split">
            <span className="cat-dot" style={{ background: CC_SPLIT.groceries.dot }} />
            <span className="cat-name">Groceries</span>
            <span className="cat-amt">−$17.74</span>
          </div>
          <div className="fm-tx-split">
            <span className="cat-dot" style={{ background: CC_SPLIT.dining.dot }} />
            <span className="cat-name">Dining</span>
            <span className="cat-amt">−$7.99</span>
          </div>
          <div className="fm-tx-split">
            <span className="cat-dot" style={{ background: CC_SPLIT.household.dot }} />
            <span className="cat-name">Household</span>
            <span className="cat-amt">−$6.45</span>
          </div>
        </div>
      </div>

      <TxRow icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="21:12" pending />
      <TxRow icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="16:38" />
    </div>
    <TabBar active="tx" />
  </Phone>
);

// ============================================================
// Transaction Detail · split tx (groups the per-category lines)
// ============================================================
const TransactionDetailSplit = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Transaction</div>
      <div className="fm-nav-spacer" />
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div style={{ padding: '12px 24px 28px', textAlign: 'left' }}>
        <div className="fm-cat-glyph" style={{ width: 52, height: 52, marginBottom: 14 }}>
          <Icon name="cart" size={22} />
        </div>
        <div style={{ font: 'var(--type-title-md)', fontWeight: 600 }}>Whole Foods Market</div>
        <div style={{ font: '38px/1 var(--font-sans)', fontWeight: 500, letterSpacing: '-1.4px', fontVariantNumeric: 'tabular-nums lining-nums', marginTop: 8 }}>
          −$32.18
        </div>
        <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-muted)', marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span>May 11 · 6:42 PM</span>
          <span style={{ width: 3, height: 3, borderRadius: 999, background: 'var(--color-muted-soft)' }} />
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px',
            borderRadius: 999,
            background: 'var(--color-surface-strong)',
            color: 'var(--color-muted)',
            font: '10.5px var(--font-sans)',
            fontWeight: 700,
            letterSpacing: '0.4px',
            textTransform: 'uppercase',
          }}>Split · 3</span>
        </div>
      </div>

      <div className="fm-settings-group-label">Details</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row">
          <span>Account</span>
          <div className="fm-row-detail">BMO Chequing ··1234</div>
        </div>
        <div className="fm-settings-row">
          <span>Status</span>
          <div className="fm-row-detail" style={{ color: 'var(--color-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-up)', display: 'inline-block' }} /> Posted
          </div>
        </div>
        <div className="fm-settings-row">
          <span>Merchant</span>
          <div className="fm-row-detail">WHOLE FOODS #3640</div>
        </div>
      </div>

      <div className="fm-settings-group-label" style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span>Categories</span>
        <span style={{ color: 'var(--color-muted)', fontWeight: 500, letterSpacing: 0, textTransform: 'none' }}>
          Split across 3
        </span>
      </div>
      <div className="fm-settings-group" style={{ padding: 0 }}>
        <div className="fm-detail-split-row">
          <span className="cat-glyph" style={{ background: CC_SPLIT.groceries.bg, color: CC_SPLIT.groceries.fg }}>
            <Icon name="cart" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="name">Groceries</div>
            <div className="meta">3 items · spinach, avocado, milk</div>
          </div>
          <div className="amt-block">
            <div className="amt">−$17.74</div>
            <span className="chev"><Icon name="chevRight" size={14} color="var(--color-muted-soft)" /></span>
          </div>
        </div>
        <div className="fm-detail-split-row">
          <span className="cat-glyph" style={{ background: CC_SPLIT.dining.bg, color: CC_SPLIT.dining.fg }}>
            <Icon name="utensils" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="name">Dining</div>
            <div className="meta">1 item · hot bar lunch</div>
          </div>
          <div className="amt-block">
            <div className="amt">−$7.99</div>
            <span className="chev"><Icon name="chevRight" size={14} color="var(--color-muted-soft)" /></span>
          </div>
        </div>
        <div className="fm-detail-split-row">
          <span className="cat-glyph" style={{ background: CC_SPLIT.household.bg, color: CC_SPLIT.household.fg }}>
            <Icon name="home" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="name">Household</div>
            <div className="meta">1 item · dish soap (incl. tax)</div>
          </div>
          <div className="amt-block">
            <div className="amt">−$6.45</div>
            <span className="chev"><Icon name="chevRight" size={14} color="var(--color-muted-soft)" /></span>
          </div>
        </div>
        <div className="fm-detail-split-row edit-row">
          <span className="cat-glyph edit">
            <Icon name="edit" size={14} strokeWidth={1.8} />
          </span>
          <div className="body">
            <div className="name">Edit split</div>
            <div className="meta">Adjust categories or amounts</div>
          </div>
          <span className="chev"><Icon name="chevRight" size={14} color="var(--color-muted-soft)" /></span>
        </div>
      </div>

      <div className="fm-settings-group-label">Note</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row" style={{ padding: '14px 16px', color: 'var(--color-muted)' }}>
          Weekly grocery run — split with Jen
        </div>
      </div>

      <div style={{ padding: '12px 16px 24px' }}>
        <button className="fm-btn" style={{ width: '100%', color: 'var(--color-down)', background: 'transparent' }}>
          Delete transaction
        </button>
      </div>
    </div>
  </Phone>
);

// ============================================================
// Transaction Detail · single category (entry into split flow)
// ============================================================
const TransactionDetailSingle = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Transaction</div>
      <div className="fm-nav-spacer" />
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div style={{ padding: '12px 24px 28px', textAlign: 'left' }}>
        <div className="fm-cat-glyph" style={{ width: 52, height: 52, marginBottom: 14 }}>
          <Icon name="cart" size={22} />
        </div>
        <div style={{ font: 'var(--type-title-md)', fontWeight: 600 }}>Whole Foods Market</div>
        <div style={{ font: '38px/1 var(--font-sans)', fontWeight: 500, letterSpacing: '-1.4px', fontVariantNumeric: 'tabular-nums lining-nums', marginTop: 8 }}>
          −$32.18
        </div>
        <div style={{ font: 'var(--type-body-sm)', color: 'var(--color-muted)', marginTop: 6 }}>
          May 11 · 6:42 PM
        </div>
      </div>

      <div className="fm-settings-group-label">Details</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row">
          <span>Account</span>
          <div className="fm-row-detail">BMO Chequing ··1234</div>
        </div>
        <div className="fm-settings-row">
          <span>Status</span>
          <div className="fm-row-detail" style={{ color: 'var(--color-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--color-up)', display: 'inline-block' }} /> Posted
          </div>
        </div>
      </div>

      <div className="fm-settings-group-label">Category</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row" style={{ padding: 16 }}>
          <span className="fm-cat-glyph" style={{
            width: 34, height: 34,
            background: CC_SPLIT.groceries.bg, color: CC_SPLIT.groceries.fg,
          }}>
            <Icon name="cart" size={16} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Groceries</div>
            <div style={{ font: 'var(--type-caption)', color: 'var(--color-muted)', marginTop: 2 }}>
              All $32.18 in one category
            </div>
          </div>
          <div className="fm-row-detail">
            <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Change</span>
          </div>
        </div>
        <button className="fm-detail-split-cta">
          <span className="cta-glyph">
            <Icon name="tag" size={14} strokeWidth={1.8} />
          </span>
          <div className="cta-body">
            <div className="cta-title">Split across multiple categories</div>
            <div className="cta-sub">e.g. some groceries, some household items</div>
          </div>
          <Icon name="chevRight" size={16} color="var(--color-muted-soft)" />
        </button>
      </div>

      <div className="fm-settings-group-label">Note</div>
      <div className="fm-settings-group">
        <div className="fm-settings-row" style={{ padding: '14px 16px', color: 'var(--color-muted)' }}>
          Weekly grocery run — split with Jen
        </div>
      </div>
    </div>
  </Phone>
);

// ============================================================
// Split editor sheet
// ============================================================
const SplitEditor = ({ dark, balance = '$0.00', valid = true }) => (
  <Phone dark={dark}>
    <div style={{ filter: 'blur(3px) brightness(0.85)', height: '100%' }}>
      <TransactionDetailSingle dark={dark} />
    </div>

    <div className="fm-split-sheet-scrim">
      <div className="fm-split-sheet">
        <div className="fm-sheet-grabber" />

        <div className="fm-split-head">
          <button className="fm-split-cancel">Cancel</button>
          <div className="fm-split-title">Split transaction</div>
          <button className={`fm-split-done${!valid ? ' disabled' : ''}`}>Done</button>
        </div>

        <div className="fm-split-balance">
          <div className="fm-split-balance-row">
            <span className="lbl">Total</span>
            <span className="val">$32.18</span>
          </div>
          <div className={`fm-split-balance-row${valid ? ' ok' : ' warn'}`}>
            <span className="lbl">{valid ? 'All allocated' : 'Still to split'}</span>
            <span className="val">{balance}</span>
          </div>
          <div className="fm-split-balance-bar">
            <span style={{ width: '55%', background: CC_SPLIT.groceries.dot }} />
            <span style={{ width: '25%', background: CC_SPLIT.dining.dot }} />
            <span style={{ width: '20%', background: CC_SPLIT.household.dot }} />
          </div>
        </div>

        <div className="fm-split-rows">
          <div className="fm-split-row">
            <span className="cat-pill" style={{ background: CC_SPLIT.groceries.bg, color: CC_SPLIT.groceries.fg }}>
              <span className="dot" style={{ background: CC_SPLIT.groceries.dot }} />
              Groceries
              <Icon name="chevDown" size={12} strokeWidth={2.2} />
            </span>
            <div className="amt-input filled">
              <span className="prefix">$</span>
              <span className="value">17.74</span>
              <span className="caret" />
            </div>
            <button className="remove" aria-label="Remove">
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="fm-split-row">
            <span className="cat-pill" style={{ background: CC_SPLIT.dining.bg, color: CC_SPLIT.dining.fg }}>
              <span className="dot" style={{ background: CC_SPLIT.dining.dot }} />
              Dining
              <Icon name="chevDown" size={12} strokeWidth={2.2} />
            </span>
            <div className="amt-input filled">
              <span className="prefix">$</span>
              <span className="value">7.99</span>
            </div>
            <button className="remove" aria-label="Remove">
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="fm-split-row">
            <span className="cat-pill" style={{ background: CC_SPLIT.household.bg, color: CC_SPLIT.household.fg }}>
              <span className="dot" style={{ background: CC_SPLIT.household.dot }} />
              Household
              <Icon name="chevDown" size={12} strokeWidth={2.2} />
            </span>
            <div className="amt-input filled">
              <span className="prefix">$</span>
              <span className="value">6.45</span>
            </div>
            <button className="remove" aria-label="Remove">
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>

          <button className="fm-split-add">
            <span className="plus">
              <Icon name="plus" size={14} strokeWidth={2.2} />
            </span>
            Add category
          </button>
        </div>

        <div className="fm-split-helpers">
          <button className="fm-split-helper">Split evenly</button>
          <button className="fm-split-helper">Fill remainder</button>
        </div>
      </div>
    </div>
  </Phone>
);

const SplitEditorImbalanced = ({ dark }) => (
  <SplitEditor dark={dark} balance="$6.45 left" valid={false} />
);

const SplitEditorOverflow = ({ dark }) => (
  <Phone dark={dark}>
    <div style={{ filter: 'blur(3px) brightness(0.85)', height: '100%' }}>
      <TransactionDetailSingle dark={dark} />
    </div>

    <div className="fm-split-sheet-scrim">
      <div className="fm-split-sheet">
        <div className="fm-sheet-grabber" />

        <div className="fm-split-head">
          <button className="fm-split-cancel">Cancel</button>
          <div className="fm-split-title">Split transaction</div>
          <button className="fm-split-done disabled">Done</button>
        </div>

        <div className="fm-split-balance overflow">
          <div className="fm-split-balance-row">
            <span className="lbl">Total</span>
            <span className="val">$32.18</span>
          </div>
          <div className="fm-split-balance-row over">
            <span className="lbl">Over by</span>
            <span className="val">$7.82</span>
          </div>
          <div className="fm-split-balance-bar overflow">
            <span style={{ width: '55%', background: CC_SPLIT.groceries.dot }} />
            <span style={{ width: '25%', background: CC_SPLIT.dining.dot }} />
            <span style={{ width: '20%', background: CC_SPLIT.household.dot }} />
            <span className="overflow-fill" style={{ width: '24%' }} />
          </div>
          <div className="fm-split-overflow-hint">
            <Icon name="alert" size={12} strokeWidth={1.8} />
            Reduce one of the amounts, or remove a category.
          </div>
        </div>

        <div className="fm-split-rows">
          <div className="fm-split-row">
            <span className="cat-pill" style={{ background: CC_SPLIT.groceries.bg, color: CC_SPLIT.groceries.fg }}>
              <span className="dot" style={{ background: CC_SPLIT.groceries.dot }} />
              Groceries
              <Icon name="chevDown" size={12} strokeWidth={2.2} />
            </span>
            <div className="amt-input">
              <span className="prefix">$</span>
              <span className="value">17.74</span>
            </div>
            <button className="remove" aria-label="Remove">
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="fm-split-row">
            <span className="cat-pill" style={{ background: CC_SPLIT.dining.bg, color: CC_SPLIT.dining.fg }}>
              <span className="dot" style={{ background: CC_SPLIT.dining.dot }} />
              Dining
              <Icon name="chevDown" size={12} strokeWidth={2.2} />
            </span>
            <div className="amt-input">
              <span className="prefix">$</span>
              <span className="value">7.99</span>
            </div>
            <button className="remove" aria-label="Remove">
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>
          <div className="fm-split-row over">
            <span className="cat-pill" style={{ background: CC_SPLIT.household.bg, color: CC_SPLIT.household.fg }}>
              <span className="dot" style={{ background: CC_SPLIT.household.dot }} />
              Household
              <Icon name="chevDown" size={12} strokeWidth={2.2} />
            </span>
            <div className="amt-input filled over">
              <span className="prefix">$</span>
              <span className="value">14.27</span>
              <span className="caret" />
            </div>
            <button className="remove" aria-label="Remove">
              <Icon name="x" size={14} strokeWidth={2} />
            </button>
          </div>

          <button className="fm-split-add" disabled>
            <span className="plus">
              <Icon name="plus" size={14} strokeWidth={2.2} />
            </span>
            Add category
          </button>
        </div>

        <div className="fm-split-helpers">
          <button className="fm-split-helper">Split evenly</button>
          <button className="fm-split-helper primary">
            <Icon name="refresh" size={12} strokeWidth={2} style={{ marginRight: 4, verticalAlign: -1 }} />
            Trim to $32.18
          </button>
        </div>
      </div>
    </div>
  </Phone>
);

Object.assign(window, {
  TransactionsListSplit, TransactionDetailSplit, TransactionDetailSingle,
  SplitEditor, SplitEditorImbalanced, SplitEditorOverflow,
  ChatMorningHero, ChatMidRitual, ChatDone,
  ChatSchedule, ChatBudget, ChatPlan,
  TransactionsList, TransactionDetail,
  Banks, Settings, UpgradePrompt,
  Onboarding, OnboardingTalk, OnboardingShare,
  Splash,
  SignUp, SignIn, EmailVerify,
  ForgotPassword, ResetLinkSent, ResetPassword, PasswordResetDone,
  ProfileEdit, DeleteAccount,
  AddTransaction,
  CategoryPicker, AccountDetail, BankReconnect, PlaidErrorToast,
  WorkspaceSettings, MemberInvite, WorkspaceSwitcher,
  SubscriptionManage, TrialExpiredLock,
  MorningBriefSettings, PushPermissionPrompt, DataExportSheet,
  ChatWithBudgetContext, TransactionsWithBankError,
  BudgetContextBanner, BankErrorBanner,
  ChatThreadList, PushNotificationsLockScreen, HomeTrialExpiring,
  TransactionsEmpty, BanksEmpty, ChatsEmpty, HomeEmpty, AnalysisEmpty,
  ChatAnomaly, AnomalyDetail, TransactionsFlagged,
  ReceiptCapture, ReceiptProcessing, ReceiptParsed, ReceiptSaved,
  GoalsList, GoalCreate, GoalDetail, GoalGlance, HomeWithGoals, ChatPlanWithSave,
  DateRangePicker,
  ActivityTrialExpiring, ChatTrialExpiring, BanksTrialExpiring,
  SignOutConfirm,
  GoalsLocked, BanksLiteAtLimit,
  NotificationSettings,
});
