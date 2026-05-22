// activity-analysis-entry.jsx — Four options for surfacing Analysis as a
// sub-screen entry from inside the Activity tab. All variants render the
// list view; the difference is where the "open Analysis" affordance lives.

// (B) Filter bar — Analysis button at the right end of the filter row.
const ActivityB = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar fm-filter-bar-split">
        <span className="fm-filter-pill active">This month <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span style={{ flex: 1 }} />
        <button className="fm-analysis-link-pill">
          <Icon name="chart" size={13} strokeWidth={2} />
          Analysis
          <Icon name="chevRight" size={11} strokeWidth={2.2} />
        </button>
      </div>

      <DemoTxBody />
    </div>
    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

// (C) Summary card — month context card at top of list with Analysis link.
const ActivityC = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <button className="fm-activity-summary">
        <div className="fm-activity-summary-row">
          <div className="lbl">May · 47 transactions</div>
          <div className="link">Analysis <Icon name="chevRight" size={12} strokeWidth={2.2} /></div>
        </div>
        <div className="fm-activity-summary-bottom">
          <div className="amt">$1,847<span className="dec">.20</span> <span className="ctx">spent</span></div>
          <div className="pct">68% of budget</div>
        </div>
      </button>

      <div className="fm-filter-bar">
        <span className="fm-filter-pill active">This month <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      <DemoTxBody />
    </div>
    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

// (D) Header swap — drop search, replace with Analysis chart icon.
const ActivityD = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="chart" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill active">This month <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      <DemoTxBody />
    </div>
    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

// (E) Sticky floating pill at lower right (above tab bar).
const ActivityE = ({ dark }) => (
  <Phone dark={dark}>
    <Header title="Activity" dark={dark}
      actions={<><IconBtn icon="calendar" dark={dark} /><IconBtn icon="search" dark={dark} /><IconBtn icon="plus" dark={dark} /></>} />

    <div className="fm-content" style={{ paddingBottom: 84 }}>
      <div className="fm-filter-bar">
        <span className="fm-filter-pill active">This month <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All accounts <Icon name="chevDown" size={12} strokeWidth={2} /></span>
        <span className="fm-filter-pill">All categories</span>
      </div>

      <DemoTxBody />
    </div>

    <button className="fm-analysis-floating-pill">
      <Icon name="chart" size={14} strokeWidth={2} color="#fff" />
      Analysis
    </button>
    <TabBar active="tx" badges={{ tx: 2 }} />
  </Phone>
);

// Shared transaction list body (same content across variants)
const DemoTxBody = () => (
  <>
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
    <TxRow icon="utensils" name="Joe's Pizza" cat="Coffee & dining" amount="−$28.50" time="20:14" />

    <div style={{ height: 24 }} />
  </>
);

Object.assign(window, { ActivityB, ActivityC, ActivityD, ActivityE });
