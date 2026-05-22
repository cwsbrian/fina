// screens.jsx — Each function returns a <Phone>-wrapped screen.
// All accept { dark, tier } where relevant.

// ============================================================
// 1. CHAT — Morning ritual hero (the core funnel)
// ============================================================
const ChatMorningHero = ({ dark, tier = 'pro' }) => {
  const inputLocked = tier !== 'pro';
  return (
    <Phone dark={dark}>
      <div className="fm-content" style={{ paddingBottom: inputLocked ? 100 : 180, paddingTop: 8 }}>
        <div className="fm-chat-list" style={{ paddingTop: 24 }}>
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

      <TabBar active="chat" badges={{ tx: 2 }} />
    </Phone>
  );
};

// ============================================================
// 2. CHAT — Mid-ritual (one card already confirmed)
// ============================================================
const ChatMidRitual = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-content" style={{ paddingBottom: 180, paddingTop: 8 }}>
      <div className="fm-chat-list" style={{ paddingTop: 24 }}>
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
    <TabBar active="chat" badges={{ tx: 1 }} />
  </Phone>
);

// ============================================================
// 3. CHAT — All done
// ============================================================
const ChatDone = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-content" style={{ paddingBottom: 180, paddingTop: 8 }}>
      <div className="fm-chat-list" style={{ paddingTop: 24 }}>
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
    <TabBar active="chat" />
  </Phone>
);

// ============================================================
// 3b. CHAT — schedule_form block (in context)
// ============================================================
const ChatSchedule = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-content" style={{ paddingBottom: 180, paddingTop: 8 }}>
      <div className="fm-chat-list" style={{ paddingTop: 24 }}>
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
    <TabBar active="chat" />
  </Phone>
);

// ============================================================
// 3c. CHAT — budget_edit block (in context)
// ============================================================
const ChatBudget = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-content" style={{ paddingBottom: 180, paddingTop: 8 }}>
      <div className="fm-chat-list" style={{ paddingTop: 24 }}>
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
    <TabBar active="chat" />
  </Phone>
);

// ============================================================
// 3d. CHAT — plan card + reasoning (user asks "Can we afford X?")
// ============================================================
const ChatPlan = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-content" style={{ paddingBottom: 180, paddingTop: 8 }}>
      <div className="fm-chat-list" style={{ paddingTop: 24 }}>
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
    <TabBar active="chat" />
  </Phone>
);

// ============================================================
// 4. TRANSACTIONS — list
// ============================================================
const TransactionsList = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill active">This month <Icon name="chevDown" size={12} strokeWidth={2} /></span>
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
      <Header title="Settings" dark={dark} />
      <div className="fm-content" style={{ paddingBottom: 84 }}>
        <div className="fm-profile-card">
          <div className="fm-profile-avatar">B</div>
          <div style={{ flex: 1 }}>
            <div className="fm-profile-name">Brian Choi</div>
            <div className="fm-profile-mail">cwsbrian@gmail.com</div>
            <div className={`fm-tier-pill ${tierClass}`}>{tierLabel}</div>
          </div>
        </div>

        <div className="fm-settings-group-label">Connections</div>
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

        <div className="fm-settings-group-label">Workspace</div>
        <div className="fm-settings-group">
          <SettingsRow label="Choi family" detail="2 members" />
          <SettingsRow label="Switch workspace" />
        </div>

        <div className="fm-settings-group-label">AI</div>
        <div className="fm-settings-group">
          <SettingsRow label="Morning brief time" detail="8:00 AM" />
          <SettingsRow label="Pause briefings" detail={<div className="fm-toggle" />} />
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
      <TabBar active="settings" badges={tier === 'pro' ? { settings: 'dot' } : {}} />
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
    <div className="fm-content" style={{ paddingBottom: 180, paddingTop: 8, filter: 'blur(2px) brightness(0.85)' }}>
      <div className="fm-chat-list" style={{ paddingTop: 24 }}>
        <Bubble role="ai">Morning, Brian — yesterday came to <strong>$214.83</strong>.</Bubble>
      </div>
    </div>
    <div className="fm-sheet-scrim">
      <div className="fm-sheet">
        <div className="fm-sheet-grabber" />
        <div style={{ width: 48, height: 48, borderRadius: 14, background: 'rgba(59,123,255,0.12)',
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
  'Transport':         { bg: 'rgba(59,123,255,0.12)', fg: '#2f6df0' },
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
        <div className="fm-sub-hero">
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
    <div className="fm-content" style={{ paddingBottom: 180, paddingTop: 8, filter: 'blur(4px) brightness(0.7)' }}>
      <div className="fm-chat-list" style={{ paddingTop: 24 }}>
        <Bubble role="ai">Morning, Brian — yesterday came to <strong>$214.83</strong>.</Bubble>
        <Bubble role="ai">Two need a category.</Bubble>
      </div>
    </div>
    <TabBar active="chat" badges={{}} />

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
    <div className="fm-content" style={{ paddingTop: 110, paddingBottom: 24 }}>
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
      <div className="fm-content" style={{ paddingBottom: inputLocked ? 100 : 180, paddingTop: 8 }}>
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

      <TabBar active="chat" badges={{ tx: 2 }} />
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

Object.assign(window, {
  ChatMorningHero, ChatMidRitual, ChatDone,
  ChatSchedule, ChatBudget, ChatPlan,
  TransactionsList, TransactionDetail,
  Banks, Settings, UpgradePrompt,
  Onboarding, OnboardingTalk, OnboardingShare,
  Splash,
  SignUp, SignIn, EmailVerify,
  ProfileEdit, DeleteAccount,
  AddTransaction,
  CategoryPicker, AccountDetail, BankReconnect, PlaidErrorToast,
  WorkspaceSettings, MemberInvite, WorkspaceSwitcher,
  SubscriptionManage, TrialExpiredLock,
  MorningBriefSettings, PushPermissionPrompt, DataExportSheet,
  ChatWithBudgetContext, TransactionsWithBankError,
  BudgetContextBanner, BankErrorBanner,
});
