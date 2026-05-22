// home-analysis.jsx — Home + Analysis tab screens.

// ============================================================
// HOME — the new main tab
// ============================================================
const Home = ({ dark, tier = 'pro' }) => {
  const hasBrief = true; // toggle for "no new brief" empty state later
  return (
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
        {/* Net worth / month spend hero — quiet editorial value */}
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

        {/* AI brief card — the deep-link to Chat. Quiet with a small Fina cue. */}
        {hasBrief && (
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
        )}

        {/* Schedule deep-link */}
        <button className="fm-home-upcoming" aria-label="View schedule">
          <span className="fm-home-upcoming-glyph">
            <Icon name="calendar" size={16} strokeWidth={1.8} />
          </span>
          <span className="fm-home-upcoming-body">
            <span className="fm-home-upcoming-title">
              <span>Upcoming this month</span>
              <span className="amt">−$2,184.98</span>
            </span>
            <span className="fm-home-upcoming-meta">6 scheduled · Health Sat · Housing May 31</span>
          </span>
          <Icon name="chevRight" size={14} color="var(--color-muted-soft)" />
        </button>

        {/* Section: This month at a glance */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 12 }}>This month</div>
        <div className="fm-glance-grid">
          <div className="fm-glance-card">
            <div className="fm-glance-label">Spent</div>
            <div className="fm-glance-value">$1,847.20</div>
            <div className="fm-glance-trend down">
              <Icon name="trendUp" size={12} strokeWidth={2} /> 12% vs Apr
            </div>
          </div>
          <div className="fm-glance-card">
            <div className="fm-glance-label">Income</div>
            <div className="fm-glance-value" style={{ color: 'var(--color-up)' }}>+$2,840.00</div>
            <div className="fm-glance-trend">
              <span style={{ color: 'var(--color-muted)' }}>1 deposit · May 10</span>
            </div>
          </div>
        </div>

        {/* Top categories — compact rows */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 20, display: 'flex', justifyContent: 'space-between', paddingRight: 24 }}>
          <span>Top categories</span>
          <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>See analysis →</span>
        </div>
        <div className="fm-home-cat-list">
          <CatRow icon="cart" name="Groceries" amount="$642.18" pct={62} budget="$1,040" />
          <CatRow icon="utensils" name="Dining" amount="$284.20" pct={94} budget="$300" over />
          <CatRow icon="fuel" name="Transport" amount="$210.50" pct={42} budget="$500" />
          <CatRow icon="film" name="Subscriptions" amount="$67.97" pct={68} budget="$100" />
        </div>

        {/* Recent activity peek */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 24, display: 'flex', justifyContent: 'space-between', paddingRight: 24 }}>
          <span>Recent activity</span>
          <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>See all →</span>
        </div>
        <div style={{ background: dark ? 'transparent' : 'var(--color-canvas)' }}>
          <TxRow icon="coffee" name="Blue Bottle Coffee" cat="Coffee & dining" amount="−$8.40" time="10:24" />
          <TxRow icon="cart" name="Whole Foods" cat="Groceries" amount="−$23.00" time="08:11" />
          <TxRow icon="cart" name="Costco Wholesale" cat={null} amount="−$87.43" time="Yesterday" pending />
        </div>

        <div style={{ height: 24 }} />
      </div>

      <TabBar active="home" badges={{ tx: 2 }} />
    </Phone>
  );
};

const CatRow = ({ icon, name, amount, pct, budget, over = false }) => (
  <div className="fm-catrow">
    <div className="fm-cat-glyph" style={{ width: 36, height: 36, fontSize: 16 }}>
      <Icon name={icon} size={16} />
    </div>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="fm-catrow-top">
        <span className="fm-catrow-name">{name}</span>
        <span className={`fm-catrow-amt${over ? ' over' : ''}`}>{amount}</span>
      </div>
      <div className="fm-catrow-bar">
        <span style={{ width: `${Math.min(pct, 100)}%`, background: over ? 'var(--color-down)' : 'var(--color-primary)' }} />
      </div>
      <div className="fm-catrow-meta">
        <span>{pct}% of {budget}</span>
        {over && <span style={{ color: 'var(--color-down)', fontWeight: 600 }}>Over</span>}
      </div>
    </div>
  </div>
);

// ============================================================
// ANALYSIS — the new tab
// ============================================================
const Analysis = ({ dark }) => (
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
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      {/* Period stepper — month nav + M/Q/Y unit toggle */}
      <div className="fm-period-bar">
        <button className="fm-period-step" aria-label="Previous period">
          <Icon name="chevLeft" size={18} strokeWidth={2.2} />
        </button>
        <button className="fm-period-label">
          <span>May 2025</span>
          <Icon name="chevDown" size={13} strokeWidth={2.4} />
        </button>
        <button className="fm-period-step" aria-label="Next period">
          <Icon name="chevRight" size={18} strokeWidth={2.2} />
        </button>
        <div className="fm-period-mqy">
          <button className="active">M</button>
          <button>Q</button>
          <button>Y</button>
        </div>
      </div>

      {/* Cashflow chart */}
      <div className="fm-analysis-card">
        <div className="fm-analysis-head">
          <div>
            <div className="fm-stat-label">Net cashflow</div>
            <div className="fm-analysis-value">+$992.80</div>
            <div className="fm-hero-meta" style={{ marginTop: 4 }}>
              <span><span style={{ color: 'var(--color-up)' }}>+$2,840.00</span> income</span>
              <span className="fm-hero-meta-dot" />
              <span><span style={{ color: 'var(--color-down)' }}>−$1,847.20</span> spend</span>
            </div>
          </div>
        </div>
        <CashflowChart />
      </div>

      {/* Category breakdown */}
      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>Where it went</div>
      <div className="fm-analysis-card">
        <DonutChart
          segments={[
            { label: 'Groceries', value: 642.18, color: '#7dd8b8' },
            { label: 'Dining', value: 284.20, color: '#e6b85c' },
            { label: 'Transport', value: 210.50, color: '#1f8a5b' },
            { label: 'Subscriptions', value: 67.97, color: '#cf202f' },
            { label: 'Other', value: 642.35, color: '#a8acb3' },
          ]}
        />
      </div>

      {/* Vs last month */}
      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>vs April</div>
      <div className="fm-analysis-card">
        <CompareRow name="Groceries" current="$642.18" delta={48.20} pct={8} />
        <CompareRow name="Dining" current="$284.20" delta={92.40} pct={48} over />
        <CompareRow name="Transport" current="$210.50" delta={-42.10} pct={-17} />
        <CompareRow name="Subscriptions" current="$67.97" delta={0} pct={0} flat />
      </div>

      {/* AI insight */}
      <div className="fm-insight-card">
        <div style={{ flex: 1 }}>
          <div className="fm-brief-eyebrow" style={{ marginBottom: 8 }}>
            <span className="fm-brief-dot" />
            Fina · Insight
          </div>
          <div className="fm-insight-title">Dining is trending high</div>
          <div className="fm-insight-body">
            You&apos;ve spent <strong>$92 more on dining</strong> than last month with 19 days left. Want a $50 weekly cap?
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="fm-btn primary" style={{ padding: '8px 14px', fontSize: 14 }}>Set cap</button>
            <button className="fm-btn" style={{ padding: '8px 14px', fontSize: 14 }}>Maybe later</button>
          </div>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
  </Phone>
);

const CompareRow = ({ name, current, delta, pct, over = false, flat = false }) => (
  <button className="fm-compare-row">
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 600 }}>{name}</div>
      <div style={{ font: 'var(--type-caption)', fontFamily: 'var(--font-mono)', color: 'var(--color-muted)', marginTop: 2 }}>
        {current}
      </div>
    </div>
    <div className={`fm-compare-delta${over ? ' over' : flat ? ' flat' : delta < 0 ? ' down' : ''}`}>
      {!flat && (
        <Icon name={delta > 0 ? 'trendUp' : 'trendDown'} size={12} strokeWidth={2} />
      )}
      {flat ? 'no change' : `${pct > 0 ? '+' : ''}${pct}%`}
    </div>
    <span className="fm-compare-chev">
      <Icon name="chevRight" size={14} strokeWidth={2} />
    </span>
  </button>
);

// ============================================================
// ANALYSIS · Year view — Y toggle active
// Same surface, different period: full year cashflow, year-to-date donut,
// "vs last year" compare, year-in-review insight.
// ============================================================
const AnalysisYear = ({ dark }) => (
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
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div className="fm-period-bar">
        <button className="fm-period-step" aria-label="Previous year">
          <Icon name="chevLeft" size={18} strokeWidth={2.2} />
        </button>
        <button className="fm-period-label">
          <span>2025</span>
          <Icon name="chevDown" size={13} strokeWidth={2.4} />
        </button>
        <button className="fm-period-step" aria-label="Next year">
          <Icon name="chevRight" size={18} strokeWidth={2.2} />
        </button>
        <div className="fm-period-mqy">
          <button>M</button>
          <button>Q</button>
          <button className="active">Y</button>
        </div>
      </div>

      {/* Year hero — net cashflow */}
      <div className="fm-analysis-card">
        <div className="fm-analysis-head">
          <div>
            <div className="fm-stat-label">Net cashflow · year-to-date</div>
            <div className="fm-analysis-value">+$12,440</div>
            <div className="fm-hero-meta" style={{ marginTop: 4 }}>
              <span><span style={{ color: 'var(--color-up)' }}>+$31,240</span> income</span>
              <span className="fm-hero-meta-dot" />
              <span><span style={{ color: 'var(--color-down)' }}>−$18,800</span> spend</span>
            </div>
          </div>
        </div>
        <CashflowChart months={12} currentIndex={11} />
      </div>

      {/* Category breakdown — year totals */}
      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>Where it went · this year</div>
      <div className="fm-analysis-card">
        <DonutChart
          segments={[
            { label: 'Groceries', value: 7280, color: '#7dd8b8' },
            { label: 'Dining', value: 3120, color: '#e6b85c' },
            { label: 'Transport', value: 2210, color: '#1f8a5b' },
            { label: 'Subscriptions', value: 820, color: '#cf202f' },
            { label: 'Other', value: 5370, color: '#a8acb3' },
          ]}
        />
      </div>

      {/* Vs last year */}
      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>vs 2024</div>
      <div className="fm-analysis-card">
        <CompareRow name="Groceries" current="$7,280" delta={920} pct={14} />
        <CompareRow name="Dining" current="$3,120" delta={620} pct={25} over />
        <CompareRow name="Transport" current="$2,210" delta={-420} pct={-16} />
        <CompareRow name="Subscriptions" current="$820" delta={120} pct={17} />
      </div>

      {/* Year-in-review insight */}
      <div className="fm-insight-card">
        <div style={{ flex: 1 }}>
          <div className="fm-brief-eyebrow" style={{ marginBottom: 8 }}>
            <span className="fm-brief-dot" />
            Fina · Year in review
          </div>
          <div className="fm-insight-title">Your strongest saving year yet</div>
          <div className="fm-insight-body">
            You set aside <strong>$12,440</strong> — up 28% from last year.
            Biggest swing: dining grew 25%, but groceries stayed in check.
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="fm-btn primary" style={{ padding: '8px 14px', fontSize: 14 }}>See full review</button>
            <button className="fm-btn" style={{ padding: '8px 14px', fontSize: 14 }}>Share</button>
          </div>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
  </Phone>
);

// ============================================================
// ANALYSIS · Past month — period stepper to April 2025
// Layout matches default Analysis but with April data + "Looking back" tag
// + "vs March" compare.
// ============================================================
const AnalysisPastMonth = ({ dark }) => (
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
    <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
      <div className="fm-period-bar">
        <button className="fm-period-step" aria-label="Previous month">
          <Icon name="chevLeft" size={18} strokeWidth={2.2} />
        </button>
        <button className="fm-period-label">
          <span className="fm-period-tag">Looking back</span>
          April 2025
          <Icon name="chevDown" size={13} strokeWidth={2.4} />
        </button>
        <button className="fm-period-step" aria-label="Next month">
          <Icon name="chevRight" size={18} strokeWidth={2.2} />
        </button>
        <div className="fm-period-mqy">
          <button className="active">M</button>
          <button>Q</button>
          <button>Y</button>
        </div>
      </div>

      <div className="fm-analysis-card">
        <div className="fm-analysis-head">
          <div>
            <div className="fm-stat-label">Net cashflow · April</div>
            <div className="fm-analysis-value">+$1,042.00</div>
            <div className="fm-hero-meta" style={{ marginTop: 4 }}>
              <span><span style={{ color: 'var(--color-up)' }}>+$2,840.00</span> income</span>
              <span className="fm-hero-meta-dot" />
              <span><span style={{ color: 'var(--color-down)' }}>−$1,798.00</span> spend</span>
            </div>
          </div>
        </div>
        <CashflowChart currentIndex={3} />
      </div>

      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>Where it went · April</div>
      <div className="fm-analysis-card">
        <DonutChart
          segments={[
            { label: 'Groceries', value: 593.98, color: '#7dd8b8' },
            { label: 'Dining', value: 191.80, color: '#e6b85c' },
            { label: 'Transport', value: 252.60, color: '#1f8a5b' },
            { label: 'Subscriptions', value: 67.97, color: '#cf202f' },
            { label: 'Other', value: 691.65, color: '#a8acb3' },
          ]}
        />
      </div>

      <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>vs March</div>
      <div className="fm-analysis-card">
        <CompareRow name="Groceries" current="$593.98" delta={28.40} pct={5} />
        <CompareRow name="Dining" current="$191.80" delta={-12.10} pct={-6} />
        <CompareRow name="Transport" current="$252.60" delta={42.20} pct={20} />
        <CompareRow name="Subscriptions" current="$67.97" delta={0} pct={0} flat />
      </div>

      {/* Past-month AI insight */}
      <div className="fm-insight-card">
        <div style={{ flex: 1 }}>
          <div className="fm-brief-eyebrow" style={{ marginBottom: 8 }}>
            <span className="fm-brief-dot" />
            Fina · Looking back
          </div>
          <div className="fm-insight-title">April was a calm month</div>
          <div className="fm-insight-body">
            $1,042 saved — your best month this year. Transport ran high (gas + spring trips),
            otherwise mostly within budget.
          </div>
        </div>
      </div>

      <div style={{ height: 24 }} />
    </div>
  </Phone>
);

// ============================================================
// ANALYSIS · Category history — drill-in via donut/compare row tap
// One category, 12-month trend, top merchants, same-month-last-year.
// ============================================================
const AnalysisCategory = ({ dark }) => {
  const monthly = [
    { m: 'Jun', v: 268 }, { m: 'Jul', v: 312 }, { m: 'Aug', v: 248 },
    { m: 'Sep', v: 290 }, { m: 'Oct', v: 224 }, { m: 'Nov', v: 196 },
    { m: 'Dec', v: 410 }, { m: 'Jan', v: 312 }, { m: 'Feb', v: 268 },
    { m: 'Mar', v: 203 }, { m: 'Apr', v: 191 }, { m: 'May', v: 284 },
  ];
  const max = 410;
  return (
    <Phone dark={dark}>
      <div className="fm-nav-bar">
        <button className="fm-nav-back" aria-label="Back">
          <Icon name="chevLeft" size={22} strokeWidth={1.8} />
        </button>
        <div className="fm-nav-title">Dining</div>
        <div className="fm-nav-spacer" />
        <button className="fm-chathead-btn" aria-label="More">
          <Icon name="more" size={20} strokeWidth={1.8} />
        </button>
      </div>

      <div className="fm-content" style={{ paddingTop: 56, paddingBottom: 24 }}>
        {/* Category hero */}
        <div className="fm-cathist-hero">
          <span className="fm-cathist-pill" style={{ background: 'rgba(230, 184, 92,0.16)', color: '#a87600' }}>
            <Icon name="utensils" size={12} strokeWidth={2} />
            Dining
          </span>
          <div className="fm-cathist-amount">$284.20</div>
          <div className="fm-cathist-sub">
            <span>May 2025</span>
            <span className="dot" />
            <span style={{ color: 'var(--color-down)', fontWeight: 600 }}>+48% vs avg</span>
          </div>
        </div>

        {/* 12-month trend */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 6 }}>Last 12 months</div>
        <div className="fm-analysis-card">
          <svg viewBox="0 0 320 160" style={{ width: '100%', height: 160 }}>
            <line x1="18" y1="130" x2="302" y2="130" stroke="var(--color-hairline)" strokeWidth="1" />
            {/* avg line */}
            <line x1="18" y1={130 - (268 / max) * 100} x2="302" y2={130 - (268 / max) * 100}
              stroke="var(--color-muted-soft)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
            <text x="302" y={130 - (268 / max) * 100 - 4} textAnchor="end"
              fontFamily="var(--font-mono)" fontSize="9" fill="var(--color-muted)">
              avg $268
            </text>
            {monthly.map((d, i) => {
              const cellW = 284 / 12;
              const cx = 18 + cellW * i + cellW / 2;
              const h = (d.v / max) * 100;
              const isCurrent = i === monthly.length - 1;
              return (
                <g key={i}>
                  <rect x={cx - 9} y={130 - h} width={18} height={h}
                    fill={isCurrent ? '#a87600' : 'rgba(230, 184, 92,0.4)'} rx="2" />
                  <text x={cx} y={148} textAnchor="middle"
                    fill={isCurrent ? 'var(--color-ink)' : 'var(--color-muted)'}
                    fontFamily="var(--font-mono)" fontSize="9"
                    fontWeight={isCurrent ? 600 : 400}>
                    {d.m}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Quick stats */}
        <div className="fm-cathist-stats">
          <div className="fm-cathist-stat">
            <div className="lbl">12-mo avg</div>
            <div className="val">$268</div>
          </div>
          <div className="fm-cathist-stat">
            <div className="lbl">Peak</div>
            <div className="val">$410<span className="meta">Dec</span></div>
          </div>
          <div className="fm-cathist-stat">
            <div className="lbl">Low</div>
            <div className="val">$191<span className="meta">Apr</span></div>
          </div>
        </div>

        {/* Same month last year */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>vs May 2024</div>
        <div className="fm-analysis-card">
          <div className="fm-yoy-row">
            <div className="fm-yoy-bar">
              <div className="fm-yoy-bar-label">
                <span className="lbl">May 2025</span>
                <span className="val">$284</span>
              </div>
              <div className="fm-yoy-bar-track">
                <div className="fill current" style={{ width: '92%' }} />
              </div>
            </div>
            <div className="fm-yoy-bar">
              <div className="fm-yoy-bar-label">
                <span className="lbl">May 2024</span>
                <span className="val">$210</span>
              </div>
              <div className="fm-yoy-bar-track">
                <div className="fill" style={{ width: '68%' }} />
              </div>
            </div>
            <div className="fm-yoy-delta">
              <Icon name="trendUp" size={13} strokeWidth={2} />
              <strong>+$74 (35%)</strong>
            </div>
          </div>
        </div>

        {/* Top merchants in this category */}
        <div className="fm-section-eyebrow" style={{ paddingTop: 18 }}>Top spots · this month</div>
        <div className="fm-analysis-card" style={{ padding: '4px 0' }}>
          <div className="fm-cathist-merch">
            <div className="fm-cat-glyph" style={{ width: 32, height: 32 }}>
              <Icon name="coffee" size={14} />
            </div>
            <div className="body">
              <div className="name">Blue Bottle Coffee</div>
              <div className="meta">12 visits · avg $8.40</div>
            </div>
            <div className="amt">$100.80</div>
          </div>
          <div className="fm-cathist-merch">
            <div className="fm-cat-glyph" style={{ width: 32, height: 32 }}>
              <Icon name="utensils" size={14} />
            </div>
            <div className="body">
              <div className="name">Joe's Pizza</div>
              <div className="meta">3 visits · avg $28.50</div>
            </div>
            <div className="amt">$85.50</div>
          </div>
          <div className="fm-cathist-merch">
            <div className="fm-cat-glyph" style={{ width: 32, height: 32 }}>
              <Icon name="utensils" size={14} />
            </div>
            <div className="body">
              <div className="name">Sushi Yoshi</div>
              <div className="meta">1 visit · $97.90</div>
            </div>
            <div className="amt">$97.90</div>
          </div>
        </div>

        <div style={{ height: 24 }} />
      </div>
    </Phone>
  );
};

// ──────────────────────────────────────────────
// Mini SVG cashflow bar chart
// 'months': 5 (default) or 12. 'data' overrides the default series.
// ──────────────────────────────────────────────
const CashflowChart = ({ data, months = 5, currentIndex }) => {
  const D5 = [
    { m: 'Jan', in: 2840, out: 1620 },
    { m: 'Feb', in: 2840, out: 1980 },
    { m: 'Mar', in: 2840, out: 1750 },
    { m: 'Apr', in: 2840, out: 1798 },
    { m: 'May', in: 2840, out: 1847 },
  ];
  const D12 = [
    { m: 'Jun', in: 2840, out: 1620 },
    { m: 'Jul', in: 2840, out: 1880 },
    { m: 'Aug', in: 2840, out: 2010 },
    { m: 'Sep', in: 2840, out: 1750 },
    { m: 'Oct', in: 2840, out: 1492 },
    { m: 'Nov', in: 2840, out: 1798 },
    { m: 'Dec', in: 2980, out: 2210 },
    { m: 'Jan', in: 2840, out: 1620 },
    { m: 'Feb', in: 2840, out: 1980 },
    { m: 'Mar', in: 2840, out: 1750 },
    { m: 'Apr', in: 2840, out: 1798 },
    { m: 'May', in: 2840, out: 1847 },
  ];
  const series = data || (months === 12 ? D12 : D5);
  const ci = currentIndex !== undefined ? currentIndex : series.length - 1;
  const max = Math.max(...series.flatMap(d => [d.in, d.out]));
  const W = 320, H = 160, pad = 18;
  const isYear = series.length >= 10;
  const barW = isYear ? 7 : 12;
  const gap = isYear ? 3 : 6;
  const groupW = barW * 2 + gap;
  const cellW = (W - pad * 2) / series.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 160, marginTop: 4 }}>
      <line x1={pad} y1={H - 30} x2={W - pad} y2={H - 30} stroke="var(--color-hairline)" strokeWidth="1" />
      {series.map((d, i) => {
        const cx = pad + cellW * i + cellW / 2 - groupW / 2;
        const inH = (d.in / max) * (H - 60);
        const outH = (d.out / max) * (H - 60);
        const current = i === ci;
        return (
          <g key={i}>
            <rect x={cx} y={H - 30 - inH} width={barW} height={inH}
              fill={current ? 'var(--color-up)' : 'rgba(31, 138, 91,0.4)'} rx="2" />
            <rect x={cx + barW + gap} y={H - 30 - outH} width={barW} height={outH}
              fill={current ? 'var(--color-down)' : 'rgba(207,32,47,0.4)'} rx="2" />
            <text x={cx + groupW / 2} y={H - 12} textAnchor="middle"
              fill={current ? 'var(--color-ink)' : 'var(--color-muted)'}
              fontFamily="var(--font-mono)" fontSize={isYear ? 9 : 11}
              fontWeight={current ? 600 : 400}>
              {d.m}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ──────────────────────────────────────────────
// Mini SVG donut + legend
// ──────────────────────────────────────────────
const DonutChart = ({ segments }) => {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const cx = 80, cy = 80, r = 60, sw = 18;
  let acc = 0;
  const C = 2 * Math.PI * r;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
      <svg viewBox="0 0 160 160" width="140" height="140" style={{ flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--color-surface-strong)" strokeWidth={sw} />
        {segments.map((s, i) => {
          const len = (s.value / total) * C;
          const dash = `${len} ${C - len}`;
          const offset = -acc;
          acc += len;
          return (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none"
              stroke={s.color} strokeWidth={sw}
              strokeDasharray={dash} strokeDashoffset={offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle"
          fontFamily="var(--font-mono)" fontSize="11"
          fill="var(--color-muted)" letterSpacing="0.5"
          style={{ textTransform: 'uppercase' }}>
          Spent
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle"
          fontFamily="var(--font-sans)" fontWeight="600" fontSize="20"
          fill="var(--color-ink)" letterSpacing="-0.4"
          style={{ fontVariantNumeric: 'tabular-nums lining-nums' }}>
          $1,847
        </text>
      </svg>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {segments.map((s, i) => (
          <button key={i} className="fm-donut-legend-row">
            <span style={{
              width: 8, height: 8, borderRadius: 999, background: s.color, flexShrink: 0,
            }} />
            <span className="name">{s.label}</span>
            <span className="amt">${s.value.toFixed(0)}</span>
            <Icon name="chevRight" size={12} strokeWidth={2} color="var(--color-muted-soft)" />
          </button>
        ))}
      </div>
    </div>
  );
};

Object.assign(window, { Home, Analysis, AnalysisYear, AnalysisPastMonth, AnalysisCategory });
