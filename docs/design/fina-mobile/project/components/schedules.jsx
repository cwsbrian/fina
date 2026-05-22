// schedules.jsx — Schedule & Subscriptions surfaces + Activity-with-schedule variants

// ─────────────────────────────────────────────────────────
// Small inline subscription badge — used on Activity / Schedule rows
// ─────────────────────────────────────────────────────────
const SubBadge = ({ size = 'sm' }) => (
  <span className={`fm-sub-badge${size === 'md' ? ' md' : ''}`} aria-label="Subscription">
    <Icon name="repeat" size={size === 'md' ? 11 : 10} strokeWidth={2.2} />
  </span>
);

// ─────────────────────────────────────────────────────────
// Scheduled row — used inside Schedules screen
// Category is the PRIMARY label (merchant is unknowable for future items).
// `note` is an optional secondary descriptor.
// ─────────────────────────────────────────────────────────
const SchedRow = ({ icon, cat, date, amount, isSubscription, note }) => (
  <div className="fm-tx-row fm-sched-row">
    <div className="fm-cat-glyph" style={{ width: 36, height: 36 }}>
      <Icon name={icon} size={16} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="fm-tx-name">
        {cat}
        {isSubscription && <SubBadge />}
      </div>
      {note && <div className="fm-tx-cat">{note}</div>}
    </div>
    <div className="fm-tx-amount">
      <div className="amt">{amount}</div>
      <div className="time">{date}</div>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────
// Subscription row — used inside Subscriptions tab/screen
// `freq` is the actual billing cadence shown to the user.
// `monthlyEq` is the amortized monthly cost (annual÷12, weekly×52÷12, etc.)
// — shown only when freq is not already monthly, so the total math is honest.
// ─────────────────────────────────────────────────────────
const SubRow = ({ icon, iconBg, name, cat, freq, nextOn, since, amount, perLabel = '/mo', monthlyEq }) => (
  <div className="fm-recur-row">
    <div className="fm-cat-glyph" style={{ width: 40, height: 40, background: iconBg || 'var(--color-surface-strong)' }}>
      <Icon name={icon} size={18} />
    </div>
    <div className="fm-recur-body">
      <div className="fm-recur-top">
        <span className="fm-recur-name">{name}</span>
        <span className="fm-recur-amt">{amount}<span className="per">{perLabel}</span></span>
      </div>
      <div className="fm-recur-meta">
        <span>{cat}</span>
        <span className="dot" />
        <span>{freq}</span>
        {monthlyEq && <>
          <span className="dot" />
          <span style={{ color: 'var(--color-muted)' }}>≈ {monthlyEq}/mo</span>
        </>}
      </div>
      <div className="fm-recur-meta soft">
        <span>Next {nextOn}</span>
        <span className="dot" />
        <span>Since {since}</span>
      </div>
    </div>
    <Icon name="chevRight" size={14} color="var(--color-muted-soft)" />
  </div>
);

// ─────────────────────────────────────────────────────────
// Schedule list — content of the "Schedule" tab
// ─────────────────────────────────────────────────────────
const ScheduleListContent = () => (
  <>
    {/* Next 7 days hero */}
    <div className="fm-sched-hero">
      <div className="fm-stat-label">This month</div>
      <div className="fm-sched-hero-value">$2,184.98</div>
      <div className="fm-hero-meta">
        <span>6 scheduled items</span>
        <span className="fm-hero-meta-dot" />
        <span style={{ color: 'var(--color-muted)' }}>Pulls from budget</span>
      </div>
    </div>

    <div className="fm-section-eyebrow" style={{ paddingTop: 14 }}>This week</div>
    <SchedRow icon="heart" cat="Health" date="Sat May 17" amount="−$50.00" note="Dentist cleaning" />
    <SchedRow icon="cart" cat="Groceries" date="Sun May 18" amount="−$120.00" note="Costco · estimate" />
    <SchedRow icon="plane" cat="Transport" date="Sun May 18" amount="−$180.00" note="Train · Toronto" />

    <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>Later this month</div>
    <SchedRow icon="film" cat="Streaming" date="May 25" amount="−$22.99" isSubscription note="Netflix" />
    <SchedRow icon="heart" cat="Music" date="May 28" amount="−$11.99" isSubscription note="Spotify" />
    <SchedRow icon="home" cat="Housing" date="May 31" amount="−$1,800.00" isSubscription note="Rent · May" />

    <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>Next month</div>
    <SchedRow icon="settings" cat="Cloud storage" date="Jun 2" amount="−$2.99" isSubscription note="iCloud+" />
    <SchedRow icon="edit" cat="Software" date="Aug 14" amount="−$59.99" isSubscription note="Adobe CC · annual" />

    <button className="fm-sched-add">
      <Icon name="calendarPlus" size={16} strokeWidth={1.8} />
      Schedule something
    </button>

    <button className="fm-recur-link">
      <Icon name="repeat" size={14} strokeWidth={2} />
      <span>View all subscriptions</span>
      <span className="meta">4 active · $42.97/mo</span>
      <Icon name="chevRight" size={14} color="var(--color-muted-soft)" />
    </button>
  </>
);

// ─────────────────────────────────────────────────────────
// Subscriptions list — content of the "Subscriptions" tab
// ─────────────────────────────────────────────────────────
const SubscriptionsListContent = () => (
  <>
    {/* Monthly average card — all frequencies normalized to monthly */}
    <div className="fm-sched-hero">
      <div className="fm-stat-label">Monthly average</div>
      <div className="fm-sched-hero-value">$42.97<span className="per">/mo</span></div>
      <div className="fm-hero-meta">
        <span>4 active subscriptions</span>
        <span className="fm-hero-meta-dot" />
        <span>$515.64 / year</span>
      </div>
      <div className="fm-hero-axis" style={{ marginTop: 8 }}>
        Annual &amp; weekly subs are amortized to monthly
      </div>
    </div>

    <div className="fm-section-eyebrow" style={{ paddingTop: 14 }}>Active · 4</div>
    <div className="fm-recur-list">
      <SubRow icon="film" iconBg="rgba(207,32,47,0.12)" name="Netflix"
        cat="Streaming" freq="Monthly" nextOn="May 25" since="Mar 2023" amount="$22.99" />
      <SubRow icon="heart" iconBg="rgba(31, 138, 91,0.12)" name="Spotify"
        cat="Music" freq="Monthly" nextOn="May 28" since="Aug 2024" amount="$11.99" />
      <SubRow icon="settings" iconBg="rgba(168,172,179,0.18)" name="iCloud+ 200GB"
        cat="Cloud storage" freq="Monthly" nextOn="Jun 2" since="Jul 2021" amount="$2.99" />
      <SubRow icon="edit" iconBg="rgba(230, 184, 92,0.16)" name="Adobe Creative Cloud"
        cat="Software" freq="Annual" nextOn="Aug 14" since="Aug 2023" amount="$59.99" perLabel="/yr" monthlyEq="$5.00" />
    </div>

    <button className="fm-sched-add">
      <Icon name="repeat" size={14} strokeWidth={2} />
      Add a subscription
    </button>
  </>
);

// ─────────────────────────────────────────────────────────
// SUBSCRIPTIONS — standalone surface (Option B variant)
// Same content as the Subscriptions tab, dedicated screen.
// ─────────────────────────────────────────────────────────
const SubscriptionsScreen = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Subscriptions</div>
      <div className="fm-nav-spacer" />
      <button className="fm-nav-back" aria-label="Add subscription" style={{ marginRight: -4 }}>
        <Icon name="plus" size={20} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <SubscriptionsListContent />
      <div style={{ height: 24 }} />
    </div>
  </Phone>
);

// ─────────────────────────────────────────────────────────
// SCHEDULE-ONLY — standalone variant (no Subscriptions tab)
// For the "two separate screens" option.
// ─────────────────────────────────────────────────────────
const ScheduleScreen = ({ dark }) => (
  <Phone dark={dark}>
    <div className="fm-nav-bar">
      <button className="fm-nav-back" aria-label="Back">
        <Icon name="chevLeft" size={22} strokeWidth={1.8} />
      </button>
      <div className="fm-nav-title">Schedule</div>
      <div className="fm-nav-spacer" />
      <button className="fm-nav-back" aria-label="Add scheduled item" style={{ marginRight: -4 }}>
        <Icon name="plus" size={20} strokeWidth={1.8} />
      </button>
    </div>
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <ScheduleListContent />
      <div style={{ height: 24 }} />
    </div>
  </Phone>
);

// ─────────────────────────────────────────────────────────
// Reusable TxRow with subscription support (drop-in for variants)
// ─────────────────────────────────────────────────────────
const TxRowWithSub = ({ icon, name, cat, amount, time, pending = false, income = false, isSubscription = false, scheduled = false, note = null }) => (
  <div className={`fm-tx-row${scheduled ? ' scheduled' : ''}`}>
    <div className="fm-cat-glyph" style={{ width: 36, height: 36, fontSize: 16 }}>
      <Icon name={icon} size={16} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="fm-tx-name">
        {scheduled ? (cat || 'Uncategorized') : name}
        {pending && <span className="fm-tx-badge">Pending</span>}
        {scheduled && <span className="fm-tx-badge sched"><Icon name="calendar" size={9} strokeWidth={2.4} /> Scheduled</span>}
        {isSubscription && <SubBadge />}
      </div>
      <div className={`fm-tx-cat${!cat && !scheduled ? ' uncat' : ''}`}>
        {scheduled ? (note || name) : (cat || 'Uncategorized')}
      </div>
    </div>
    <div className="fm-tx-amount">
      <div className={`amt${income ? ' up' : ''}${scheduled ? ' soft' : ''}`}>{amount}</div>
      <div className="time">{time}</div>
    </div>
  </div>
);

// ═════════════════════════════════════════════════════════
// ACTIVITY VARIANTS — three options for how schedules appear
// ═════════════════════════════════════════════════════════

// Variant A — "Upcoming this month" pinned card at top, then normal history
const ActivityWithSchedulesA = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      {/* Upcoming pinned card — minimal: total only, links to schedule detail */}
      <button className="fm-upcoming-card-mini" aria-label="See all scheduled items">
        <div className="fm-upcoming-mini-head">
          <span className="fm-stat-label">Upcoming this month</span>
          <span className="fm-upcoming-see">See all <Icon name="chevRight" size={12} strokeWidth={2.2} /></span>
        </div>
        <div className="fm-upcoming-mini-amount">
          <span className="big">−$2,184.98</span>
          <span className="meta">· 6 items</span>
        </div>
        <div className="fm-upcoming-mini-icons">
          <span><Icon name="heart" size={11} strokeWidth={2} /></span>
          <span><Icon name="cart" size={11} strokeWidth={2} /></span>
          <span><Icon name="plane" size={11} strokeWidth={2} /></span>
          <span className="sub-marker"><Icon name="film" size={11} strokeWidth={2} /><SubBadge /></span>
        </div>
      </button>

      <div className="fm-tx-day">
        <span>Today · May 12</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
      </div>
      <TxRowWithSub icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
      <TxRowWithSub icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$146.03</span>
      </div>
      <TxRowWithSub icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="21:12" pending />
      <TxRowWithSub icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="16:38" />

      <div className="fm-tx-day">
        <span>May 10</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>+$2,817.01</span>
      </div>
      <TxRowWithSub icon="home" name="Payroll · Stripe Inc." cat="Income" amount="+$2,840.00" time="09:00" income />
      <TxRowWithSub icon="film" name="Netflix" cat="Streaming" amount="−$22.99" time="00:01" isSubscription />

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

// Variant B — Schedules inline by date, with future-date headers and muted styling
const ActivityWithSchedulesB = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      {/* Future scheduled items — muted / dashed */}
      <div className="fm-tx-day future">
        <span>Sat May 17 · upcoming</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>−$50.00</span>
      </div>
      <TxRowWithSub icon="heart" name="Dentist · cleaning" cat="Health" amount="−$50.00" time="Scheduled" scheduled />

      <div className="fm-tx-day future">
        <span>Sun May 18 · upcoming</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>−$300.00</span>
      </div>
      <TxRowWithSub icon="cart" name="Costco run" cat="Groceries" amount="−$120.00" time="Estimate" scheduled />
      <TxRowWithSub icon="plane" name="Train · Toronto" cat="Transport" amount="−$180.00" time="Scheduled" scheduled />

      <div className="fm-tx-day future">
        <span>May 25 · upcoming</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-muted)' }}>−$22.99</span>
      </div>
      <TxRowWithSub icon="film" name="Netflix" cat="Streaming" amount="−$22.99" time="Recurs" scheduled isSubscription />

      <div className="fm-tx-divider">
        <span className="line" />
        <span className="label">Posted</span>
        <span className="line" />
      </div>

      <div className="fm-tx-day">
        <span>Today · May 12</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
      </div>
      <TxRowWithSub icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
      <TxRowWithSub icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$146.03</span>
      </div>
      <TxRowWithSub icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="21:12" pending />
      <TxRowWithSub icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="16:38" />

      <div className="fm-tx-day">
        <span>May 10</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>+$2,817.01</span>
      </div>
      <TxRowWithSub icon="home" name="Payroll · Stripe Inc." cat="Income" amount="+$2,840.00" time="09:00" income />
      <TxRowWithSub icon="film" name="Netflix" cat="Streaming" amount="−$22.99" time="00:01" isSubscription />

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

// Variant A · Mini — even smaller pinned upcoming banner (single line)
const ActivityWithSchedulesAMini = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />
    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      {/* Slim banner — single row, links to Schedule */}
      <button className="fm-upcoming-banner" aria-label="See all scheduled items">
        <span className="fm-upcoming-banner-glyph">
          <Icon name="calendar" size={13} strokeWidth={2} />
        </span>
        <span className="fm-upcoming-banner-text">
          <span className="lbl">Upcoming this month</span>
          <span className="amt">−$2,184.98</span>
          <span className="count">· 6</span>
        </span>
        <Icon name="chevRight" size={14} color="var(--color-muted-soft)" />
      </button>

      <div className="fm-tx-day">
        <span>Today · May 12</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$31.40</span>
      </div>
      <TxRowWithSub icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
      <TxRowWithSub icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />

      <div className="fm-tx-day">
        <span>Yesterday · May 11</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>−$146.03</span>
      </div>
      <TxRowWithSub icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="21:12" pending />
      <TxRowWithSub icon="fuel" name="Shell Gas Station" cat="Transport" amount="−$52.10" time="16:38" />

      <div className="fm-tx-day">
        <span>May 10</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>+$2,817.01</span>
      </div>
      <TxRowWithSub icon="home" name="Payroll · Stripe Inc." cat="Income" amount="+$2,840.00" time="09:00" income />
      <TxRowWithSub icon="film" name="Netflix" cat="Streaming" amount="−$22.99" time="00:01" isSubscription />

      <div style={{ height: 24 }} />
    </div>
    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

Object.assign(window, {
  SubscriptionsScreen, ScheduleScreen,
  ActivityWithSchedulesA, ActivityWithSchedulesAMini, ActivityWithSchedulesB,
  SubBadge,
});
